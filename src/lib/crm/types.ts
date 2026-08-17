/**
 * Types for the Agency CRM schema (supabase/migrations/20260815_create_agency_crm.sql).
 *
 * Hand-written rather than generated so the file stays readable and reviewable;
 * `npm run db:test` asserts the migration still matches what these describe.
 *
 * Boundary reminder: `CrmLead` is sales state only. Everything scraped by
 * lead_pipeline lives on `LeadIntelligence`, which the CRM treats as read-only.
 */

// ---------------------------------------------------------------------------
// Enums — kept as const arrays so they can be iterated in the UI and used as
// runtime validators, with the union types derived from them.
// ---------------------------------------------------------------------------
export const CRM_ROLES = ['owner', 'admin', 'sales', 'account_manager', 'viewer'] as const;
export type CrmRole = (typeof CRM_ROLES)[number];

export const PIPELINE_STAGES = [
  'qualified',
  'ready_for_outreach',
  'contacted',
  'replied',
  'appointment_booked',
  'sales_call',
  'proposal',
  'negotiation',
  'won',
  'lost',
  'disqualified',
  'do_not_contact'
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Stages a lead passes through on the way to revenue, in funnel order. */
export const ACTIVE_PIPELINE_STAGES: PipelineStage[] = [
  'qualified',
  'ready_for_outreach',
  'contacted',
  'replied',
  'appointment_booked',
  'sales_call',
  'proposal',
  'negotiation',
  'won'
];

/** Stages that mean "stop working this lead". */
export const CLOSED_PIPELINE_STAGES: PipelineStage[] = [
  'won',
  'lost',
  'disqualified',
  'do_not_contact'
];

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  qualified: 'Qualified',
  ready_for_outreach: 'Ready for outreach',
  contacted: 'Contacted',
  replied: 'Replied',
  appointment_booked: 'Appointment booked',
  sales_call: 'Sales call',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  won: 'Won',
  lost: 'Lost',
  disqualified: 'Disqualified',
  do_not_contact: 'Do not contact'
};

export const ACTIVITY_TYPES = [
  'email', 'call', 'sms', 'voicemail', 'meeting', 'note',
  'task', 'status_change', 'proposal', 'payment', 'other'
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_DIRECTIONS = ['inbound', 'outbound', 'internal'] as const;
export type ActivityDirection = (typeof ACTIVITY_DIRECTIONS)[number];

export const OUTREACH_CHANNELS = ['email', 'call', 'sms', 'voicemail', 'linkedin', 'other'] as const;
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];

export const OUTREACH_STATUSES = [
  'not_started', 'active', 'paused', 'completed', 'stopped', 'replied'
] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

