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
  Label,
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
  CONTRACT_STATUSES,
  OPPORTUNITY_STAGES,
  OUTREACH_CHANNELS,
  PROPOSAL_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Appointment,
  type Client,
  type Contact,
  type Contract,
  type Note,
  type Opportunity,
  type OutreachSequence,
  type OutreachStep,
  type Proposal,
  type Task
} from '@/lib/crm/types';

type Action = (formData: FormData) => void | Promise<void>;

/** Open the calendar section straight away when it already holds something. */
function hasCalendarDetail(appointment?: Appointment): boolean {
  return Boolean(
    appointment &&
      ((appointment.attendee_emails?.length ?? 0) > 0 ||
        appointment.conference_requested ||
        appointment.google_meet_url)
  );
}

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
  contacts = [],
  calendarConnected = false
}: {
  action: Action;
  returnTo: string;
  appointment?: Appointment;
  leadId?: string;
  contacts?: Option[];
  /** Whether a Google calendar is connected, which decides what to offer. */
  calendarConnected?: boolean;
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

      <Disclosure summary="Attendees and meeting link" open={hasCalendarDetail(appointment)}>
        <div className="space-y-3 rounded-lg border border-line-soft p-3">
          {!calendarConnected ? (
            <p className="text-xs text-white/40">
              No Google calendar is connected, so these are recorded in the CRM only. Connect one
              on the calendar page to have the invitation created for you.
            </p>
          ) : null}

          <TextAreaField
            name="attendee_emails"
            label="Attendees"
            rows={2}
            defaultValue={appointment?.attendee_emails?.join(', ')}
            placeholder="owner@practice.co.uk, manager@practice.co.uk"
          />

          <CheckboxField
            name="conference_requested"
            label="Create a Google Meet link"
            defaultChecked={appointment?.conference_requested}
            hint={
              appointment?.google_meet_url
                ? 'Already created. The existing link is kept — editing never mints a second one.'
                : 'Google creates the link when the event syncs.'
            }
          />

          {/*
            Off by default, and said plainly. Ticking this makes Google email
            every attendee; leaving it alone means the event is created
            silently and you invite people yourself.
          */}
          <CheckboxField
            name="notify_attendees"
            label="Let Google email the attendees"
            defaultChecked={appointment?.notify_attendees}
            hint="Off by default. The CRM never emails anyone unless you choose this."
          />

          {appointment?.google_meet_url ? (
            <p className="break-all text-xs text-white/45">
              Meet link:{' '}
              <a
                href={appointment.google_meet_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-electric-300 hover:underline"
              >
                {appointment.google_meet_url}
              </a>
            </p>
          ) : null}
        </div>
      </Disclosure>

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

// ---------------------------------------------------------------------------
export function ContractForm({
  action,
  returnTo,
  clientId,
  contract
}: {
  action: Action;
  returnTo: string;
  clientId: string;
  contract?: Contract;
}) {
  return (
    <form action={action} className="space-y-3">
      <Hidden name="id" value={contract?.id} />
      <input type="hidden" name="client_id" value={clientId} />
      <ReturnTo path={returnTo} />

      <FormGrid>
        <SelectField
          name="status"
          label="Status"
          options={optionsFrom(CONTRACT_STATUSES)}
          defaultValue={contract?.status ?? 'draft'}
        />
        <TextField
          name="monthly_value"
          label="Monthly value"
          type="number"
          hint="(£)"
          defaultValue={contract?.monthly_value?.toString()}
        />
        <TextField
          name="setup_fee"
          label="Setup fee"
          type="number"
          hint="(£)"
          defaultValue={contract?.setup_fee?.toString()}
        />
        <TextField
          name="start_date"
          label="Start date"
          type="date"
          defaultValue={toDateInput(contract?.start_date)}
        />
        <TextField
          name="end_date"
          label="End date"
          type="date"
          defaultValue={toDateInput(contract?.end_date)}
        />
        <TextField
          name="document_url"
          label="Signed copy"
          type="url"
          hint="(link)"
          placeholder="https://…"
          defaultValue={contract?.document_url}
        />
      </FormGrid>

      <p className="text-xs text-white/35">
        The signature date follows the status — draft and sent clear it, anything further sets it.
      </p>
      <SubmitButton>{contract ? 'Save contract' : 'Add contract'}</SubmitButton>
    </form>
  );
}

// ---------------------------------------------------------------------------
export function ProposalForm({
  action,
  returnTo,
  opportunityId,
  proposal
}: {
  action: Action;
  returnTo: string;
  opportunityId: string;
  proposal?: Proposal;
}) {
  return (
    <form action={action} className="space-y-3">
      <Hidden name="id" value={proposal?.id} />
      <input type="hidden" name="opportunity_id" value={opportunityId} />
      <ReturnTo path={returnTo} />

      <TextField
        name="title"
        label="Title"
        defaultValue={proposal?.title}
        placeholder="Invisalign growth proposal"
      />

      <FormGrid>
        <SelectField
          name="status"
          label="Status"
          options={optionsFrom(PROPOSAL_STATUSES)}
          defaultValue={proposal?.status ?? 'draft'}
        />
        <TextField
          name="total_value"
          label="Total value"
          type="number"
          hint="(£)"
          defaultValue={proposal?.total_value?.toString()}
        />
        <TextField
          name="monthly_value"
          label="Monthly"
          type="number"
          hint="(£)"
          defaultValue={proposal?.monthly_value?.toString()}
        />
        <TextField
          name="setup_fee"
          label="Setup fee"
          type="number"
          hint="(£)"
          defaultValue={proposal?.setup_fee?.toString()}
        />
        <TextField
          name="valid_until"
          label="Valid until"
          type="date"
          defaultValue={toDateInput(proposal?.valid_until)}
        />
        <TextField
          name="document_url"
          label="Document"
          type="url"
          hint="(link)"
          placeholder="https://…"
          defaultValue={proposal?.document_url}
        />
      </FormGrid>

      <p className="text-xs text-white/35">
        {proposal
          ? `Version ${proposal.version}. Sent, viewed and accepted dates are stamped by the status and then kept.`
          : 'The version number is assigned automatically.'}
      </p>
      <SubmitButton>{proposal ? 'Save proposal' : 'Create proposal'}</SubmitButton>
    </form>
  );
}

// ---------------------------------------------------------------------------
export function DocumentUploadForm({
  action,
  returnTo,
  leadId,
  clientId
}: {
  action: Action;
  returnTo: string;
  leadId?: string;
  clientId?: string;
}) {
  return (
    <form action={action} encType="multipart/form-data" className="space-y-3">
      <Hidden name="crm_lead_id" value={leadId} />
      <Hidden name="client_id" value={clientId} />
      <ReturnTo path={returnTo} />

      <label className="block">
        <Label hint="(max 25 MB)">File</Label>
        <input
          type="file"
          name="file"
          required
          className="mt-1.5 w-full rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-white file:mr-3 file:rounded file:border-0 file:bg-white/10 file:px-3 file:py-1 file:text-xs file:text-white/80"
        />
      </label>
      <TextField name="name" label="Label" hint="(optional)" placeholder="Signed contract" />

      <p className="text-xs text-white/35">
        Stored in a private bucket and served through short-lived links. Executables, scripts and
        HTML are refused.
      </p>
      <SubmitButton>Upload</SubmitButton>
    </form>
  );
}

// ---------------------------------------------------------------------------
export function SequenceForm({
  action,
  returnTo,
  sequence
}: {
  action: Action;
  returnTo: string;
  sequence?: OutreachSequence;
}) {
  return (
    <form action={action} className="space-y-3">
      <Hidden name="id" value={sequence?.id} />
      <ReturnTo path={returnTo} />

      <TextField
        name="name"
        label="Sequence name"
        required
        defaultValue={sequence?.name}
        placeholder="Dental practices — first touch"
      />
      <TextAreaField
        name="description"
        label="Description"
        rows={2}
        defaultValue={sequence?.description}
        placeholder="Who this is for and what it is trying to achieve."
      />
      <CheckboxField
        name="active"
        label="Active"
        defaultChecked={sequence?.active ?? true}
        hint="Marks the sequence as current. Nothing is sent either way."
      />
      <SubmitButton>{sequence ? 'Save sequence' : 'Create sequence'}</SubmitButton>
    </form>
  );
}

export function StepForm({
  action,
  returnTo,
  sequenceId,
  step
}: {
  action: Action;
  returnTo: string;
  sequenceId: string;
  step?: OutreachStep;
}) {
  return (
    <form action={action} className="space-y-3">
      <Hidden name="id" value={step?.id} />
      <input type="hidden" name="sequence_id" value={sequenceId} />
      <ReturnTo path={returnTo} />

      <FormGrid>
        <SelectField
          name="channel"
          label="Channel"
          options={optionsFrom(OUTREACH_CHANNELS)}
          defaultValue={step?.channel ?? 'email'}
        />
        <TextField
          name="delay_minutes"
          label="Delay"
          type="number"
          hint="(minutes after the previous step)"
          defaultValue={step?.delay_minutes?.toString() ?? '0'}
        />
        {step ? (
          <TextField
            name="step_number"
            label="Step number"
            type="number"
            defaultValue={step.step_number.toString()}
          />
        ) : null}
      </FormGrid>

      <TextField
        name="subject_template"
        label="Subject"
        defaultValue={step?.subject_template}
        placeholder="Quick question about {{company_name}}"
      />
      <TextAreaField
        name="body_template"
        label="Body"
        rows={5}
        defaultValue={step?.body_template}
        placeholder="Write the message. Nothing in the CRM sends it."
      />
      <CheckboxField name="active" label="Active" defaultChecked={step?.active ?? true} />

      <SubmitButton>{step ? 'Save step' : 'Add step'}</SubmitButton>
    </form>
  );
}
