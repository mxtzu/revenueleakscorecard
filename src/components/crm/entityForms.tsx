/**
 * One form per entity, used for both create and edit.
 *
 * A separate "new" and "edit" form for the same record is how the two drift:
 * a field gets added to one and forgotten in the other. These take an optional
 * existing record and prefill from it — absent means create, present means
 * edit, and the field list cannot diverge because there is only one.
 */

import {
  CheckboxField,
  Disclosure,
  FormGrid,
  ReturnTo,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  optionsFrom,
  toDateInput,
  toLocalInput,
  type Option
} from './forms';
import { noteText } from '@/lib/crm/mutations';
import {
  APPOINTMENT_STATUSES,
  CLIENT_STATUSES,
  OPPORTUNITY_STAGES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Appointment,
  type Client,
  type Contact,
  type Note,
  type Opportunity,
  type Task
} from '@/lib/crm/types';

type Action = (formData: FormData) => void | Promise<void>;

function Hidden({ name, value }: { name: string; value?: string | null }) {
  return value ? <input type="hidden" name={name} value={value} /> : null;
}

// ---------------------------------------------------------------------------
export function ContactForm({
  action,
  leadId,
  returnTo,
  contact
}: {
  action: Action;
  leadId: string;
  returnTo: string;
  contact?: Contact;
}) {
  return (
    <form action={action} className="space-y-3">
      <Hidden name="id" value={contact?.id} />
      <input type="hidden" name="crm_lead_id" value={leadId} />
      <ReturnTo path={returnTo} />

      <FormGrid>
        <TextField name="first_name" label="First name" defaultValue={contact?.first_name} />
        <TextField name="last_name" label="Last name" defaultValue={contact?.last_name} />
        <TextField
          name="job_title"
          label="Job title"
          defaultValue={contact?.job_title}
          placeholder="Practice Manager"
        />
        <TextField name="email" label="Email" type="email" defaultValue={contact?.email} />
        <TextField name="phone" label="Phone" type="tel" defaultValue={contact?.phone} />
      </FormGrid>

      <CheckboxField
        name="is_primary"
        label="Primary contact"
        defaultChecked={contact?.is_primary}
        hint="Promoting someone demotes the current primary — a lead can only have one."
      />
      <CheckboxField
        name="is_decision_maker"
        label="Decision maker"
        defaultChecked={contact?.is_decision_maker}
      />

      <SubmitButton>{contact ? 'Save contact' : 'Add contact'}</SubmitButton>
    </form>
  );
}

// ---------------------------------------------------------------------------
export function TaskForm({
  action,
  returnTo,
  task,
  leadId,
  clientId,
  people
}: {
  action: Action;
  returnTo: string;
  task?: Task;
  leadId?: string;
  clientId?: string;
  people: Option[];
}) {
  return (
    <form action={action} className="space-y-3">
      <Hidden name="id" value={task?.id} />
      <Hidden name="crm_lead_id" value={task?.crm_lead_id ?? leadId} />
      <Hidden name="client_id" value={task?.client_id ?? clientId} />
      <ReturnTo path={returnTo} />

      <TextField
        name="title"
        label="Task"
        required
        defaultValue={task?.title}
        placeholder="Call the practice manager"
      />
      <TextAreaField name="description" label="Detail" rows={2} defaultValue={task?.description} />

      <FormGrid>
        <TextField
          name="due_at"
          label="Due"
          type="datetime-local"
          hint="(UK time)"
          defaultValue={toLocalInput(task?.due_at)}
        />
        <SelectField
          name="priority"
          label="Priority"
          options={optionsFrom(TASK_PRIORITIES)}
          defaultValue={task?.priority ?? 'normal'}
        />
        <SelectField
          name="status"
          label="Status"
          options={optionsFrom(TASK_STATUSES)}
          defaultValue={task?.status ?? 'pending'}
        />
        <SelectField
          name="assigned_to"
          label="Assigned to"
          options={people}
          placeholder="Nobody"
          defaultValue={task?.assigned_to}
        />
      </FormGrid>

      <SubmitButton>{task ? 'Save task' : 'Add task'}</SubmitButton>
    </form>
  );
}

