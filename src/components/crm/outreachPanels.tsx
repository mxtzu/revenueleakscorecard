/**
 * Outreach console panels.
 *
 * The tone here is deliberate. This is the only part of the CRM that contacts
 * strangers, so every control says what it will do before it does it, and the
 * page is honest about whether sending is on. A switch whose state you have to
 * infer from an empty log is the wrong design for something that sends email
 * on your behalf.
 */

import { Badge, Card, Cell, Row } from './ui';
import {
  CheckboxField,
  FormGrid,
  ReturnTo,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  optionsFrom
} from './forms';
import { formatDateTime, formatRelative, humanise } from '@/lib/crm/format';
import type { OutreachSettings } from '@/lib/outreach/gate';
import type {
  EnrolmentRecord,
  OutreachMessageRecord,
  SuppressionRecord
} from '@/lib/outreach/queries';

type Action = (formData: FormData) => void | Promise<void>;

const MESSAGE_TONE: Record<string, 'neutral' | 'positive' | 'warning' | 'danger'> = {
  queued: 'neutral',
  sent: 'positive',
  delivered: 'positive',
  opened: 'positive',
  clicked: 'positive',
  bounced: 'danger',
  complained: 'danger',
  failed: 'danger',
  skipped: 'warning'
};

const ENROLMENT_TONE: Record<string, 'neutral' | 'positive' | 'warning' | 'danger'> = {
  not_started: 'neutral',
  active: 'positive',
  paused: 'warning',
  completed: 'neutral',
  stopped: 'neutral',
  replied: 'positive'
};

/**
 * The state of the engine, at the top of the page.
 *
 * Four things anyone about to press a button needs to know: whether sending is
 * on at all, whether the providers exist, how much of today's allowance is
 * left, and when the window is open.
 */
export function SendingStatus({
  settings,
  emailConfigured,
  smsConfigured,
  sentToday,
  isAdminUser,
  runAction
}: {
  settings: OutreachSettings | null;
  emailConfigured: boolean;
  smsConfigured: boolean;
  sentToday: number;
  isAdminUser: boolean;
  runAction: Action;
}) {
  if (!settings) {
    return (
      <Card title="Sending" className="mb-4">
        <p className="text-sm text-white/55">
          Outreach settings are missing. Re-apply{' '}
          <span className="font-mono">20260821_outreach_engine.sql</span>.
        </p>
      </Card>
    );
  }

  const on = settings.sending_enabled;
  const remaining = Math.max(0, settings.daily_send_limit - sentToday);

  return (
    <Card title="Sending" className="mb-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={on ? 'positive' : 'neutral'}>{on ? 'Sending is ON' : 'Sending is off'}</Badge>
        <span className="text-sm text-white/55">
          {on
            ? `${sentToday} of ${settings.daily_send_limit} sent today · ${remaining} left`
            : 'Nothing will be sent to anybody until this is switched on.'}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-white/40 sm:grid-cols-2">
        <p>
          Window: {String(settings.send_window_start).padStart(2, '0')}:00–
          {String(settings.send_window_end).padStart(2, '0')}:00 {settings.timezone}
          {settings.send_on_weekends ? ', including weekends' : ', weekdays only'}
        </p>
        <p>
          Email:{' '}
          {emailConfigured ? (
            <span className="text-white/60">{settings.from_email ?? 'no from address set'}</span>
          ) : (
            <span className="text-amber-300/80">no provider configured</span>
          )}
          {' · '}SMS:{' '}
          {smsConfigured ? (
            <span className="text-white/60">{settings.sms_from_number ?? 'no number set'}</span>
          ) : (
            <span className="text-white/30">not configured</span>
          )}
        </p>
      </div>

      {isAdminUser && on ? (
        <form action={runAction} className="mt-3">
          <ReturnTo path="/outreach" />
          <SubmitButton tone="quiet">Run the engine now</SubmitButton>
        </form>
      ) : null}
    </Card>
  );
}

