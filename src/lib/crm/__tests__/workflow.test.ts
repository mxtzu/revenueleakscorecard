import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { RecordingClient } from './recordingClient';
import { PIPELINE_STAGES, type PipelineStage } from '../types';
import {
  advances,
  convertLeadToOpportunity,
  isClosedStage,
  logCall,
  loseOpportunity,
  markProposalSent,
  STAGE_RANK,
  winOpportunity,
  type ConvertLeadInput,
  type LoseOpportunityInput,
  type WinOpportunityInput
} from '../workflow';

const LEAD = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OPP = '9c858901-8a57-4791-81fe-4c455b099bc9';
const PROPOSAL = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const CONTACT = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

function convertInput(overrides: Partial<ConvertLeadInput> = {}): ConvertLeadInput {
  return {
    crm_lead_id: LEAD,
    name: 'Landing page + Google Ads',
    stage: 'discovery',
    contact_id: null,
    owner_id: null,
    service_name: null,
    setup_fee: null,
    monthly_value: null,
    one_time_value: null,
    contract_months: null,
    probability: null,
    expected_close_date: null,
    pain_points: null,
    desired_outcome: null,
    budget: null,
    objections: null,
    next_action: null,
    next_action_at: null,
    note: null,
    ...overrides
  };
}

function winInput(overrides: Partial<WinOpportunityInput> = {}): WinOpportunityInput {
  return {
    opportunity_id: OPP,
    company_name: null,
    client_status: 'onboarding',
    account_owner: null,
    start_date: null,
    renewal_date: null,
    create_contract: false,
    contract_status: 'signed',
    contract_start_date: null,
    contract_end_date: null,
    contract_monthly_value: null,
    contract_setup_fee: null,
    contract_document_url: null,
    note: null,
    ...overrides
  };
}

function loseInput(overrides: Partial<LoseOpportunityInput> = {}): LoseOpportunityInput {
  return {
    opportunity_id: OPP,
    loss_reason: 'Went with a cheaper agency',
    close_lead: false,
    lead_stage: 'lost',
    note: null,
    ...overrides
  };
}

/**
 * Each transition is one RPC, not several REST writes. That is the whole point
 * of the layer: a lead conversion that failed halfway would otherwise leave an
 * opportunity behind with the lead still sitting in `qualified`.
 */
describe('every transition is a single call', () => {
  it('converts a lead in one RPC and no table writes', async () => {
    const recorder = new RecordingClient([OPP]);
    const id = await convertLeadToOpportunity(recorder.client(), convertInput());

    expect(id).toBe(OPP);
    expect(recorder.rpcs).toHaveLength(1);
    expect(recorder.queries).toHaveLength(0);
    expect(recorder.lastRpc.fn).toBe('crm_convert_lead_to_opportunity');
  });

  it('wins, loses, sends and logs in one RPC each', async () => {
    const recorder = new RecordingClient(['x']);
    const client = recorder.client();

    await winOpportunity(client, winInput());
    await loseOpportunity(client, loseInput());
    await markProposalSent(client, PROPOSAL);
    await logCall(client, {
      crm_lead_id: LEAD,
      summary: 'Spoke to the owner.',
      outcome: null,
      contact_id: null,
      opportunity_id: null,
      occurred_at: null,
      next_action: null,
      next_action_at: null,
      task_title: null,
      task_due_at: null
    });

    expect(recorder.rpcs.map((call) => call.fn)).toEqual([
      'crm_win_opportunity',
      'crm_lose_opportunity',
      'crm_send_proposal',
      'crm_log_call'
    ]);
    expect(recorder.queries).toHaveLength(0);
  });
});

