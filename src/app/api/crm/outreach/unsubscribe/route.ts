/**
 * The unsubscribe endpoint.
 *
 * GET renders a confirmation page. POST performs it.
 *
 * That split is not ceremony. Corporate mail scanners and link prefetchers
 * fetch every URL in an incoming email; if GET did the unsubscribing, a
 * security appliance would opt out prospects who never saw the message. RFC
 * 8058 one-click clients send `POST` with
 * `List-Unsubscribe=One-Click`, which is honoured immediately — so the people
 * who meant it are served instantly and the robots are not.
 *
 * No session. The token is the authorisation: opaque, per-enrolment, and the
 * only identifier in the URL. A link carrying a lead id would let anyone
 * unsubscribe anyone by counting.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { createServiceClient, isCrmConfigured, isServiceRoleConfigured } from '@/lib/crm/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Enrolment {
  id: string;
  crm_lead_id: string;
  contact_id: string | null;
}

/**
 * Escape for an HTML attribute or text node.
 *
 * This route builds raw HTML rather than JSX, so it is the one place in the
 * application without React's automatic escaping. The token arrives from the
 * query string; stripping only quotes happened to be safe inside a
 * double-quoted attribute, but "happened to be safe" is not a property worth
 * relying on the next time this markup is edited.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(title: string, body: string, form?: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0b0d12;color:#e8eaee;
       display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
  main{max-width:34rem;text-align:center}
  h1{font-size:1.4rem;margin:0 0 .75rem}
  p{color:#9aa1ad;line-height:1.6;margin:0 0 1.25rem}
  button{background:#3b6ef5;color:#fff;border:0;border-radius:8px;padding:.7rem 1.4rem;
         font-size:.95rem;cursor:pointer}
</style></head>
<body><main><h1>${title}</h1><p>${body}</p>${form ?? ''}</main></body></html>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

async function findEnrolment(token: string): Promise<Enrolment | null> {
  const service = createServiceClient();
  const { data } = await service
    .from('lead_outreach')
    .select('id, crm_lead_id, contact_id')
    .eq('unsubscribe_token', token)
    .maybeSingle();
  return (data as Enrolment | null) ?? null;
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token') ?? '';
  if (!isCrmConfigured() || !isServiceRoleConfigured() || !token) {
    return page('Link not recognised', 'This unsubscribe link is not valid. Reply to the email and we will remove you by hand.');
  }

  const enrolment = await findEnrolment(token);
  if (!enrolment) {
    return page('Already unsubscribed', 'This link has expired or has already been used. You will not be contacted again.');
  }

  return page(
    'Unsubscribe',
    'Confirm and we will stop contacting you. This takes effect immediately and applies to every future message, not just this one.',
    `<form method="post"><input type="hidden" name="token" value="${escapeHtml(token)}" />
     <button type="submit">Unsubscribe me</button></form>`
  );
}

export async function POST(request: NextRequest) {
  if (!isCrmConfigured() || !isServiceRoleConfigured()) {
    return page('Not available', 'This endpoint is not configured. Reply to the email and we will remove you by hand.');
  }

  // The token arrives in the query for a one-click client and in the form body
  // for the confirmation page.
  let token = request.nextUrl.searchParams.get('token') ?? '';
  if (!token) {
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.includes('form')) {
      const form = await request.formData();
      token = String(form.get('token') ?? '');
    }
  }
  if (!token) {
    return page('Link not recognised', 'This unsubscribe link is not valid.');
  }

  const enrolment = await findEnrolment(token);
  // An unknown token still answers as though it worked. Saying "no such
  // enrolment" would turn this into an oracle for guessing valid tokens.
  if (!enrolment) {
    return page('Unsubscribed', 'You will not be contacted again.');
  }

  const service = createServiceClient();

  const { data: contactRow } = enrolment.contact_id
    ? await service.from('contacts').select('email, phone').eq('id', enrolment.contact_id).maybeSingle()
    : { data: null };
  const { data: intelRow } = await service
    .from('lead_intelligence')
    .select('business_email, business_phone')
    .eq('crm_lead_id', enrolment.crm_lead_id)
    .maybeSingle();

  const person = contactRow as { email: string | null; phone: string | null } | null;
  const business = intelRow as { business_email: string | null; business_phone: string | null } | null;

  const email = person?.email ?? business?.business_email ?? null;
  const phone = person?.phone ?? business?.business_phone ?? null;

  // Suppression first. If anything after this fails, the important half has
  // already happened.
  if (email || phone) {
    await service.from('suppressions').insert({
      email,
      phone,
      reason: 'unsubscribed',
      source: 'unsubscribe link',
      crm_lead_id: enrolment.crm_lead_id
    });
  }

  await service
    .from('lead_outreach')
    .update({
      status: 'stopped',
      stopped_at: new Date().toISOString(),
      stop_reason: 'Unsubscribed',
      next_step_at: null
    })
    .eq('crm_lead_id', enrolment.crm_lead_id);

  // The lead itself is marked, so nobody enrols them in a different sequence
  // next week.
  await service
    .from('crm_leads')
    .update({ pipeline_stage: 'do_not_contact' })
    .eq('id', enrolment.crm_lead_id);

  await service.from('activities').insert({
    crm_lead_id: enrolment.crm_lead_id,
    contact_id: enrolment.contact_id,
    type: 'status_change',
    direction: 'internal',
    subject: 'Unsubscribed',
    body: 'The recipient used the unsubscribe link. Every sequence has stopped and the address is suppressed.',
    metadata: { workflow: 'unsubscribe' }
  });

  return page('Unsubscribed', 'You will not be contacted again. Sorry for the interruption.');
}
