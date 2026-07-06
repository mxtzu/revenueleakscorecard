/**
 * Minimal server-side Supabase REST client for funnel logging.
 * Uses PostgREST directly so we don't ship a client SDK for two inserts.
 *
 * Inserts are best-effort: if the env isn't configured or the request
 * fails, the scorecard keeps working and the caller decides whether to
 * also forward to a webhook.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export type SupabaseInsertResult = {
  configured: boolean;
  inserted: boolean;
  error?: string;
};

export function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

export async function supabaseInsert(
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[]
): Promise<SupabaseInsertResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { configured: false, inserted: false };
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify(rows)
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        configured: true,
        inserted: false,
        error: `Supabase insert into ${table} failed: ${response.status} ${detail.slice(0, 300)}`
      };
    }

    return { configured: true, inserted: true };
  } catch (error) {
    return {
      configured: true,
      inserted: false,
      error: `Supabase insert into ${table} threw: ${error instanceof Error ? error.message : "unknown"}`
    };
  }
}

export async function supabaseSelect<T>(table: string, query: string): Promise<T[] | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    });

    if (!response.ok) return null;
    return (await response.json()) as T[];
  } catch {
    return null;
  }
}

export async function supabaseUpdate(
  table: string,
  filter: string,
  patch: Record<string, unknown>
): Promise<SupabaseInsertResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { configured: false, inserted: false };
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify(patch)
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        configured: true,
        inserted: false,
        error: `Supabase update on ${table} failed: ${response.status} ${detail.slice(0, 300)}`
      };
    }

    return { configured: true, inserted: true };
  } catch (error) {
    return {
      configured: true,
      inserted: false,
      error: `Supabase update on ${table} threw: ${error instanceof Error ? error.message : "unknown"}`
    };
  }
}