export const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const APPOINTMENT_STATUSES = [
  'scheduled', 'confirmed', 'completed', 'no_show', 'cancelled', 'rescheduled'
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const OPPORTUNITY_STAGES = [
  'discovery', 'sales_call', 'proposal', 'negotiation', 'won', 'lost'
] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

export const PROPOSAL_STATUSES = [
  'draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired'
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const CLIENT_STATUSES = ['onboarding', 'active', 'paused', 'cancelled', 'churned'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const CONTRACT_STATUSES = [
  'draft', 'sent', 'signed', 'active', 'expired', 'terminated'
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const PAYMENT_STATUSES = [
  'pending', 'paid', 'failed', 'overdue', 'refunded', 'cancelled'
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------
export type Uuid = string;
export type IsoTimestamp = string;
export type IsoDate = string;
export type Json = Record<string, unknown>;

export interface Profile {
  id: Uuid;
  email: string | null;
  full_name: string | null;
  role: CrmRole;
  is_active: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

/** Sales state for a lead. Never carries scraped intelligence. */
export interface CrmLead {
  id: Uuid;
  /** lead_pipeline `leads.id`. The stable join key between the two systems. */
  external_lead_id: string;
  pipeline_stage: PipelineStage;
  owner_id: Uuid | null;
  next_action: string | null;
  next_action_at: IsoTimestamp | null;
  loss_reason: string | null;
  disqualification_reason: string | null;
  first_contacted_at: IsoTimestamp | null;
  first_replied_at: IsoTimestamp | null;
  converted_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

/**
 * Read-only replica of lead_pipeline output. Written exclusively by the sync
 * (service role); no RLS write policy exists for CRM users.
 */
export interface LeadIntelligence {
  crm_lead_id: Uuid;
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
  /** Decision-maker published on the company website. Null unless one was found. */
  contact_name: string | null;
  /** The published role that justified recording the name. Never inferred. */
  contact_role: string | null;
  /** The page the name and role were read from. */
  contact_source_url: string | null;
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
  incorporation_date: IsoDate | null;
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

  website_analysis: Json | null;
  advertising_analysis: Json | null;
  score_breakdown: Json | null;
  emails: Json[];

  sources: string[];
  search_locations: string[];
  date_discovered: IsoTimestamp | null;
  last_seen: IsoTimestamp | null;
  last_checked: IsoTimestamp | null;
  synced_at: IsoTimestamp;
}

export interface Contact {
  id: Uuid;
  crm_lead_id: Uuid;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  job_title: string | null;
  email: string | null;
  phone: string | null;
  email_verified: boolean;
  phone_verified: boolean;
  is_primary: boolean;
  is_decision_maker: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface Activity {
  id: Uuid;
  crm_lead_id: Uuid | null;
  client_id: Uuid | null;
  contact_id: Uuid | null;
  user_id: Uuid | null;
  type: ActivityType;
  direction: ActivityDirection;
  subject: string | null;
  body: string | null;
  outcome: string | null;
  occurred_at: IsoTimestamp;
  metadata: Json;
  created_at: IsoTimestamp;
}

export interface OutreachSequence {
  id: Uuid;
  name: string;
  description: string | null;
  active: boolean;
  created_by: Uuid | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface OutreachStep {
  id: Uuid;
  sequence_id: Uuid;
  step_number: number;
  channel: OutreachChannel;
  delay_minutes: number;
  subject_template: string | null;
  body_template: string | null;
  active: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface LeadOutreach {
  id: Uuid;
  crm_lead_id: Uuid;
  sequence_id: Uuid;
  status: OutreachStatus;
  current_step: number;
  started_at: IsoTimestamp | null;
  next_step_at: IsoTimestamp | null;
  stopped_at: IsoTimestamp | null;
  stop_reason: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface Task {
  id: Uuid;
  crm_lead_id: Uuid | null;
  client_id: Uuid | null;
  assigned_to: Uuid | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: IsoTimestamp | null;
  completed_at: IsoTimestamp | null;
  created_by: Uuid | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface Appointment {
  id: Uuid;
  crm_lead_id: Uuid | null;
  contact_id: Uuid | null;
  created_by: Uuid | null;
  title: string;
  starts_at: IsoTimestamp;
  ends_at: IsoTimestamp | null;
  timezone: string;
  status: AppointmentStatus;
  calendar_provider: string | null;
  external_event_id: string | null;
  google_meet_url: string | null;
  meeting_notes: string | null;
  outcome: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;

  // Google Calendar sync (20260819_calendar_sync.sql).
  calendar_account_id: Uuid | null;
  sync_state: 'local' | 'pending' | 'synced' | 'failed';
  sync_error: string | null;
  synced_at: IsoTimestamp | null;
  /** Google's own last-modified stamp, for deciding which side changed last. */
  external_updated_at: IsoTimestamp | null;
  external_html_link: string | null;
  /** A Meet link was asked for; `google_meet_url` is what came back. */
  conference_requested: boolean;
  attendee_emails: string[];
  /**
   * Off by default. Google emails attendees on write unless `sendUpdates=none`,
   * and this CRM never contacts anybody without a person choosing to.
   */
  notify_attendees: boolean;
}

export interface Opportunity {
  id: Uuid;
  crm_lead_id: Uuid;
  contact_id: Uuid | null;
  name: string;
  stage: OpportunityStage;
  service_name: string | null;
  setup_fee: number | null;
  monthly_value: number | null;
  one_time_value: number | null;
  contract_months: number | null;
  probability: number | null;
  expected_close_date: IsoDate | null;
  pain_points: string | null;
  desired_outcome: string | null;
  budget: string | null;
  objections: string | null;
  next_action: string | null;
  next_action_at: IsoTimestamp | null;
  owner_id: Uuid | null;
  won_at: IsoTimestamp | null;
  lost_at: IsoTimestamp | null;
  loss_reason: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface Proposal {
  id: Uuid;
  opportunity_id: Uuid;
  version: number;
  status: ProposalStatus;
  title: string | null;
  total_value: number | null;
  setup_fee: number | null;
  monthly_value: number | null;
  valid_until: IsoDate | null;
  document_url: string | null;
  sent_at: IsoTimestamp | null;
  viewed_at: IsoTimestamp | null;
  accepted_at: IsoTimestamp | null;
  created_by: Uuid | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface Client {
  id: Uuid;
  crm_lead_id: Uuid | null;
  opportunity_id: Uuid | null;
  company_name: string;
  status: ClientStatus;
  account_owner: Uuid | null;
  start_date: IsoDate | null;
  renewal_date: IsoDate | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;

  // Stripe billing (20260820_payments.sql).
  /** Unique: two accounts sharing one Stripe customer make invoices ambiguous. */
  stripe_customer_id: string | null;
  billing_email: string | null;
}

export interface Contract {
  id: Uuid;
  client_id: Uuid;
  status: ContractStatus;
  start_date: IsoDate | null;
  end_date: IsoDate | null;
  monthly_value: number | null;
  setup_fee: number | null;
  document_url: string | null;
  signed_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface Payment {
  id: Uuid;
  client_id: Uuid | null;
  opportunity_id: Uuid | null;
  stripe_customer_id: string | null;
  stripe_invoice_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_subscription_id: string | null;
  amount: number;
  currency: string;
  status: PaymentStatus;
  due_at: IsoTimestamp | null;
  paid_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;

  // Stripe billing (20260820_payments.sql). Written only by the webhook.
  subscription_id: Uuid | null;
  stripe_charge_id: string | null;
  /** Stripe's own invoice status, verbatim. `status` is the CRM reading of it. */
  stripe_status: string | null;
  invoice_number: string | null;
  description: string | null;
  /** Minted by Stripe. Never constructed here — a guessed URL is a broken one. */
  hosted_invoice_url: string | null;
  invoice_pdf_url: string | null;
  period_start: IsoTimestamp | null;
  period_end: IsoTimestamp | null;
  amount_due: number | null;
  amount_paid: number | null;
  amount_refunded: number;
  attempt_count: number;
  failure_reason: string | null;
  voided_at: IsoTimestamp | null;
  last_event_at: IsoTimestamp | null;
}

export interface Note {
  id: Uuid;
  crm_lead_id: Uuid | null;
  client_id: Uuid | null;
  appointment_id: Uuid | null;
  author_id: Uuid | null;
  title: string | null;
  content: Json;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface CrmDocument {
  id: Uuid;
  crm_lead_id: Uuid | null;
  client_id: Uuid | null;
  uploaded_by: Uuid | null;
  name: string;
  storage_path: string;
  mime_type: string | null;
  file_size: number | null;
  created_at: IsoTimestamp;
}

export interface PipelineStageHistoryEntry {
  id: Uuid;
  crm_lead_id: Uuid;
  from_stage: PipelineStage | null;
  to_stage: PipelineStage;
  changed_by: Uuid | null;
  reason: string | null;
  created_at: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Composites used by the UI
// ---------------------------------------------------------------------------

/** A lead plus its intelligence snapshot — the shape the lead list renders. */
export interface CrmLeadWithIntelligence extends CrmLead {
  intelligence: LeadIntelligence | null;
  owner?: Pick<Profile, 'id' | 'full_name' | 'email'> | null;
}

/** Everything the lead detail page needs, in one payload. */
export interface LeadDetail extends CrmLeadWithIntelligence {
  contacts: Contact[];
  activities: Activity[];
  tasks: Task[];
  appointments: Appointment[];
  opportunities: Opportunity[];
  stageHistory: PipelineStageHistoryEntry[];
  notes: Note[];
}

export function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === 'string' && (PIPELINE_STAGES as readonly string[]).includes(value);
}