/** The settings form. Admin-only; the page hides it from everyone else. */
export function OutreachSettingsForm({
  action,
  settings
}: {
  action: Action;
  settings: OutreachSettings;
}) {
  return (
    <form action={action} className="space-y-3">
      <ReturnTo path="/outreach" />

      <div className="rounded-lg border border-amber-400/25 bg-amber-400/5 p-3">
        <CheckboxField
          name="sending_enabled"
          label="Send messages to leads"
          defaultChecked={settings.sending_enabled}
          hint="With this off, the engine runs and records what it would have done without contacting anybody. Leave it off until the templates have been read by a person."
        />
      </div>

      <FormGrid>
        <TextField name="from_name" label="From name" defaultValue={settings.from_name} />
        <TextField
          name="from_email"
          label="From address"
          type="email"
          defaultValue={settings.from_email}
          hint="(must be a verified sending domain)"
        />
        <TextField
          name="reply_to_email"
          label="Reply-to"
          type="email"
          defaultValue={settings.reply_to_email}
          hint="(where replies land)"
        />
        <TextField
          name="sms_from_number"
          label="SMS from number"
          defaultValue={settings.sms_from_number}
          placeholder="+447700900000"
        />
      </FormGrid>

      <TextAreaField
        name="postal_address"
        label="Postal address"
        rows={2}
        defaultValue={settings.postal_address}
        placeholder="1 Example Street, Sunderland SR1 1AA"
      />
      <p className="text-xs text-white/35">
        Appears in the footer of every email with the unsubscribe link. UK marketing email has to
        identify who sent it.
      </p>

      <FormGrid>
        <TextField
          name="daily_send_limit"
          label="Daily limit"
          type="number"
          defaultValue={String(settings.daily_send_limit)}
        />
        <TextField
          name="per_run_limit"
          label="Per run"
          type="number"
          defaultValue={String(settings.per_run_limit)}
        />
        <TextField
          name="send_window_start"
          label="Window opens"
          type="number"
          hint="(hour, 0–23)"
          defaultValue={String(settings.send_window_start)}
        />
        <TextField
          name="send_window_end"
          label="Window closes"
          type="number"
          hint="(hour, 1–24)"
          defaultValue={String(settings.send_window_end)}
        />
        <TextField name="timezone" label="Time zone" defaultValue={settings.timezone} />
      </FormGrid>

      <CheckboxField
        name="send_on_weekends"
        label="Send at weekends"
        defaultChecked={settings.send_on_weekends}
        hint="Off by default. A Saturday morning cold email is not read favourably."
      />

      <SubmitButton>Save sending settings</SubmitButton>
    </form>
  );
}

export function EnrolmentRow({
  enrolment,
  leadName,
  sequenceName,
  writable,
  returnTo,
  onSetStatus
}: {
  enrolment: EnrolmentRecord;
  leadName: string;
  sequenceName: string;
  writable: boolean;
  returnTo: string;
  onSetStatus: Action;
}) {
  const live = enrolment.status === 'active';
  const paused = enrolment.status === 'paused';

  return (
    <Row>
      <Cell className="text-white/80">{leadName}</Cell>
      <Cell className="text-white/55">{sequenceName}</Cell>
      <Cell>
        <Badge tone={ENROLMENT_TONE[enrolment.status] ?? 'neutral'}>
          {humanise(enrolment.status)}
        </Badge>
        {enrolment.stop_reason ? (
          <span className="mt-1 block text-[11px] text-white/35">{enrolment.stop_reason}</span>
        ) : null}
      </Cell>
      <Cell className="text-white/50">Step {enrolment.current_step}</Cell>
      <Cell className="whitespace-nowrap text-white/45">
        {live && enrolment.next_step_at ? formatRelative(enrolment.next_step_at) : '—'}
      </Cell>
      <Cell>
        {writable && (live || paused) ? (
          <div className="flex flex-wrap gap-1.5">
            <form action={onSetStatus}>
              <input type="hidden" name="id" value={enrolment.id} />
              <input type="hidden" name="crm_lead_id" value={enrolment.crm_lead_id} />
              <input type="hidden" name="status" value={live ? 'paused' : 'active'} />
              <ReturnTo path={returnTo} />
              <button
                type="submit"
                className="rounded-lg border border-line px-2 py-0.5 text-[11px] text-white/60 hover:border-electric-500/50 hover:text-white/90"
              >
                {live ? 'Pause' : 'Resume'}
              </button>
            </form>
            <form action={onSetStatus}>
              <input type="hidden" name="id" value={enrolment.id} />
              <input type="hidden" name="crm_lead_id" value={enrolment.crm_lead_id} />
              <input type="hidden" name="status" value="stopped" />
              <ReturnTo path={returnTo} />
              <button
                type="submit"
                className="rounded-lg border border-rose-400/30 px-2 py-0.5 text-[11px] text-rose-200/80 hover:bg-rose-400/10"
              >
                Stop
              </button>
            </form>
          </div>
        ) : null}
      </Cell>
    </Row>
  );
}

