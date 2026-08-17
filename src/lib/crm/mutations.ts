/**
 * Writes for the six user-owned entities.
 *
 * Every function takes an explicit client, like the read helpers, so the caller
 * decides whose permissions apply. In practice that is always the session
 * client: RLS allows insert and update to `crm_can_write()` roles and delete to
 * admins, and none of this bypasses it.
 *
 * Deliberately absent: anything touching `lead_intelligence`, `payments` or
 * `pipeline_stage_history`. Those have no write policy at all — the sync, the
 * Stripe webhook and a trigger own them respectively.
 */

import type { CrmSupabaseClient } from './supabase';
import type {
  Appointment,
  AppointmentStatus,
  Client,
  ClientStatus,
  Contact,
  Contract,
  ContractStatus,
  CrmDocument,
  Note,
  Opportunity,
  OpportunityStage,
  OutreachChannel,
  OutreachSequence,
  OutreachStep,
  Proposal,
  ProposalStatus,
  Task,
  TaskPriority,
  TaskStatus
} from './types';

function unwrapWrite<T>(
  result: { data: T | null; error: { message: string } | null },
  what: string
): T {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  if (result.data === null) throw new Error(`${what}: the database returned no row.`);
  return result.data;
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------
export interface ContactInput {
  crm_lead_id: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  job_title: string | null;
  email: string | null;
  phone: string | null;
  is_primary: boolean;
  is_decision_maker: boolean;
}

/**
 * `contacts_one_primary_per_lead` is a unique partial index, so promoting a
 * contact fails outright while another still holds the flag. Demote the
 * incumbent first — the user asked for this one to be primary, and refusing on
 * a technicality would make them do two steps to express one intention.
 *
 * Not a transaction: PostgREST has no way to send one. The window between the
 * two statements is small, and losing the race raises the unique violation,
 * which `readableWriteError` turns into a sentence. The alternative — a
 * SECURITY DEFINER function to make it atomic — buys little for a form only a
 * handful of people ever submit.
 */
async function clearOtherPrimaries(
  client: CrmSupabaseClient,
  leadId: string,
  exceptId?: string
): Promise<void> {
  let query = client.from('contacts').update({ is_primary: false }).eq('crm_lead_id', leadId).eq('is_primary', true);
  if (exceptId) query = query.neq('id', exceptId);
  const { error } = await query;
  if (error) throw new Error(`Could not move the primary contact: ${error.message}`);
}

export async function createContact(
  client: CrmSupabaseClient,
  input: ContactInput
): Promise<Contact> {
  if (input.is_primary) await clearOtherPrimaries(client, input.crm_lead_id);
  const result = await client.from('contacts').insert(input).select().single();
  return unwrapWrite(result, 'Could not add the contact') as Contact;
}

export async function updateContact(
  client: CrmSupabaseClient,
  id: string,
  input: Omit<ContactInput, 'crm_lead_id'> & { crm_lead_id: string }
): Promise<Contact> {
  if (input.is_primary) await clearOtherPrimaries(client, input.crm_lead_id, id);
  const { crm_lead_id: _lead, ...patch } = input;
  const result = await client.from('contacts').update(patch).eq('id', id).select().single();
  return unwrapWrite(result, 'Could not update the contact') as Contact;
}

export async function deleteContact(client: CrmSupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('contacts').delete().eq('id', id);
  if (error) throw new Error(`Could not delete the contact: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
export interface TaskInput {
  crm_lead_id: string | null;
  client_id: string | null;
  assigned_to: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: string | null;
}

/** `completed_at` is derived from status, never entered, so the two agree. */
function completionStamp(status: TaskStatus, existing?: string | null): string | null {
  if (status !== 'completed') return null;
  return existing ?? new Date().toISOString();
}

export async function createTask(
  client: CrmSupabaseClient,
  input: TaskInput,
  createdBy: string | null
): Promise<Task> {
  const result = await client
    .from('tasks')
    .insert({ ...input, created_by: createdBy, completed_at: completionStamp(input.status) })
    .select()
    .single();
  return unwrapWrite(result, 'Could not create the task') as Task;
}

export async function updateTask(
  client: CrmSupabaseClient,
  id: string,
  input: TaskInput
): Promise<Task> {
  const result = await client
    .from('tasks')
    .update({ ...input, completed_at: completionStamp(input.status) })
    .eq('id', id)
    .select()
    .single();
  return unwrapWrite(result, 'Could not update the task') as Task;
}

/** The one-click path off the task list. */
export async function setTaskStatus(
  client: CrmSupabaseClient,
  id: string,
  status: TaskStatus
): Promise<Task> {
  const result = await client
    .from('tasks')
    .update({ status, completed_at: completionStamp(status) })
    .eq('id', id)
    .select()
    .single();
  return unwrapWrite(result, 'Could not update the task') as Task;
}

export async function deleteTask(client: CrmSupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('tasks').delete().eq('id', id);
  if (error) throw new Error(`Could not delete the task: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------
export interface AppointmentInput {
  crm_lead_id: string | null;
  contact_id: string | null;
  title: string;
  starts_at: string;
  ends_at: string | null;
  timezone: string;
  status: AppointmentStatus;
  meeting_notes: string | null;
  outcome: string | null;
}

export async function createAppointment(
  client: CrmSupabaseClient,
  input: AppointmentInput,
  createdBy: string | null
): Promise<Appointment> {
  const result = await client
    .from('appointments')
    .insert({ ...input, created_by: createdBy })
    .select()
    .single();
  return unwrapWrite(result, 'Could not create the appointment') as Appointment;
}

export async function updateAppointment(
  client: CrmSupabaseClient,
  id: string,
  input: AppointmentInput
): Promise<Appointment> {
  const result = await client.from('appointments').update(input).eq('id', id).select().single();
  return unwrapWrite(result, 'Could not update the appointment') as Appointment;
}

/**
 * Cancelling keeps the row. A no-show and a meeting that never existed are
 * different facts, and only one of them belongs in a conversion rate.
 */
export async function setAppointmentStatus(
  client: CrmSupabaseClient,
  id: string,
  status: AppointmentStatus
): Promise<Appointment> {
  const result = await client.from('appointments').update({ status }).eq('id', id).select().single();
  return unwrapWrite(result, 'Could not update the appointment') as Appointment;
}

export async function deleteAppointment(client: CrmSupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('appointments').delete().eq('id', id);
  if (error) throw new Error(`Could not delete the appointment: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------
export interface OpportunityInput {
  crm_lead_id: string;
  contact_id: string | null;
  name: string;
  stage: OpportunityStage;
  service_name: string | null;
  setup_fee: number | null;
  monthly_value: number | null;
  one_time_value: number | null;
  contract_months: number | null;
  probability: number | null;
  expected_close_date: string | null;
  pain_points: string | null;
  desired_outcome: string | null;
  budget: string | null;
  objections: string | null;
  next_action: string | null;
  owner_id: string | null;
  loss_reason: string | null;
}

/**
 * `won_at` / `lost_at` follow the stage rather than being entered separately.
 * Two fields that can disagree about whether a deal closed is a reporting bug
 * waiting to happen; one of them is derived.
 */
function outcomeStamps(stage: OpportunityStage, existing?: Opportunity | null) {
  const now = new Date().toISOString();
  return {
    won_at: stage === 'won' ? existing?.won_at ?? now : null,
    lost_at: stage === 'lost' ? existing?.lost_at ?? now : null
  };
}

/**
 * Deliberately absent: a plain `createOpportunity`.
 *
 * Opening a deal also moves the lead's stage and writes its timeline, so
 * creation goes through `crm_convert_lead_to_opportunity` in `workflow.ts`,
 * which does all three in one transaction. A bare INSERT alongside it would be
 * the easier import to reach for and would silently leave the lead behind.
 */

export async function updateOpportunity(
  client: CrmSupabaseClient,
  id: string,
  input: OpportunityInput,
  existing?: Opportunity | null
): Promise<Opportunity> {
  const result = await client
    .from('opportunities')
    .update({ ...input, ...outcomeStamps(input.stage, existing) })
    .eq('id', id)
    .select()
    .single();
  return unwrapWrite(result, 'Could not update the opportunity') as Opportunity;
}

export async function deleteOpportunity(client: CrmSupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('opportunities').delete().eq('id', id);
  if (error) throw new Error(`Could not delete the opportunity: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
export interface ClientInput {
  crm_lead_id: string | null;
  opportunity_id: string | null;
  company_name: string;
  status: ClientStatus;
  account_owner: string | null;
  start_date: string | null;
  renewal_date: string | null;
}

export async function createClient(
  client: CrmSupabaseClient,
  input: ClientInput
): Promise<Client> {
  const result = await client.from('clients').insert(input).select().single();
  return unwrapWrite(result, 'Could not create the client') as Client;
}

export async function updateClient(
  client: CrmSupabaseClient,
  id: string,
  input: ClientInput
): Promise<Client> {
  const result = await client.from('clients').update(input).eq('id', id).select().single();
  return unwrapWrite(result, 'Could not update the client') as Client;
}

export async function deleteClient(client: CrmSupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('clients').delete().eq('id', id);
  if (error) throw new Error(`Could not delete the client: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------
/**
 * `notes.content` is jsonb so a rich-text editor can land later without a
 * migration. Until then the shape is `{ "text": "..." }` — one documented key,
 * rather than a bare string that a future editor would have to migrate around.
 */
export interface NoteInput {
  crm_lead_id: string | null;
  client_id: string | null;
  appointment_id: string | null;
  title: string | null;
  text: string;
}

export function noteContent(text: string): Record<string, unknown> {
  return { text };
}

export function noteText(note: Pick<Note, 'content'>): string {
  const value = (note.content as { text?: unknown } | null)?.text;
  return typeof value === 'string' ? value : '';
}

export async function createNote(
  client: CrmSupabaseClient,
  input: NoteInput,
  authorId: string | null
): Promise<Note> {
  const { text, ...rest } = input;
  const result = await client
    .from('notes')
    .insert({ ...rest, content: noteContent(text), author_id: authorId })
    .select()
    .single();
  return unwrapWrite(result, 'Could not save the note') as Note;
}

export async function updateNote(
  client: CrmSupabaseClient,
  id: string,
  input: Pick<NoteInput, 'title' | 'text'>
): Promise<Note> {
  const result = await client
    .from('notes')
    .update({ title: input.title, content: noteContent(input.text) })
    .eq('id', id)
    .select()
    .single();
  return unwrapWrite(result, 'Could not update the note') as Note;
}

export async function deleteNote(client: CrmSupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('notes').delete().eq('id', id);
  if (error) throw new Error(`Could not delete the note: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------
export interface ContractInput {
  client_id: string;
  status: ContractStatus;
  start_date: string | null;
  end_date: string | null;
  monthly_value: number | null;
  setup_fee: number | null;
  document_url: string | null;
}

/**
 * `signed_at` follows the status, like every other derived timestamp here.
 *
 * A contract that has expired or been terminated was still signed at some
 * point, so those statuses keep the date. Only going back to draft or sent
 * clears it, because those are the states of a contract nobody has signed.
 */
function signatureStamp(status: ContractStatus, existing?: Contract | null): string | null {
  if (status === 'draft' || status === 'sent') return null;
  return existing?.signed_at ?? new Date().toISOString();
}

export async function createContract(
  client: CrmSupabaseClient,
  input: ContractInput
): Promise<Contract> {
  const result = await client
    .from('contracts')
    .insert({ ...input, signed_at: signatureStamp(input.status) })
    .select()
    .single();
  return unwrapWrite(result, 'Could not create the contract') as Contract;
}

export async function updateContract(
  client: CrmSupabaseClient,
  id: string,
  input: ContractInput,
  existing?: Contract | null
): Promise<Contract> {
  const result = await client
    .from('contracts')
    .update({ ...input, signed_at: signatureStamp(input.status, existing) })
    .eq('id', id)
    .select()
    .single();
  return unwrapWrite(result, 'Could not update the contract') as Contract;
}

export async function deleteContract(client: CrmSupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('contracts').delete().eq('id', id);
  if (error) throw new Error(`Could not delete the contract: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------
export interface ProposalInput {
  opportunity_id: string;
  status: ProposalStatus;
  title: string | null;
  total_value: number | null;
  setup_fee: number | null;
  monthly_value: number | null;
  valid_until: string | null;
  document_url: string | null;
}

/**
 * Each status stamps its own moment and keeps it.
 *
 * A proposal that was sent, then viewed, then accepted should end up with all
 * three dates — that sequence is the whole reason to record them. Deriving each
 * from the current status alone would leave only the latest, so earlier stamps
 * are preserved once set.
 */
function proposalStamps(status: ProposalStatus, existing?: Proposal | null) {
  const now = new Date().toISOString();
  const reached = (target: ProposalStatus, order: ProposalStatus[]) =>
    order.indexOf(status) >= order.indexOf(target);
  const progression: ProposalStatus[] = ['draft', 'sent', 'viewed', 'accepted'];

  return {
    sent_at:
      existing?.sent_at ??
      (progression.includes(status) && reached('sent', progression) ? now : null),
    viewed_at:
      existing?.viewed_at ??
      (progression.includes(status) && reached('viewed', progression) ? now : null),
    accepted_at: existing?.accepted_at ?? (status === 'accepted' ? now : null)
  };
}

/**
 * Versions are unique per opportunity, so the next one is derived rather than
 * typed. Two people drafting at once can still collide; the unique violation
 * becomes "That record already exists", which is accurate.
 */
export async function nextProposalVersion(
  client: CrmSupabaseClient,
  opportunityId: string
): Promise<number> {
  const { data, error } = await client
    .from('proposals')
    .select('version')
    .eq('opportunity_id', opportunityId)
    .order('version', { ascending: false })
    .limit(1);
  if (error) throw new Error(`Could not read proposal versions: ${error.message}`);
  const highest = (data as { version: number }[] | null)?.[0]?.version ?? 0;
  return highest + 1;
}

export async function createProposal(
  client: CrmSupabaseClient,
  input: ProposalInput,
  createdBy: string | null
): Promise<Proposal> {
  const version = await nextProposalVersion(client, input.opportunity_id);
  const result = await client
    .from('proposals')
    .insert({ ...input, version, created_by: createdBy, ...proposalStamps(input.status) })
    .select()
    .single();
  return unwrapWrite(result, 'Could not create the proposal') as Proposal;
}

export async function updateProposal(
  client: CrmSupabaseClient,
  id: string,
  input: ProposalInput,
  existing?: Proposal | null
): Promise<Proposal> {
  const result = await client
    .from('proposals')
    .update({ ...input, ...proposalStamps(input.status, existing) })
    .eq('id', id)
    .select()
    .single();
  return unwrapWrite(result, 'Could not update the proposal') as Proposal;
}

export async function deleteProposal(client: CrmSupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('proposals').delete().eq('id', id);
  if (error) throw new Error(`Could not delete the proposal: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------
export const DOCUMENT_BUCKET = 'crm-documents';

export interface DocumentInput {
  crm_lead_id: string | null;
  client_id: string | null;
  name: string;
  file: File;
}

/**
 * A storage key that cannot collide and cannot be guessed from the file name.
 *
 * Scoped by owning record so a leaked path reveals only which lead it belongs
 * to, and suffixed with a random segment so uploading `contract.pdf` twice does
 * not overwrite the first one.
 */
export function documentPath(ownerKind: 'leads' | 'clients', ownerId: string, name: string): string {
  const safe = name
    .replace(/[^\w.\-]+/g, '_')
    // `.` survives the character class above, so `../..` would otherwise reach
    // the key intact. Storage keys are not filesystem paths, but backends
    // normalise them differently and a traversal sequence has no business here.
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+/, '')
    .slice(-80);
  const unique = crypto.randomUUID();
  return `${ownerKind}/${ownerId}/${unique}-${safe || 'file'}`;
}

/**
 * Upload the bytes, then record the metadata.
 *
 * Both halves run as the signed-in user, so storage RLS and table RLS each
 * apply. If the metadata insert fails the object is removed again — an
 * orphaned blob nobody can see or delete through the UI is worse than no file.
 */
export async function createDocument(
  client: CrmSupabaseClient,
  input: DocumentInput,
  uploadedBy: string | null
): Promise<CrmDocument> {
  const ownerKind = input.crm_lead_id ? 'leads' : 'clients';
  const ownerId = (input.crm_lead_id ?? input.client_id)!;
  const path = documentPath(ownerKind, ownerId, input.name);

  const upload = await client.storage.from(DOCUMENT_BUCKET).upload(path, input.file, {
    contentType: input.file.type || 'application/octet-stream',
    upsert: false
  });
  if (upload.error) throw new Error(`Could not upload the file: ${upload.error.message}`);

  const result = await client
    .from('documents')
    .insert({
      crm_lead_id: input.crm_lead_id,
      client_id: input.client_id,
      name: input.name,
      storage_path: path,
      mime_type: input.file.type || null,
      file_size: input.file.size,
      uploaded_by: uploadedBy
    })
    .select()
    .single();

  if (result.error) {
    await client.storage.from(DOCUMENT_BUCKET).remove([path]);
    throw new Error(`Could not record the document: ${result.error.message}`);
  }
  return result.data as CrmDocument;
}

/** Removes the object first: a row with no file is more confusing than neither. */
export async function deleteDocument(
  client: CrmSupabaseClient,
  id: string,
  storagePath: string
): Promise<void> {
  const removal = await client.storage.from(DOCUMENT_BUCKET).remove([storagePath]);
  if (removal.error) throw new Error(`Could not delete the file: ${removal.error.message}`);

  const { error } = await client.from('documents').delete().eq('id', id);
  if (error) throw new Error(`Could not delete the document record: ${error.message}`);
}

/** A short-lived URL for a private object. */
export async function documentDownloadUrl(
  client: CrmSupabaseClient,
  storagePath: string,
  expiresInSeconds = 60
): Promise<string> {
  const { data, error } = await client.storage
    .from(DOCUMENT_BUCKET)
    .createSignedUrl(storagePath, expiresInSeconds);
  if (error || !data) throw new Error(`Could not open the file: ${error?.message ?? 'no URL'}`);
  return data.signedUrl;
}

// ---------------------------------------------------------------------------
// Outreach sequences and steps
// ---------------------------------------------------------------------------
export interface SequenceInput {
  name: string;
  description: string | null;
  active: boolean;
}

export async function createSequence(
  client: CrmSupabaseClient,
  input: SequenceInput,
  createdBy: string | null
): Promise<OutreachSequence> {
  const result = await client
    .from('outreach_sequences')
    .insert({ ...input, created_by: createdBy })
    .select()
    .single();
  return unwrapWrite(result, 'Could not create the sequence') as OutreachSequence;
}

export async function updateSequence(
  client: CrmSupabaseClient,
  id: string,
  input: SequenceInput
): Promise<OutreachSequence> {
  const result = await client
    .from('outreach_sequences')
    .update(input)
    .eq('id', id)
    .select()
    .single();
  return unwrapWrite(result, 'Could not update the sequence') as OutreachSequence;
}

export async function deleteSequence(client: CrmSupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('outreach_sequences').delete().eq('id', id);
  if (error) throw new Error(`Could not delete the sequence: ${error.message}`);
}

export interface StepInput {
  sequence_id: string;
  step_number: number;
  channel: OutreachChannel;
  delay_minutes: number;
  subject_template: string | null;
  body_template: string | null;
  active: boolean;
}

/** Steps are numbered uniquely within a sequence, so the next one is derived. */
export async function nextStepNumber(
  client: CrmSupabaseClient,
  sequenceId: string
): Promise<number> {
  const { data, error } = await client
    .from('outreach_steps')
    .select('step_number')
    .eq('sequence_id', sequenceId)
    .order('step_number', { ascending: false })
    .limit(1);
  if (error) throw new Error(`Could not read the sequence steps: ${error.message}`);
  return ((data as { step_number: number }[] | null)?.[0]?.step_number ?? 0) + 1;
}

export async function createStep(
  client: CrmSupabaseClient,
  input: Omit<StepInput, 'step_number'> & { step_number?: number }
): Promise<OutreachStep> {
  const step_number = input.step_number ?? (await nextStepNumber(client, input.sequence_id));
  const result = await client
    .from('outreach_steps')
    .insert({ ...input, step_number })
    .select()
    .single();
  return unwrapWrite(result, 'Could not add the step') as OutreachStep;
}

export async function updateStep(
  client: CrmSupabaseClient,
  id: string,
  input: StepInput
): Promise<OutreachStep> {
  const result = await client.from('outreach_steps').update(input).eq('id', id).select().single();
  return unwrapWrite(result, 'Could not update the step') as OutreachStep;
}

export async function deleteStep(client: CrmSupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('outreach_steps').delete().eq('id', id);
  if (error) throw new Error(`Could not delete the step: ${error.message}`);
}