describe('arguments reach the database intact', () => {
  it('passes the discovery fields through, nulls included', async () => {
    const recorder = new RecordingClient([OPP]);
    await convertLeadToOpportunity(
      recorder.client(),
      convertInput({
        contact_id: CONTACT,
        monthly_value: 1500,
        setup_fee: 2000,
        probability: 60,
        pain_points: 'No tracking',
        stage: 'sales_call'
      })
    );

    const { args } = recorder.lastRpc;
    expect(args.p_lead_id).toBe(LEAD);
    expect(args.p_contact_id).toBe(CONTACT);
    expect(args.p_monthly_value).toBe(1500);
    expect(args.p_probability).toBe(60);
    expect(args.p_pain_points).toBe('No tracking');
    expect(args.p_stage).toBe('sales_call');
    // An omitted field must be an explicit null, not undefined: JSON drops
    // undefined, and Postgres would then use the DEFAULT instead of clearing.
    expect(args.p_budget).toBeNull();
    expect(Object.values(args).every((value) => value !== undefined)).toBe(true);
  });

  it('sends the contract fields only the win form collects', async () => {
    const recorder = new RecordingClient(['client-id']);
    await winOpportunity(
      recorder.client(),
      winInput({ create_contract: true, contract_monthly_value: 1800, company_name: 'Riverside Ltd' })
    );

    const { args } = recorder.lastRpc;
    expect(args.p_create_contract).toBe(true);
    expect(args.p_contract_monthly_value).toBe(1800);
    expect(args.p_company_name).toBe('Riverside Ltd');
    expect(args.p_client_status).toBe('onboarding');
  });

  it('carries the loss reason and the lead-closing choice', async () => {
    const recorder = new RecordingClient([OPP]);
    await loseOpportunity(
      recorder.client(),
      loseInput({ close_lead: true, lead_stage: 'disqualified' })
    );

    const { args } = recorder.lastRpc;
    expect(args.p_loss_reason).toBe('Went with a cheaper agency');
    expect(args.p_close_lead).toBe(true);
    expect(args.p_lead_stage).toBe('disqualified');
  });

  it('defaults the proposal timestamp to null so the database decides', async () => {
    const recorder = new RecordingClient([PROPOSAL]);
    await markProposalSent(recorder.client(), PROPOSAL);
    expect(recorder.lastRpc.args).toEqual({
      p_proposal_id: PROPOSAL,
      p_sent_at: null,
      p_note: null
    });
  });

  /**
   * An `inbound` activity fires halt_outreach_on_inbound_reply, which stops
   * every live sequence and advances the lead to `replied`. Logging a call the
   * agency made must never do that, so the direction is not a parameter.
   */
  it('always logs a call as outbound', async () => {
    const recorder = new RecordingClient(['activity-id']);
    await logCall(recorder.client(), {
      crm_lead_id: LEAD,
      summary: 'Discovery call',
      outcome: 'Proposal requested',
      contact_id: CONTACT,
      opportunity_id: OPP,
      occurred_at: '2026-08-17T10:00:00.000Z',
      next_action: 'Send the proposal',
      next_action_at: '2026-08-19T09:00:00.000Z',
      task_title: 'Draft the proposal',
      task_due_at: '2026-08-18T09:00:00.000Z'
    });

    const { args } = recorder.lastRpc;
    expect(args.p_direction).toBe('outbound');
    expect(args.p_task_title).toBe('Draft the proposal');
    expect(args.p_next_action).toBe('Send the proposal');
  });
});

describe('errors', () => {
  function erroringClient(message: string) {
    return {
      rpc: () => Promise.resolve({ data: null, error: { message } })
    } as never;
  }

  it('shows the sentence the database raised, not a generic one', async () => {
    // The plpgsql functions raise messages written to be read by a user.
    await expect(
      loseOpportunity(erroringClient('A lost deal needs a reason.'), loseInput())
    ).rejects.toThrow('A lost deal needs a reason.');
  });

  it('does not report success when the function returned nothing', async () => {
    const empty = { rpc: () => Promise.resolve({ data: null, error: null }) } as never;
    await expect(winOpportunity(empty, winInput())).rejects.toThrow(/returned nothing/);
  });
});

