/**
 * GET /api/crm/documents/[id] — open a stored document.
 *
 * The bucket is private, so there is no URL a page could link to directly.
 * This resolves the row under the caller's session (RLS decides whether they
 * may see it), mints a short-lived signed URL, and redirects to it.
 *
 * Why not put the signed URL straight in the page? Because it would then sit in
 * the HTML, in the browser history and in any copied link, valid for whoever
 * finds it. Redirecting means the link in the page is a permanent,
 * authenticated route and the credential only exists for the moment it is used.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { documentDownloadUrl } from '@/lib/crm/mutations';
import { getDocumentById } from '@/lib/crm/queries';
import { crmClient } from '@/lib/crm/server';
import { isCrmConfigured } from '@/lib/crm/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  if (!isCrmConfigured()) {
    return NextResponse.json({ error: 'CRM is not configured.' }, { status: 503 });
  }

  const client = crmClient();

  // No explicit auth check: RLS returns nothing to a caller who may not read
  // it, so "not permitted" and "does not exist" collapse into one 404. That is
  // the right answer for both — confirming a document exists is itself a leak.
  let document;
  try {
    document = await getDocumentById(client, params.id);
  } catch {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }
  if (!document) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  try {
    const url = await documentDownloadUrl(client, document.storage_path, 60);
    return NextResponse.redirect(url, { status: 302 });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 502 }
    );
  }
}
