import { describe, expect, it } from 'vitest';

import {
  createAppointment,
  createContact,
  createNote,
  createOpportunity,
  createTask,
  noteText,
  setTaskStatus,
  updateContact,
  updateNote,
  updateOpportunity,
  updateTask
} from '../mutations';
import { RecordingClient } from './recordingClient';

const LEAD = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const CONTACT = '9c858901-8a57-4791-81fe-4c455b099bc9';

function contactInput(overrides: Record<string, unknown> = {}) {
  return {
    crm_lead_id: LEAD,
    first_name: 'Helen',
    last_name: 'Carter',
    full_name: 'Helen Carter',
    job_title: 'Managing Director',
    email: null,
    phone: null,
    is_primary: false,
    is_decision_maker: true,
    ...overrides
  } as Parameters<typeof createContact>[1];
}

/**
 * `contacts_one_primary_per_lead` is a unique partial index, so promoting a
 * contact while another holds the flag fails outright. The user asked for this
 * one to be primary; refusing on a technicality would make them do two steps to
 * express one intention.
 */
describe('primary contact', () => {
  it('demotes the incumbent before promoting a new one', async () => {
    const recorder = new RecordingClient([{ id: CONTACT }]);
    await createContact(recorder.client(), contactInput({ is_primary: true }));

    const [demote, insert] = recorder.queries;
    expect(demote.table).toBe('contacts');
    expect(demote.write).toBe('update');
    expect(demote.payload).toEqual({ is_primary: false });
    expect(demote.filters).toContainEqual({ op: 'eq', column: 'crm_lead_id', value: LEAD });
    expect(demote.filters).toContainEqual({ op: 'eq', column: 'is_primary', value: true });
    expect(insert.write).toBe('insert');
  });

  it('does not touch other contacts when the new one is not primary', async () => {
    const recorder = new RecordingClient([{ id: CONTACT }]);
    await createContact(recorder.client(), contactInput({ is_primary: false }));

    expect(recorder.queries).toHaveLength(1);
    expect(recorder.queries[0].write).toBe('insert');
  });

  it('excludes the contact being edited, so it cannot demote itself', async () => {
    const recorder = new RecordingClient([{ id: CONTACT }]);
    await updateContact(recorder.client(), CONTACT, contactInput({ is_primary: true }));

    const demote = recorder.queries[0];
    expect(demote.filters).toContainEqual({ op: 'neq', column: 'id', value: CONTACT });
  });

  it('never sends crm_lead_id in an update — a contact cannot change lead', async () => {
    const recorder = new RecordingClient([{ id: CONTACT }]);
    await updateContact(recorder.client(), CONTACT, contactInput());

    const update = recorder.queries[0];
    expect(update.write).toBe('update');
    expect(update.payload).not.toHaveProperty('crm_lead_id');
  });
});

/**
 * `completed_at` is derived from status rather than entered, so the two cannot
 * disagree about whether the work is done.
 */
