/**
 * Forms for the four sales transitions, plus the call outcome.
 *
 * Kept apart from `entityForms.tsx` because they are a different kind of
 * thing. Those edit one record's fields; each of these commits a decision that
 * changes several records at once and is awkward to undo. That shows in the
 * copy: every one says plainly what it is about to do before you press it.
 *
 * Server components, no client JavaScript, same as the rest.
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
  toLocalInput,
  type Option
} from './forms';
import { formatMoney } from '@/lib/crm/format';
import { LEAD_CLOSE_STAGES } from '@/lib/crm/workflow';
import {
  CLIENT_STATUSES,
  CONTRACT_STATUSES,
  OPPORTUNITY_STAGES,
  PIPELINE_STAGE_LABELS,
  type Contact,
  type Opportunity,
  type Proposal
} from '@/lib/crm/types';

type Action = (formData: FormData) => void | Promise<void>;

function Hidden({ name, value }: { name: string; value?: string | null }) {
  return value ? <input type="hidden" name={name} value={value} /> : null;
}

/** The one-line explanation of what pressing the button will do. */
function Consequence({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-line-soft bg-white/[0.02] px-3 py-2 text-xs leading-relaxed text-white/50">
      {children}
    </p>
  );
}

export function contactOptions(contacts: Contact[]): Option[] {
  return contacts.map((contact) => ({
    value: contact.id,
    label: contact.job_title
      ? `${contact.full_name ?? 'Unnamed'} — ${contact.job_title}`
      : contact.full_name ?? 'Unnamed'
  }));
}

// ---------------------------------------------------------------------------
// Lead → Opportunity
// ---------------------------------------------------------------------------

/**
 * Everything the discovery call established, captured once.
 *
 * The qualitative fields are not optional decoration: pain points and desired
 * outcome are what the proposal is written from, and a deal opened without
 * them means writing the proposal from memory a fortnight later.
 */
