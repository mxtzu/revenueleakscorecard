/**
 * Lead sync: lead_pipeline (Python) -> CRM (Postgres).
 *
 * Input is the JSON produced by:
 *
 *   python pipeline.py --export-only --min-score 0 --format json
 *
 * Nothing in the Python pipeline changes. This reads its existing export.
 *
 * The contract, in order of importance:
 *
 *   1. IDEMPOTENT. `external_lead_id` (lead_pipeline's `leads.id`) is unique,
 *      so importing the same export twice updates rather than duplicates.
 *   2. CRM STATE IS SACRED. A re-sync writes ONLY `lead_intelligence`. It never
 *      touches pipeline_stage, owner_id, next_action, contacts, activities,
 *      opportunities, clients or payments. A lead that has reached `won` stays
 *      `won` no matter how many times it is re-scraped.
 *   3. Insert-only for CRM rows. A crm_leads row is created once, on first
 *      sight, with the default `qualified` stage.
 */

import type { CrmSupabaseClient } from './supabase';
import type { PipelineStage } from './types';

// ---------------------------------------------------------------------------
// The shape lead_pipeline exports. Everything is optional — a lead discovered
// without a website or without enrichment is normal, not an error.
// ---------------------------------------------------------------------------
export interface PipelineLeadExport {
  lead_id: string;
  company_name: string;
  trading_name?: string | null;
  legal_name?: string | null;
  niche?: string | null;
  sub_niche?: string | null;
  description?: string | null;
  website?: string | null;
  domain?: string | null;
  business_phone?: string | null;
  business_email?: string | null;
  address?: string | null;
  city?: string | null;
  postcode?: string | null;
  region?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  online_presence?: {
    google_maps_url?: string | null;
    facebook_url?: string | null;
    instagram_url?: string | null;
    linkedin_url?: string | null;
    tiktok_url?: string | null;
    youtube_url?: string | null;
  } | null;
  google?: {
    google_rating?: number | null;
    google_review_count?: number | null;
    google_category?: string | null;
    google_place_id?: string | null;
  } | null;
  company_registry?: {
    company_number?: string | null;
    incorporation_date?: string | null;
    years_in_operation?: number | null;
  } | null;
  website_analysis?: Record<string, unknown> | null;
  advertising_analysis?: (Record<string, unknown> & { status?: string | null }) | null;
  score?: (Record<string, unknown> & { band?: string | null }) | null;
  lead_score?: number | null;
  opportunities?: string[] | null;
  strengths?: string[] | null;
  lead_reason?: string | null;
  recommended_service?: string | null;
  emails?: Record<string, unknown>[] | null;
  sources?: string[] | null;
  search_locations?: string[] | null;
  date_discovered?: string | null;
  last_seen?: string | null;
  last_checked?: string | null;
}

export interface PipelineExportDocument {
  generated_at?: string;
  lead_count?: number;
  leads: PipelineLeadExport[];
}

export interface LeadIntelligenceRow {
  external_lead_id: string;
  company_name: string;
  trading_name: string | null;
  legal_name: string | null;
  niche: string | null;
  sub_niche: string | null;
  description: string | null;
  website: string | null;
  domain: string | null;
  business_phone: string | null;
  business_email: string | null;
  address: string | null;
  city: string | null;
  postcode: string | null;
  region: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  google_maps_url: string | null;
  facebook_url: string | null;
  instagram_url: string | null;
  linkedin_url: string | null;
  tiktok_url: string | null;
  youtube_url: string | null;
  google_rating: number | null;
  google_review_count: number | null;
  google_category: string | null;
  google_place_id: string | null;
  company_number: string | null;
  incorporation_date: string | null;
  years_in_operation: number | null;
  lead_score: number | null;
  score_band: string | null;
  website_quality_score: number | null;
  landing_page_quality_score: number | null;
  advertising_status: string | null;
  opportunities: string[];
  strengths: string[];
  lead_reason: string | null;
  recommended_service: string | null;
  website_analysis: Record<string, unknown> | null;
  advertising_analysis: Record<string, unknown> | null;
  score_breakdown: Record<string, unknown> | null;
  emails: Record<string, unknown>[];
  sources: string[];
  search_locations: string[];
  date_discovered: string | null;
  last_seen: string | null;
  last_checked: string | null;
  synced_at: string;
}

export interface SyncOptions {
  /** Skip leads scoring below this. Defaults to 0 (import everything given). */
  minScore?: number;
  /** Stage applied to leads created by this sync. Existing leads keep theirs. */
  initialStage?: PipelineStage;
  /** Rows per upsert request. */
  batchSize?: number;
}