// ---------------------------------------------------------------------------
export function AppointmentForm({
  action,
  returnTo,
  appointment,
  leadId,
  contacts = []
}: {
  action: Action;
  returnTo: string;
  appointment?: Appointment;
  leadId?: string;
  contacts?: Option[];
}) {
  const zone = appointment?.timezone ?? 'Europe/London';
  return (
    <form action={action} className="space-y-3">
      <Hidden name="id" value={appointment?.id} />
      <Hidden name="crm_lead_id" value={appointment?.crm_lead_id ?? leadId} />
      <ReturnTo path={returnTo} />

      <TextField
        name="title"
        label="Title"
        required
        defaultValue={appointment?.title}
        placeholder="Discovery call"
      />

      <FormGrid>
        <TextField
          name="starts_at"
          label="Starts"
          type="datetime-local"
          required
          defaultValue={toLocalInput(appointment?.starts_at, zone)}
        />
        <TextField
          name="ends_at"
          label="Ends"
          type="datetime-local"
          defaultValue={toLocalInput(appointment?.ends_at, zone)}
        />
        <TextField
          name="timezone"
          label="Time zone"
          hint="(IANA name)"
          defaultValue={zone}
          placeholder="Europe/London"
        />
        <SelectField
          name="status"
          label="Status"
          options={optionsFrom(APPOINTMENT_STATUSES)}
          defaultValue={appointment?.status ?? 'scheduled'}
        />
        {contacts.length ? (
          <SelectField
            name="contact_id"
            label="With"
            options={contacts}
            placeholder="Not specified"
            defaultValue={appointment?.contact_id}
          />
        ) : null}
      </FormGrid>

      <TextAreaField
        name="meeting_notes"
        label="Notes"
        rows={2}
        defaultValue={appointment?.meeting_notes}
      />
      <TextField name="outcome" label="Outcome" defaultValue={appointment?.outcome} />

      <SubmitButton>{appointment ? 'Save appointment' : 'Book appointment'}</SubmitButton>
    </form>
  );
}

// ---------------------------------------------------------------------------
export function OpportunityForm({
  action,
  returnTo,
  opportunity,
  leadId,
  leads,
  people,
  contacts = []
}: {
  action: Action;
  returnTo: string;
  opportunity?: Opportunity;
  leadId?: string;
  /** Only needed when creating from a page that is not a lead. */
  leads?: Option[];
  people: Option[];
  contacts?: Option[];
}) {
  const fixedLead = opportunity?.crm_lead_id ?? leadId;
  return (
    <form action={action} className="space-y-3">
      <Hidden name="id" value={opportunity?.id} />
      {fixedLead ? <input type="hidden" name="crm_lead_id" value={fixedLead} /> : null}
      <ReturnTo path={returnTo} />

      {!fixedLead && leads ? (
        <SelectField name="crm_lead_id" label="Lead" options={leads} placeholder="Choose a lead" />
      ) : null}

      <TextField
        name="name"
        label="Opportunity"
        required
        defaultValue={opportunity?.name}
        placeholder="Invisalign landing page + Google Ads"
      />

      <FormGrid>
        <SelectField
          name="stage"
          label="Stage"
          options={optionsFrom(OPPORTUNITY_STAGES)}
          defaultValue={opportunity?.stage ?? 'discovery'}
        />
        <TextField
          name="service_name"
          label="Service"
          defaultValue={opportunity?.service_name}
          placeholder="Google Ads management"
        />
        <TextField
          name="monthly_value"
          label="Monthly value"
          type="number"
          hint="(£)"
          defaultValue={opportunity?.monthly_value?.toString()}
        />
        <TextField
          name="setup_fee"
          label="Setup fee"
          type="number"
          hint="(£)"
          defaultValue={opportunity?.setup_fee?.toString()}
        />
        <TextField
          name="one_time_value"
          label="One-off value"
          type="number"
          hint="(£)"
          defaultValue={opportunity?.one_time_value?.toString()}
        />
        <TextField
          name="contract_months"
          label="Contract length"
          type="number"
          hint="(months)"
          defaultValue={opportunity?.contract_months?.toString()}
        />
        <TextField
          name="probability"
          label="Probability"
          type="number"
          hint="(0–100)"
          defaultValue={opportunity?.probability?.toString()}
        />
        <TextField
          name="expected_close_date"
          label="Expected close"
          type="date"
          defaultValue={toDateInput(opportunity?.expected_close_date)}
        />
        <SelectField
          name="owner_id"
          label="Owner"
          options={people}
          placeholder="Unassigned"
          defaultValue={opportunity?.owner_id}
        />
        {contacts.length ? (
          <SelectField
            name="contact_id"
            label="Contact"
            options={contacts}
            placeholder="Not specified"
            defaultValue={opportunity?.contact_id}
          />
        ) : null}
      </FormGrid>

      <Disclosure summary="Discovery notes">
        <div className="space-y-3">
          <TextAreaField
            name="pain_points"
            label="Pain points"
            rows={2}
            defaultValue={opportunity?.pain_points}
          />
          <TextAreaField
            name="desired_outcome"
            label="Desired outcome"
            rows={2}
            defaultValue={opportunity?.desired_outcome}
          />
          <FormGrid>
            <TextField name="budget" label="Budget" defaultValue={opportunity?.budget} />
            <TextField name="next_action" label="Next action" defaultValue={opportunity?.next_action} />
          </FormGrid>
          <TextAreaField
            name="objections"
            label="Objections"
            rows={2}
            defaultValue={opportunity?.objections}
          />
          <TextField
            name="loss_reason"
            label="Loss reason"
            hint="(if lost)"
            defaultValue={opportunity?.loss_reason}
          />
        </div>
      </Disclosure>

      <SubmitButton>{opportunity ? 'Save opportunity' : 'Create opportunity'}</SubmitButton>
    </form>
  );
}