describe('stage ranking', () => {
  it('ranks every pipeline stage', () => {
    for (const stage of PIPELINE_STAGES) {
      expect(typeof STAGE_RANK[stage]).toBe('number');
    }
  });

  it('treats the three closed stages as outcomes, not progress', () => {
    for (const stage of ['lost', 'disqualified', 'do_not_contact'] as PipelineStage[]) {
      expect(isClosedStage(stage)).toBe(true);
      expect(advances(stage, 'won')).toBe(false);
    }
  });

  it('only advances forward', () => {
    expect(advances('qualified', 'proposal')).toBe(true);
    expect(advances('proposal', 'qualified')).toBe(false);
    expect(advances('won', 'won')).toBe(false);
  });
});

/**
 * The wrappers and the SQL are two halves of one contract, and Postgres matches
 * named arguments by name — a renamed parameter or a typo'd key is a runtime
 * "function does not exist", on a form nobody submits until a deal is closing.
 * So the migration is read and the two are compared.
 */
describe('the wrappers match the SQL signatures', () => {
  const migration = readFileSync('supabase/migrations/20260818_sales_workflow.sql', 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

  /** Parameter names declared by a function in the migration. */
  function sqlParams(fn: string): string[] {
    const start = migration.indexOf(`create or replace function public.${fn}(`);
    if (start < 0) throw new Error(`${fn} is not in the migration`);
    const open = migration.indexOf('(', start);
    const close = migration.indexOf(')\nreturns', open);
    if (close < 0) throw new Error(`Could not find the end of ${fn}'s parameter list`);
    return migration
      .slice(open + 1, close)
      .split(',')
      .map((param) => param.trim())
      .filter(Boolean)
      .map((param) => param.split(/\s+/)[0])
      .filter((name) => name.startsWith('p_'));
  }

  async function argsSentBy(call: (client: never) => Promise<unknown>): Promise<string[]> {
    const recorder = new RecordingClient(['id']);
    await call(recorder.client() as never);
    return Object.keys(recorder.lastRpc.args).sort();
  }

  const cases: [string, (client: never) => Promise<unknown>][] = [
    ['crm_convert_lead_to_opportunity', (c) => convertLeadToOpportunity(c, convertInput())],
    ['crm_win_opportunity', (c) => winOpportunity(c, winInput())],
    ['crm_lose_opportunity', (c) => loseOpportunity(c, loseInput())],
    ['crm_send_proposal', (c) => markProposalSent(c, PROPOSAL)],
    [
      'crm_log_call',
      (c) =>
        logCall(c, {
          crm_lead_id: LEAD,
          summary: 'x',
          outcome: null,
          contact_id: null,
          opportunity_id: null,
          occurred_at: null,
          next_action: null,
          next_action_at: null,
          task_title: null,
          task_due_at: null
        })
    ]
  ];

  for (const [fn, call] of cases) {
    it(`${fn} receives exactly the arguments it declares`, async () => {
      // Every SQL parameter after the first has a DEFAULT, so sending fewer
      // would compile — and quietly use the default instead of the user's
      // blank. Equality, not a subset, is the assertion.
      expect(await argsSentBy(call)).toEqual(sqlParams(fn).sort());
    });
  }

  it('STAGE_RANK matches crm_stage_rank()', () => {
    const start = migration.indexOf('function public.crm_stage_rank');
    const body = migration.slice(start, migration.indexOf('$$;', start));
    // A plain regex loop rather than matchAll: the build targets es5, where
    // the iterator matchAll returns cannot be spread or for-of'd.
    const fromSql: Record<string, number> = {};
    const branch = /when '(\w+)'\s+then (\d+)/g;
    let match = branch.exec(body);
    while (match) {
      fromSql[match[1]] = Number(match[2]);
      match = branch.exec(body);
    }
    // The `else 0` branch covers the closed stages rather than naming them.
    for (const stage of PIPELINE_STAGES) {
      expect(STAGE_RANK[stage]).toBe(fromSql[stage] ?? 0);
    }
  });
});
