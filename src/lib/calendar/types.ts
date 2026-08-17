import type { IsoTimestamp, Json, Uuid } from '@/lib/crm/types';

export const CALENDAR_SYNC_STATES = ['local', 'pending', 'synced', 'failed'] as const;
export type CalendarSyncState = (typeof CALENDAR_SYNC_STATES)[number];

/** A connected Google account. Never carries the tokens — those are separate. */
export interface CalendarAccount {
  id: Uuid;
  profile_id: Uuid;
  provider: 'google';
  google_email: string;
  calendar_id: string;
  scope: string | null;
  sync_token: string | null;
  channel_id: string | null;
  channel_resource_id: string | null;
  channel_expires_at: IsoTimestamp | null;
  last_synced_at: IsoTimestamp | null;
  last_sync_summary: Json | null;
  last_error: string | null;
  is_active: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

/**
 * The sealed tokens.
 *
 * Only ever read by the service role. This type exists so the sync code is
 * explicit about handling ciphertext rather than treating it as a string that
 * happens to be long.
 */
export interface CalendarCredentials {
  calendar_account_id: Uuid;
  access_token_enc: string;
  refresh_token_enc: string | null;
  token_expires_at: IsoTimestamp | null;
}

export interface CalendarDeletion {
  id: Uuid;
  calendar_account_id: Uuid;
  calendar_id: string;
  external_event_id: string;
  attempts: number;
  last_error: string | null;
}

/** What one sync run did. Stored on the account and shown on the page. */
export interface SyncSummary {
  pushed: number;
  pulled: number;
  created: number;
  cancelled: number;
  deleted: number;
  failed: number;
  fullResync: boolean;
  errors: string[];
}

export function emptySummary(): SyncSummary {
  return {
    pushed: 0,
    pulled: 0,
    created: 0,
    cancelled: 0,
    deleted: 0,
    failed: 0,
    fullResync: false,
    errors: []
  };
}