// ---------------------------------------------------------------------------
export function ClientForm({
  action,
  returnTo,
  record,
  people,
  leads,
  opportunities = [],
  defaults
}: {
  action: Action;
  returnTo: string;
  record?: Client;
  people: Option[];
  leads?: Option[];
  opportunities?: Option[];
  /** Prefill when converting a won opportunity into an account. */
  defaults?: { company_name?: string; crm_lead_id?: string; opportunity_id?: string };
}) {
  return (
    <form action={action} className="space-y-3">
      <Hidden name="id" value={record?.id} />
      <ReturnTo path={returnTo} />

      <TextField
        name="company_name"
        label="Company name"
        required
        defaultValue={record?.company_name ?? defaults?.company_name}
      />

      <FormGrid>
        <SelectField
          name="status"
          label="Status"
          options={optionsFrom(CLIENT_STATUSES)}
          defaultValue={record?.status ?? 'onboarding'}
        />
        <SelectField
          name="account_owner"
          label="Account owner"
          options={people}
          placeholder="Unassigned"
          defaultValue={record?.account_owner}
        />
        <TextField
          name="start_date"
          label="Start date"
          type="date"
          defaultValue={toDateInput(record?.start_date)}
        />
        <TextField
          name="renewal_date"
          label="Renewal date"
          type="date"
          defaultValue={toDateInput(record?.renewal_date)}
        />
        {leads ? (
          <SelectField
            name="crm_lead_id"
            label="From lead"
            options={leads}
            placeholder="Not linked"
            defaultValue={record?.crm_lead_id ?? defaults?.crm_lead_id}
          />
        ) : (
          <Hidden name="crm_lead_id" value={record?.crm_lead_id ?? defaults?.crm_lead_id} />
        )}
        {opportunities.length ? (
          <SelectField
            name="opportunity_id"
            label="From opportunity"
            options={opportunities}
            placeholder="Not linked"
            defaultValue={record?.opportunity_id ?? defaults?.opportunity_id}
          />
        ) : (
          <Hidden name="opportunity_id" value={record?.opportunity_id ?? defaults?.opportunity_id} />
        )}
      </FormGrid>

      <SubmitButton>{record ? 'Save client' : 'Create client'}</SubmitButton>
    </form>
  );
}

// ---------------------------------------------------------------------------
export function NoteForm({
  action,
  returnTo,
  note,
  leadId,
  clientId
}: {
  action: Action;
  returnTo: string;
  note?: Note;
  leadId?: string;
  clientId?: string;
}) {
  return (
    <form action={action} className="space-y-3">
      <Hidden name="id" value={note?.id} />
      <Hidden name="crm_lead_id" value={note?.crm_lead_id ?? leadId} />
      <Hidden name="client_id" value={note?.client_id ?? clientId} />
      <ReturnTo path={returnTo} />

      <TextField name="title" label="Title" defaultValue={note?.title} placeholder="Optional" />
      <TextAreaField
        name="text"
        label="Note"
        rows={4}
        required
        defaultValue={note ? noteText(note) : ''}
        placeholder="What you want to remember about this account."
      />
      <SubmitButton>{note ? 'Save note' : 'Add note'}</SubmitButton>
    </form>
  );
}
