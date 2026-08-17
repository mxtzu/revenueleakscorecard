'use server';

/**
 * Create, update and delete for the six user-owned entities.
 *
 * Shape shared by every action:
 *
 *   authorise -> validate -> write -> revalidate -> redirect back
 *
 * Failures redirect with `?error=`, never throw. An uncaught throw in a Server
 * Action swaps the whole page for the error boundary, which loses the rest of
 * the record the user was looking at — for a rejected field that is a wildly
 * disproportionate response.
 *
 * `_actions` is a private folder: the leading underscore keeps Next from
 * treating it as a route.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { safeDestination, withMessage } from '@/lib/crm/redirects';
import { readableWriteError, ValidationError } from '@/lib/crm/errors';
import {
  createAppointment,
  createClient,
  createContact,
  createNote,
  createTask,
  deleteAppointment,
  deleteClient,
  deleteContact,
  deleteNote,
  deleteOpportunity,
  deleteTask,
  setAppointmentStatus,
  setTaskStatus,
  updateAppointment,
  updateClient,
  updateContact,
  updateNote,
  updateOpportunity,
  updateTask
} from '@/lib/crm/mutations';
import { requireAdmin, requireWriter } from '@/lib/crm/server';
import { convertLeadToOpportunity } from '@/lib/crm/workflow';
import {
  APPOINTMENT_STATUSES,
  CLIENT_STATUSES,
  OPPORTUNITY_STAGES,
  TASK_PRIORITIES,
  TASK_STATUSES
} from '@/lib/crm/types';
import {
  bool,
  emailList,
  enumValue,
  optionalDate,
  optionalInt,
  optionalMoney,
  optionalText,
  optionalTimestamp,
  optionalUuid,
  requiredTimestamp,
  text,
  timezone,
  uuid
} from '@/lib/crm/validation';

/**
 * Where to send the browser afterwards.
 *
 * Taken from a hidden field so each form returns to the page it was submitted
 * from — the same contact form is rendered on the lead page and could later
 * appear elsewhere. Restricted to same-origin paths for the same reason the
 * login redirect is.
 */
function destination(form: FormData, fallback: string): string {
  // Shared, because six near-identical copies of this check is how one of them
  // ends up missing the backslash case. See src/lib/crm/redirects.ts.
  return safeDestination(form.get('return_to'), fallback);
}

function back(form: FormData, fallback: string, error?: unknown): never {
  const path = destination(form, fallback);
  if (error === undefined) redirect(path);
  redirect(withMessage(path, 'error', readableWriteError(error)));
}