export interface SyncResult {
  received: number;
  skippedBelowMinScore: number;
  skippedInvalid: number;
  crmLeadsCreated: number;
  crmLeadsExisting: number;
  intelligenceUpserted: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------
function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function int(value: unknown): number | null {
  const parsed = num(value);
  return parsed === null ? null : Math.round(parsed);
}

function list(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter((item) => item.length > 0);
}

/** `incorporation_date` arrives as YYYY-MM-DD or null; anything else is dropped. */
function isoDate(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

export function toIntelligenceRow(
  lead: PipelineLeadExport,
  syncedAt: string = new Date().toISOString()
): LeadIntelligenceRow {
  const presence = lead.online_presence ?? {};
  const google = lead.google ?? {};
  const registry = lead.company_registry ?? {};
  const website = lead.website_analysis ?? null;
  const ads = lead.advertising_analysis ?? null;
  const score = lead.score ?? null;

  return {
    external_lead_id: lead.lead_id,
    company_name: str(lead.company_name) ?? 'Unknown business',
    trading_name: str(lead.trading_name),
    legal_name: str(lead.legal_name),
    niche: str(lead.niche),
    sub_niche: str(lead.sub_niche),
    description: str(lead.description),

    website: str(lead.website),
    domain: str(lead.domain),
    business_phone: str(lead.business_phone),
    business_email: str(lead.business_email),
    address: str(lead.address),
    city: str(lead.city),
    postcode: str(lead.postcode),
    region: str(lead.region),
    country: str(lead.country),
    latitude: num(lead.latitude),
    longitude: num(lead.longitude),

    google_maps_url: str(presence.google_maps_url),
    facebook_url: str(presence.facebook_url),
    instagram_url: str(presence.instagram_url),
    linkedin_url: str(presence.linkedin_url),
    tiktok_url: str(presence.tiktok_url),
    youtube_url: str(presence.youtube_url),

    google_rating: num(google.google_rating),
    google_review_count: int(google.google_review_count),
    google_category: str(google.google_category),
    google_place_id: str(google.google_place_id),

    company_number: str(registry.company_number),
    incorporation_date: isoDate(registry.incorporation_date),
    years_in_operation: num(registry.years_in_operation),

    lead_score: num(lead.lead_score ?? (score ? score.total : null)),
    score_band: str(score?.band),
    website_quality_score: int(website?.website_quality_score),
    landing_page_quality_score: int(website?.landing_page_quality_score),
    advertising_status: str(ads?.status),
    opportunities: list(lead.opportunities),
    strengths: list(lead.strengths),
    lead_reason: str(lead.lead_reason),
    recommended_service: str(lead.recommended_service),

    website_analysis: website,
    advertising_analysis: ads,
    score_breakdown: score,
    emails: Array.isArray(lead.emails) ? lead.emails : [],

    sources: list(lead.sources),
    search_locations: list(lead.search_locations),
    date_discovered: str(lead.date_discovered),
    last_seen: str(lead.last_seen),
    last_checked: str(lead.last_checked),
    synced_at: syncedAt
  };
}

/** A lead is importable only if it carries the stable id and a name. */
export function isImportable(lead: PipelineLeadExport): boolean {
  return Boolean(str(lead.lead_id) && str(lead.company_name));
}

export function parseExportDocument(raw: unknown): PipelineLeadExport[] {
  if (Array.isArray(raw)) return raw as PipelineLeadExport[];
  if (raw && typeof raw === 'object') {
    const doc = raw as PipelineExportDocument;
    if (Array.isArray(doc.leads)) return doc.leads;
  }
  throw new Error(
    'Unrecognised export: expected a JSON document with a "leads" array, ' +
      'as produced by `pipeline.py --export-only --format json`.'
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------
export async function syncLeads(
  client: CrmSupabaseClient,
  leads: PipelineLeadExport[],
  options: SyncOptions = {}
): Promise<SyncResult> {
  const { minScore = 0, initialStage = 'qualified', batchSize = 200 } = options;
  const syncedAt = new Date().toISOString();

  const result: SyncResult = {
    received: leads.length,
    skippedBelowMinScore: 0,
    skippedInvalid: 0,
    crmLeadsCreated: 0,
    crmLeadsExisting: 0,
    intelligenceUpserted: 0,
    errors: []
  };

  const importable: PipelineLeadExport[] = [];
  for (const lead of leads) {
    if (!isImportable(lead)) {
      result.skippedInvalid += 1;
      continue;
    }
    const score = num(lead.lead_score ?? lead.score?.total) ?? 0;
    if (score < minScore) {
      result.skippedBelowMinScore += 1;
      continue;
    }
    importable.push(lead);
  }
  if (!importable.length) return result;

  // Deduplicate within the payload itself: one export can legitimately contain
  // the same business twice if it was exported from overlapping runs.
  const byExternalId = new Map<string, PipelineLeadExport>();
  for (const lead of importable) byExternalId.set(lead.lead_id, lead);
  const unique: PipelineLeadExport[] = [];
  byExternalId.forEach((lead) => unique.push(lead));

  const externalIds = unique.map((lead) => lead.lead_id);

  // Which already exist? Determines created-vs-existing counts, and guarantees
  // we only ever INSERT crm_leads rows we have not seen before.
  const existing = await fetchExistingLeadIds(client, externalIds);
  result.crmLeadsExisting = existing.size;

  const toCreate = unique.filter((lead) => !existing.has(lead.lead_id));

  for (const batch of chunk(toCreate, batchSize)) {
    const rows = batch.map((lead) => ({
      external_lead_id: lead.lead_id,
      pipeline_stage: initialStage
    }));
    // ignoreDuplicates: a concurrent sync may have inserted the same lead
    // between our SELECT and this INSERT. Losing that race must not overwrite
    // the winner's row, and must not fail the batch.
    const { data, error } = await client
      .from('crm_leads')
      .upsert(rows, { onConflict: 'external_lead_id', ignoreDuplicates: true })
      .select('id, external_lead_id');

    if (error) {
      result.errors.push(`crm_leads insert failed: ${error.message}`);
      continue;
    }
    result.crmLeadsCreated += data?.length ?? 0;
  }

  // Map every external id to its crm_lead uuid, including rows just created
  // and any that appeared concurrently.
  const idMap = await fetchLeadIdMap(client, externalIds);

  const intelligenceRows = unique
    .filter((lead) => idMap.has(lead.lead_id))
    .map((lead) => ({
      crm_lead_id: idMap.get(lead.lead_id)!,
      ...toIntelligenceRow(lead, syncedAt)
    }));

  for (const batch of chunk(intelligenceRows, batchSize)) {
    // The ONLY table this sync updates. crm_leads and every downstream record
    // are left exactly as the sales team left them.
    const { error, count } = await client
      .from('lead_intelligence')
      .upsert(batch, { onConflict: 'crm_lead_id', count: 'exact' });

    if (error) {
      result.errors.push(`lead_intelligence upsert failed: ${error.message}`);
      continue;
    }
    result.intelligenceUpserted += count ?? batch.length;
  }

  return result;
}

async function fetchExistingLeadIds(
  client: CrmSupabaseClient,
  externalIds: string[]
): Promise<Set<string>> {
  const found = new Set<string>();
  // Chunked: a URL-encoded `in` filter with thousands of ids exceeds request limits.
  for (const batch of chunk(externalIds, 200)) {
    const { data, error } = await client
      .from('crm_leads')
      .select('external_lead_id')
      .in('external_lead_id', batch);
    if (error) throw new Error(`Could not read existing leads: ${error.message}`);
    for (const row of data ?? []) found.add((row as { external_lead_id: string }).external_lead_id);
  }
  return found;
}

async function fetchLeadIdMap(
  client: CrmSupabaseClient,
  externalIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const batch of chunk(externalIds, 200)) {
    const { data, error } = await client
      .from('crm_leads')
      .select('id, external_lead_id')
      .in('external_lead_id', batch);
    if (error) throw new Error(`Could not resolve lead ids: ${error.message}`);
    for (const row of data ?? []) {
      const typed = row as { id: string; external_lead_id: string };
      map.set(typed.external_lead_id, typed.id);
    }
  }
  return map;
}

export function formatSyncResult(result: SyncResult): string {
  const lines = [
    'LEAD SYNC COMPLETE',
    `  Received:            ${result.received}`,
    `  CRM leads created:   ${result.crmLeadsCreated}`,
    `  Already in CRM:      ${result.crmLeadsExisting} (stage and history preserved)`,
    `  Intelligence synced: ${result.intelligenceUpserted}`
  ];
  if (result.skippedBelowMinScore) lines.push(`  Skipped (min score): ${result.skippedBelowMinScore}`);
  if (result.skippedInvalid) lines.push(`  Skipped (invalid):   ${result.skippedInvalid}`);
  if (result.errors.length) {
    lines.push(`  Errors:              ${result.errors.length}`);
    for (const error of result.errors) lines.push(`    - ${error}`);
  }
  return lines.join('\n');
}