export function ConvertLeadForm({
  action,
  leadId,
  returnTo,
  companyName,
  contacts = [],
  people,
  defaults
}: {
  action: Action;
  leadId: string;
  returnTo: string;
  companyName: string;
  contacts?: Option[];
  people: Option[];
  /** Prefilled from the pipeline's recommendation, so the common case is one click. */
  defaults?: { name?: string | null; service_name?: string | null };
}) {
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="crm_lead_id" value={leadId} />
      <ReturnTo path={returnTo} />

      <Consequence>
        Opens a deal against {companyName} and moves the lead to{' '}
        <strong className="text-white/70">{PIPELINE_STAGE_LABELS.sales_call}</strong> — or further,
        if you pick a later stage. The lead is never moved backwards.
      </Consequence>

      <TextField
        name="name"
        label="Opportunity"
        required
        defaultValue={defaults?.name ?? `${companyName} — ${defaults?.service_name ?? 'growth retainer'}`}
      />

      <FormGrid>
        <SelectField
          name="stage"
          label="Stage"
          options={optionsFrom(OPPORTUNITY_STAGES.filter((stage) => stage !== 'won' && stage !== 'lost'))}
          defaultValue="discovery"
        />
        <TextField
          name="service_name"
          label="Service"
          defaultValue={defaults?.service_name}
          placeholder="Google Ads management"
        />
        {contacts.length > 0 ? (
          <SelectField
            name="contact_id"
            label="Contact"
            options={contacts}
            placeholder="No contact yet"
          />
        ) : null}
        <SelectField name="owner_id" label="Owner" options={people} placeholder="Me" />
        <TextField name="monthly_value" label="Monthly value" type="number" hint="(£)" />
        <TextField name="setup_fee" label="Setup fee" type="number" hint="(£)" />
        <TextField name="one_time_value" label="One-off value" type="number" hint="(£)" />
        <TextField name="contract_months" label="Contract length" type="number" hint="(months)" />
        <TextField
          name="probability"
          label="Probability"
          type="number"
          hint="(0–100)"
          defaultValue="30"
        />
        <TextField name="expected_close_date" label="Expected close" type="date" />
      </FormGrid>

      <TextAreaField
        name="pain_points"
        label="Pain points"
        rows={2}
        placeholder="What is costing them money right now, in their words"
      />
      <TextAreaField
        name="desired_outcome"
        label="Desired outcome"
        rows={2}
        placeholder="What they said success looks like"
      />
      <FormGrid>
        <TextField name="budget" label="Budget" placeholder="£1–2k/month, flexible for the right result" />
        <TextField name="next_action" label="Next action" placeholder="Send the proposal" />
      </FormGrid>
      <TextAreaField name="objections" label="Objections" rows={2} />
      <TextAreaField name="note" label="Note for the timeline" rows={2} />

      <SubmitButton>Open the opportunity</SubmitButton>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Sales call outcome
// ---------------------------------------------------------------------------

/**
 * Notes, follow-up and task in one submit.
 *
 * Separate forms would let you save the notes and lose the follow-up, which is
 * the exact failure a follow-up exists to prevent — so the database writes all
 * three in one transaction and this collects them together.
 */
export function CallOutcomeForm({
  action,
  leadId,
  returnTo,
  contacts = [],
  opportunities = []
}: {
  action: Action;
  leadId: string;
  returnTo: string;
  contacts?: Option[];
  opportunities?: Option[];
}) {
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="crm_lead_id" value={leadId} />
      <ReturnTo path={returnTo} />

      <TextAreaField
        name="summary"
        label="What was said"
        rows={7}
        required
        placeholder={
          'Who you spoke to, what they are struggling with, numbers they quoted, ' +
          'who else has to sign off, and what you agreed to do next.'
        }
      />

      <FormGrid>
        <TextField name="outcome" label="Outcome" placeholder="Proposal requested" />
        <TextField
          name="occurred_at"
          label="Call time"
          type="datetime-local"
          hint="(blank = now)"
        />
        {contacts.length > 0 ? (
          <SelectField
            name="contact_id"
            label="Spoke to"
            options={contacts}
            placeholder="Not recorded"
          />
        ) : null}
        {opportunities.length > 0 ? (
          <SelectField
            name="opportunity_id"
            label="Deal"
            options={opportunities}
            placeholder="No deal yet"
          />
        ) : null}
      </FormGrid>

      <div className="rounded-lg border border-line-soft p-3">
        <p className="label-mono mb-2 text-white/40">Follow-up</p>
        <FormGrid>
          <TextField name="next_action" label="Next action" placeholder="Send the proposal" />
          <TextField name="next_action_at" label="By" type="datetime-local" />
          <TextField name="task_title" label="Task for me" placeholder="Draft the proposal" />
          <TextField name="task_due_at" label="Task due" type="datetime-local" />
        </FormGrid>
        <p className="mt-2 text-xs text-white/35">
          The next action is written onto the lead and the deal together, so the two cannot
          disagree. A task title creates an open task assigned to you.
        </p>
      </div>

      <SubmitButton>Save the call</SubmitButton>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Proposal sent
// ---------------------------------------------------------------------------
export function SendProposalForm({
  action,
  proposal,
  returnTo,
  leadId
}: {
  action: Action;
  proposal: Proposal;
  returnTo: string;
  leadId?: string;
}) {
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="id" value={proposal.id} />
      <Hidden name="crm_lead_id" value={leadId} />
      <ReturnTo path={returnTo} />

      <Consequence>
        Records that v{proposal.version} went out and moves the deal and the lead to{' '}
        <strong className="text-white/70">proposal</strong>. Nothing is sent — send the document
        yourself, then mark it here.
        {proposal.sent_at ? ' The original sent date is kept.' : ''}
      </Consequence>

      <TextField
        name="sent_at"
        label="Sent at"
        type="datetime-local"
        hint="(blank = now)"
        defaultValue={toLocalInput(proposal.sent_at)}
      />
      <TextAreaField name="note" label="Note" rows={2} placeholder="Emailed to the practice manager" />

      <SubmitButton>Mark as sent</SubmitButton>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Won → Client
// ---------------------------------------------------------------------------

/**
 * One submit creates the account, optionally the signed contract, closes the
 * deal and moves the lead — as a single transaction, so a won deal can never
 * end up with no client behind it.
 */
export function WinDealForm({
  action,
  opportunity,
  returnTo,
  companyName,
  people
}: {
  action: Action;
  opportunity: Opportunity;
  returnTo: string;
  companyName: string;
  people: Option[];
}) {
  const monthly = opportunity.monthly_value;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="id" value={opportunity.id} />
      <input type="hidden" name="crm_lead_id" value={opportunity.crm_lead_id} />
      <ReturnTo path={returnTo} />

      <Consequence>
        Marks <strong className="text-white/70">{opportunity.name}</strong> won, creates a client
        account, and moves the lead to won — all together, so there is no window where one exists
        without the other. Submitting twice is safe: it returns the same account.
      </Consequence>

      <TextField
        name="company_name"
        label="Account name"
        defaultValue={companyName}
        hint="(as it should appear on invoices)"
      />

      <FormGrid>
        <SelectField
          name="client_status"
          label="Status"
          options={optionsFrom(CLIENT_STATUSES)}
          defaultValue="onboarding"
        />
        <SelectField name="account_owner" label="Account owner" options={people} placeholder="Me" />
        <TextField name="start_date" label="Start date" type="date" hint="(blank = today)" />
        <TextField name="renewal_date" label="Renewal date" type="date" />
      </FormGrid>

      <Disclosure summary="Add the contract now">
        <div className="space-y-3 rounded-lg border border-line-soft p-3">
          <CheckboxField
            name="create_contract"
            label="Create a contract with this account"
            hint="Leave off if it is not signed yet — you can add it from the client page later."
          />
          <FormGrid>
            <SelectField
              name="contract_status"
              label="Contract status"
              options={optionsFrom(CONTRACT_STATUSES)}
              defaultValue="signed"
            />
            <TextField name="contract_start_date" label="Contract start" type="date" />
            <TextField name="contract_end_date" label="Contract end" type="date" />
            <TextField
              name="contract_monthly_value"
              label="Monthly value"
              type="number"
              hint={monthly === null ? '(£)' : `(£, deal says ${formatMoney(monthly)})`}
            />
            <TextField name="contract_setup_fee" label="Setup fee" type="number" hint="(£)" />
            <TextField
              name="contract_document_url"
              label="Signed document"
              type="url"
              placeholder="https://…"
            />
          </FormGrid>
          <p className="text-xs text-white/35">
            Left blank, the monthly value and setup fee come from the deal. Draft and sent
            contracts are not stamped as signed.
          </p>
        </div>
      </Disclosure>

      <TextAreaField name="note" label="Note for the timeline" rows={2} />

      <SubmitButton>Mark won and create the account</SubmitButton>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Lost
// ---------------------------------------------------------------------------

/**
 * The reason is required, by the database as well as the form. A pipeline
 * report full of unexplained losses is a report nobody can act on.
 */
export function LoseDealForm({
  action,
  opportunity,
  returnTo,
  otherOpenDeals
}: {
  action: Action;
  opportunity: Opportunity;
  returnTo: string;
  /** How many other deals on this lead are still live. */
  otherOpenDeals: number;
}) {
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="id" value={opportunity.id} />
      <input type="hidden" name="crm_lead_id" value={opportunity.crm_lead_id} />
      <ReturnTo path={returnTo} />

      <Consequence>
        Closes <strong className="text-white/70">{opportunity.name}</strong> as lost. The deal stays
        on the lead&rsquo;s record — losses are the most useful thing in a pipeline report.
      </Consequence>

      <TextField
        name="loss_reason"
        label="Why was it lost"
        required
        placeholder="Went with a cheaper agency"
      />
      <TextAreaField name="note" label="Detail" rows={2} />

      <div className="rounded-lg border border-line-soft p-3">
        <CheckboxField
          name="close_lead"
          label="Close the lead too"
          hint={
            otherOpenDeals > 0
              ? `This lead has ${otherOpenDeals} other live deal${otherOpenDeals === 1 ? '' : 's'}, so it will stay open regardless.`
              : 'The lead stops appearing on the board and in open-pipeline totals.'
          }
        />
        <div className="mt-2">
          <SelectField
            name="lead_stage"
            label="Close it as"
            options={optionsFrom(LEAD_CLOSE_STAGES, PIPELINE_STAGE_LABELS)}
            defaultValue="lost"
          />
        </div>
      </div>

      <SubmitButton tone="danger">Mark the deal lost</SubmitButton>
    </form>
  );
}
