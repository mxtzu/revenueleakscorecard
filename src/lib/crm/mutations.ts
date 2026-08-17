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
  Note,
  Opportunity,
  OpportunityStage,
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

export async function createOpportunity(
  client: CrmSupabaseClient,
  input: OpportunityInput
): Promise<Opportunity> {
  const result = await client
    .from('opportunities')
    .insert({ ...input, ...outcomeStamps(input.stage) })
    .select()
    .single();
  return unwrapWrite(result, 'Could not create the opportunity') as Opportunity;
}

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