describe('task completion', () => {
  function taskInput(status: 'pending' | 'completed') {
    return {
      crm_lead_id: LEAD,
      client_id: null,
      assigned_to: null,
      title: 'Call the practice manager',
      description: null,
      status,
      priority: 'normal' as const,
      due_at: null
    };
  }

  it('stamps completed_at when a task is completed', async () => {
    const recorder = new RecordingClient([{ id: 't1' }]);
    await createTask(recorder.client(), taskInput('completed'), null);

    const payload = recorder.last.payload as { completed_at: string | null };
    expect(payload.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('leaves it null while the task is open', async () => {
    const recorder = new RecordingClient([{ id: 't1' }]);
    await createTask(recorder.client(), taskInput('pending'), null);

    expect((recorder.last.payload as { completed_at: unknown }).completed_at).toBeNull();
  });

  it('clears it again when a completed task is reopened', async () => {
    const recorder = new RecordingClient([{ id: 't1' }]);
    await updateTask(recorder.client(), 't1', taskInput('pending'));

    expect((recorder.last.payload as { completed_at: unknown }).completed_at).toBeNull();
  });

  it('setTaskStatus writes both fields together', async () => {
    const recorder = new RecordingClient([{ id: 't1' }]);
    await setTaskStatus(recorder.client(), 't1', 'completed');

    const payload = recorder.last.payload as { status: string; completed_at: string | null };
    expect(payload.status).toBe('completed');
    expect(payload.completed_at).not.toBeNull();
  });

  it('records who created a task', async () => {
    const recorder = new RecordingClient([{ id: 't1' }]);
    await createTask(recorder.client(), taskInput('pending'), 'user-1');

    expect((recorder.last.payload as { created_by: string }).created_by).toBe('user-1');
  });
});

/** Same reasoning: won_at/lost_at follow the stage, they are not entered. */
describe('opportunity outcome stamps', () => {
  function opportunityInput(stage: 'discovery' | 'won' | 'lost') {
    return {
      crm_lead_id: LEAD,
      contact_id: null,
      name: 'Invisalign landing page',
      stage,
      service_name: null,
      setup_fee: null,
      monthly_value: 1500,
      one_time_value: null,
      contract_months: 6,
      probability: 60,
      expected_close_date: null,
      pain_points: null,
      desired_outcome: null,
      budget: null,
      objections: null,
      next_action: null,
      owner_id: null,
      loss_reason: null
    };
  }

  it('stamps won_at on a won deal and leaves lost_at null', async () => {
    const recorder = new RecordingClient([{ id: 'o1' }]);
    await createOpportunity(recorder.client(), opportunityInput('won'));

    const payload = recorder.last.payload as { won_at: string | null; lost_at: string | null };
    expect(payload.won_at).toMatch(/^\d{4}/);
    expect(payload.lost_at).toBeNull();
  });

  it('clears both when a deal reopens', async () => {
    const recorder = new RecordingClient([{ id: 'o1' }]);
    await updateOpportunity(recorder.client(), 'o1', opportunityInput('discovery'));

    const payload = recorder.last.payload as { won_at: unknown; lost_at: unknown };
    expect(payload.won_at).toBeNull();
    expect(payload.lost_at).toBeNull();
  });

  it('keeps the original won date when a won deal is edited', async () => {
    // Re-stamping on every save would make "won last March" drift to today.
    const recorder = new RecordingClient([{ id: 'o1' }]);
    const existing = { won_at: '2026-03-01T10:00:00.000Z' } as never;
    await updateOpportunity(recorder.client(), 'o1', opportunityInput('won'), existing);

    expect((recorder.last.payload as { won_at: string }).won_at).toBe('2026-03-01T10:00:00.000Z');
  });
});

/**
 * `notes.content` is jsonb so a rich-text editor can land later. Until then it
 * is one documented key rather than a bare string a future editor would have to
 * migrate around.
 */
describe('notes', () => {
  it('wraps the text in the documented shape', async () => {
    const recorder = new RecordingClient([{ id: 'n1' }]);
    await createNote(
      recorder.client(),
      { crm_lead_id: LEAD, client_id: null, appointment_id: null, title: 'Call notes', text: 'Wants Invisalign leads.' },
      'user-1'
    );

    const payload = recorder.last.payload as { content: unknown; author_id: string };
    expect(payload.content).toEqual({ text: 'Wants Invisalign leads.' });
    expect(payload.author_id).toBe('user-1');
  });

  it('does not send a bare text column the table does not have', async () => {
    const recorder = new RecordingClient([{ id: 'n1' }]);
    await updateNote(recorder.client(), 'n1', { title: null, text: 'Updated.' });

    expect(recorder.last.payload).not.toHaveProperty('text');
    expect(recorder.last.payload).toHaveProperty('content');
  });

  it('reads the text back, and survives a malformed blob', () => {
    expect(noteText({ content: { text: 'hello' } })).toBe('hello');
    expect(noteText({ content: {} })).toBe('');
    expect(noteText({ content: null } as never)).toBe('');
    expect(noteText({ content: { text: 42 } } as never)).toBe('');
  });
});

describe('appointments', () => {
  it('records who booked it', async () => {
    const recorder = new RecordingClient([{ id: 'a1' }]);
    await createAppointment(
      recorder.client(),
      {
        crm_lead_id: LEAD,
        contact_id: null,
        title: 'Discovery call',
        starts_at: '2026-06-15T13:00:00.000Z',
        ends_at: null,
        timezone: 'Europe/London',
        status: 'scheduled',
        meeting_notes: null,
        outcome: null
      },
      'user-1'
    );

    const payload = recorder.last.payload as { created_by: string; timezone: string };
    expect(payload.created_by).toBe('user-1');
    // The zone is stored so the time can be shown back as it was entered.
    expect(payload.timezone).toBe('Europe/London');
  });
});