export function MessageRow({
  message,
  leadName
}: {
  message: OutreachMessageRecord;
  leadName: string;
}) {
  return (
    <Row>
      <Cell className="whitespace-nowrap text-white/40">
        {formatDateTime(message.sent_at ?? message.created_at)}
      </Cell>
      <Cell className="text-white/70">{leadName}</Cell>
      <Cell className="text-white/45">{humanise(message.channel)}</Cell>
      <Cell className="text-white/50">{message.step_number ?? '—'}</Cell>
      <Cell>
        <Badge tone={MESSAGE_TONE[message.status] ?? 'neutral'}>{humanise(message.status)}</Badge>
      </Cell>
      <Cell className="max-w-[26rem] text-white/55">
        <span className="block truncate">{message.subject ?? message.to_phone ?? '—'}</span>
        {/* The reason a send did not happen is the useful half of this table. */}
        {message.skip_reason ? (
          <span className="block text-[11px] text-amber-200/70">{message.skip_reason}</span>
        ) : null}
        {message.error ? (
          <span className="block text-[11px] text-rose-200/70">{message.error}</span>
        ) : null}
      </Cell>
    </Row>
  );
}

export function SuppressionRow({
  entry,
  deletable,
  returnTo,
  onRemove
}: {
  entry: SuppressionRecord;
  deletable: boolean;
  returnTo: string;
  onRemove: Action;
}) {
  return (
    <Row>
      <Cell className="text-white/80">{entry.email ?? entry.phone}</Cell>
      <Cell>
        <Badge tone={entry.reason === 'manual' ? 'neutral' : 'warning'}>
          {humanise(entry.reason)}
        </Badge>
      </Cell>
      <Cell className="text-white/40">{entry.source ?? '—'}</Cell>
      <Cell className="whitespace-nowrap text-white/40">{formatDateTime(entry.created_at)}</Cell>
      <Cell>
        {deletable ? (
          <form action={onRemove}>
            <input type="hidden" name="id" value={entry.id} />
            <ReturnTo path={returnTo} />
            {/* Admin-only: removing an entry is what puts an address back in
                the send path. */}
            <button
              type="submit"
              className="text-[11px] text-white/35 hover:text-rose-200"
            >
              Remove
            </button>
          </form>
        ) : null}
      </Cell>
    </Row>
  );
}

export function SuppressForm({ action, returnTo }: { action: Action; returnTo: string }) {
  return (
    <form action={action} className="space-y-3">
      <ReturnTo path={returnTo} />
      <FormGrid>
        <TextField name="email" label="Email address" type="email" />
        <TextField name="phone" label="Phone number" />
        <SelectField
          name="reason"
          label="Reason"
          options={optionsFrom(['manual', 'unsubscribed', 'bounced', 'complained', 'invalid'])}
          defaultValue="manual"
        />
      </FormGrid>
      <TextField name="notes" label="Note" placeholder="Asked to be removed on the phone" />
      <SubmitButton>Add to the do-not-contact list</SubmitButton>
    </form>
  );
}

/** Enrol one lead, from the lead page. */
export function EnrolForm({
  action,
  leadId,
  returnTo,
  sequences,
  contacts,
  sendingEnabled
}: {
  action: Action;
  leadId: string;
  returnTo: string;
  sequences: { value: string; label: string }[];
  contacts: { value: string; label: string }[];
  sendingEnabled: boolean;
}) {
  if (sequences.length === 0) {
    return (
      <p className="text-xs text-white/40">
        No active sequences yet. Build one on the outreach page first.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="crm_lead_id" value={leadId} />
      <ReturnTo path={returnTo} />

      <p className="rounded-lg border border-line-soft bg-white/[0.02] px-3 py-2 text-xs leading-relaxed text-white/50">
        {sendingEnabled
          ? 'The first step goes out on the next run, inside the sending window. Every email carries an unsubscribe link, and a reply stops the sequence automatically.'
          : 'Sending is currently switched off, so this will queue and go nowhere until an admin turns it on.'}
      </p>

      <SelectField name="sequence_id" label="Sequence" options={sequences} />
      {contacts.length > 0 ? (
        <SelectField
          name="contact_id"
          label="Write to"
          options={contacts}
          placeholder="Use the published business address"
        />
      ) : null}

      <SubmitButton>Enrol this lead</SubmitButton>
    </form>
  );
}