/** Revalidate the pages a change to this entity could be visible on. */
function refresh(paths: string[]): void {
  for (const path of paths) revalidatePath(path);
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------
function contactFields(form: FormData) {
  const first = optionalText(form, 'first_name');
  const last = optionalText(form, 'last_name');
  const full = optionalText(form, 'full_name') ?? ([first, last].filter(Boolean).join(' ') || null);
  if (!full) throw new ValidationError('A contact needs a name.');
  return {
    first_name: first,
    last_name: last,
    full_name: full,
    job_title: optionalText(form, 'job_title'),
    email: optionalText(form, 'email'),
    phone: optionalText(form, 'phone'),
    is_primary: bool(form, 'is_primary'),
    is_decision_maker: bool(form, 'is_decision_maker')
  };
}

export async function saveContact(form: FormData) {
  const leadId = uuid(form, 'crm_lead_id', 'Lead');
  const fallback = `/leads/${leadId}`;
  try {
    const { client } = await requireWriter();
    const id = optionalUuid(form, 'id');
    const fields = { ...contactFields(form), crm_lead_id: leadId };
    if (id) await updateContact(client, id, fields);
    else await createContact(client, fields);
  } catch (error) {
    back(form, fallback, error);
  }
  refresh([fallback]);
  back(form, fallback);
}

export async function removeContact(form: FormData) {
  const leadId = uuid(form, 'crm_lead_id', 'Lead');
  const fallback = `/leads/${leadId}`;
  try {
    const { client } = await requireAdmin();
    await deleteContact(client, uuid(form, 'id', 'Contact'));
  } catch (error) {
    back(form, fallback, error);
  }
  refresh([fallback]);
  back(form, fallback);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
const TASK_PAGES = ['/tasks', '/dashboard'];

function taskFields(form: FormData) {
  return {
    crm_lead_id: optionalUuid(form, 'crm_lead_id'),
    client_id: optionalUuid(form, 'client_id'),
    assigned_to: optionalUuid(form, 'assigned_to'),
    title: text(form, 'title', 'Task title'),
    description: optionalText(form, 'description'),
    status: enumValue(form, 'status', TASK_STATUSES, 'Status', 'pending'),
    priority: enumValue(form, 'priority', TASK_PRIORITIES, 'Priority', 'normal'),
    due_at: optionalTimestamp(form, 'due_at', 'Due date')
  };
}

export async function saveTask(form: FormData) {
  const fallback = '/tasks';
  try {
    const { client, userId } = await requireWriter();
    const id = optionalUuid(form, 'id');
    const fields = taskFields(form);
    if (id) await updateTask(client, id, fields);
    else await createTask(client, fields, userId);
    refresh([...TASK_PAGES, fields.crm_lead_id ? `/leads/${fields.crm_lead_id}` : '/tasks']);
  } catch (error) {
    back(form, fallback, error);
  }
  back(form, fallback);
}

/** Tick a task off from the list, without opening the edit form. */
export async function markTask(form: FormData) {
  const fallback = '/tasks';
  try {
    const { client } = await requireWriter();
    await setTaskStatus(
      client,
      uuid(form, 'id', 'Task'),
      enumValue(form, 'status', TASK_STATUSES, 'Status')
    );
    refresh(TASK_PAGES);
  } catch (error) {
    back(form, fallback, error);
  }
  back(form, fallback);
}

export async function removeTask(form: FormData) {
  const fallback = '/tasks';
  try {
    const { client } = await requireAdmin();
    await deleteTask(client, uuid(form, 'id', 'Task'));
    refresh(TASK_PAGES);
  } catch (error) {
    back(form, fallback, error);
  }
  back(form, fallback);
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------
const APPOINTMENT_PAGES = ['/calendar', '/dashboard'];

function appointmentFields(form: FormData) {
  // Read the zone first: the wall-clock times below are interpreted in it.
  const zone = timezone(form, 'timezone');
  const fields = {
    crm_lead_id: optionalUuid(form, 'crm_lead_id'),
    contact_id: optionalUuid(form, 'contact_id'),
    title: text(form, 'title', 'Title'),
    starts_at: requiredTimestamp(form, 'starts_at', 'Start time', zone),
    ends_at: optionalTimestamp(form, 'ends_at', 'End time', zone),
    timezone: zone,
    status: enumValue(form, 'status', APPOINTMENT_STATUSES, 'Status', 'scheduled'),
    meeting_notes: optionalText(form, 'meeting_notes'),
    outcome: optionalText(form, 'outcome'),
    // Calendar fields. `sync_state` is not among them: the database sets it
    // when a synced field changes, so a form cannot claim to be in sync.
    attendee_emails: emailList(form, 'attendee_emails'),
    conference_requested: bool(form, 'conference_requested'),
    notify_attendees: bool(form, 'notify_attendees')
  };
  if (fields.ends_at && fields.ends_at < fields.starts_at) {
    throw new ValidationError('The end time cannot be before the start time.');
  }
  return fields;
}

export async function saveAppointment(form: FormData) {
  const fallback = '/calendar';
  try {
    const { client, userId } = await requireWriter();
    const id = optionalUuid(form, 'id');
    const fields = appointmentFields(form);
    if (id) await updateAppointment(client, id, fields);
    else await createAppointment(client, fields, userId);
    refresh([
      ...APPOINTMENT_PAGES,
      fields.crm_lead_id ? `/leads/${fields.crm_lead_id}` : '/calendar'
    ]);
  } catch (error) {
    back(form, fallback, error);
  }
  back(form, fallback);
}

export async function markAppointment(form: FormData) {
  const fallback = '/calendar';
  try {
    const { client } = await requireWriter();
    await setAppointmentStatus(
      client,
      uuid(form, 'id', 'Appointment'),
      enumValue(form, 'status', APPOINTMENT_STATUSES, 'Status')
    );
    refresh(APPOINTMENT_PAGES);
  } catch (error) {
    back(form, fallback, error);
  }
  back(form, fallback);
}

export async function removeAppointment(form: FormData) {
  const fallback = '/calendar';
  try {
    const { client } = await requireAdmin();
    await deleteAppointment(client, uuid(form, 'id', 'Appointment'));
    refresh(APPOINTMENT_PAGES);
  } catch (error) {
    back(form, fallback, error);
  }
  back(form, fallback);
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------
const OPPORTUNITY_PAGES = ['/opportunities', '/dashboard'];

function opportunityFields(form: FormData) {
  return {
    crm_lead_id: uuid(form, 'crm_lead_id', 'Lead'),
    contact_id: optionalUuid(form, 'contact_id'),
    name: text(form, 'name', 'Opportunity name'),
    stage: enumValue(form, 'stage', OPPORTUNITY_STAGES, 'Stage', 'discovery'),
    service_name: optionalText(form, 'service_name'),
    setup_fee: optionalMoney(form, 'setup_fee', 'Setup fee'),
    monthly_value: optionalMoney(form, 'monthly_value', 'Monthly value'),
    one_time_value: optionalMoney(form, 'one_time_value', 'One-off value'),
    contract_months: optionalInt(form, 'contract_months', 'Contract length', { min: 1, max: 120 }),
    probability: optionalInt(form, 'probability', 'Probability', { min: 0, max: 100 }),
    expected_close_date: optionalDate(form, 'expected_close_date', 'Expected close date'),
    pain_points: optionalText(form, 'pain_points'),
    desired_outcome: optionalText(form, 'desired_outcome'),
    budget: optionalText(form, 'budget'),
    objections: optionalText(form, 'objections'),
    next_action: optionalText(form, 'next_action'),
    owner_id: optionalUuid(form, 'owner_id'),
    loss_reason: optionalText(form, 'loss_reason')
  };
}

/**
 * Editing a deal is a plain update; creating one is a transition.
 *
 * A new opportunity means the lead is now a live deal, so the lead's stage and
 * timeline have to move with it. That is three tables, so creation goes
 * through `crm_convert_lead_to_opportunity` — the same transaction the lead
 * page's convert form uses. Two creation paths with different side effects is
 * how a board ends up disagreeing with the forecast.
 */
export async function saveOpportunity(form: FormData) {
  const fallback = '/opportunities';
  try {
    const { client, userId } = await requireWriter();
    const id = optionalUuid(form, 'id');
    const fields = opportunityFields(form);
    if (id) {
      await updateOpportunity(client, id, fields);
    } else {
      const { loss_reason: _unused, ...deal } = fields;
      await convertLeadToOpportunity(client, {
        ...deal,
        owner_id: deal.owner_id ?? userId,
        next_action_at: optionalTimestamp(form, 'next_action_at', 'Next action'),
        note: optionalText(form, 'note')
      });
    }
    refresh([...OPPORTUNITY_PAGES, `/leads/${fields.crm_lead_id}`]);
  } catch (error) {
    back(form, fallback, error);
  }
  back(form, fallback);
}

export async function removeOpportunity(form: FormData) {
  const fallback = '/opportunities';
  try {
    const { client } = await requireAdmin();
    await deleteOpportunity(client, uuid(form, 'id', 'Opportunity'));
    refresh(OPPORTUNITY_PAGES);
  } catch (error) {
    back(form, fallback, error);
  }
  back(form, fallback);
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
const CLIENT_PAGES = ['/clients', '/dashboard'];

function clientFields(form: FormData) {
  return {
    crm_lead_id: optionalUuid(form, 'crm_lead_id'),
    opportunity_id: optionalUuid(form, 'opportunity_id'),
    company_name: text(form, 'company_name', 'Company name'),
    status: enumValue(form, 'status', CLIENT_STATUSES, 'Status', 'onboarding'),
    account_owner: optionalUuid(form, 'account_owner'),
    start_date: optionalDate(form, 'start_date', 'Start date'),
    renewal_date: optionalDate(form, 'renewal_date', 'Renewal date')
  };
}

export async function saveClient(form: FormData) {
  const fallback = '/clients';
  try {
    const { client } = await requireWriter();
    const id = optionalUuid(form, 'id');
    const fields = clientFields(form);
    if (id) {
      await updateClient(client, id, fields);
      refresh([...CLIENT_PAGES, `/clients/${id}`]);
    } else {
      await createClient(client, fields);
      refresh(CLIENT_PAGES);
    }
  } catch (error) {
    back(form, fallback, error);
  }
  back(form, fallback);
}

export async function removeClient(form: FormData) {
  const fallback = '/clients';
  try {
    const { client } = await requireAdmin();
    await deleteClient(client, uuid(form, 'id', 'Client'));
    refresh(CLIENT_PAGES);
  } catch (error) {
    back(form, fallback, error);
  }
  // The client page it was deleted from no longer exists, so ignore return_to.
  redirect('/clients');
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------
export async function saveNote(form: FormData) {
  const leadId = optionalUuid(form, 'crm_lead_id');
  const clientId = optionalUuid(form, 'client_id');
  const fallback = leadId ? `/leads/${leadId}` : clientId ? `/clients/${clientId}` : '/dashboard';
  try {
    const { client, userId } = await requireWriter();
    const id = optionalUuid(form, 'id');
    const fields = {
      crm_lead_id: leadId,
      client_id: clientId,
      appointment_id: optionalUuid(form, 'appointment_id'),
      title: optionalText(form, 'title'),
      text: text(form, 'text', 'Note')
    };
    if (id) await updateNote(client, id, { title: fields.title, text: fields.text });
    else await createNote(client, fields, userId);
  } catch (error) {
    back(form, fallback, error);
  }
  refresh([fallback]);
  back(form, fallback);
}

export async function removeNote(form: FormData) {
  const leadId = optionalUuid(form, 'crm_lead_id');
  const clientId = optionalUuid(form, 'client_id');
  const fallback = leadId ? `/leads/${leadId}` : clientId ? `/clients/${clientId}` : '/dashboard';
  try {
    const { client } = await requireAdmin();
    await deleteNote(client, uuid(form, 'id', 'Note'));
  } catch (error) {
    back(form, fallback, error);
  }
  refresh([fallback]);
  back(form, fallback);
}
