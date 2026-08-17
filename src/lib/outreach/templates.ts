/**
 * Rendering a step into an actual message.
 *
 * Pure functions. Everything here decides what a stranger receives with the
 * agency's name on it, so it should be provable without a provider account.
 *
 * Two rules that are not stylistic:
 *
 *   AN UNRESOLVED PLACEHOLDER IS A FAILURE, NOT A BLANK. "Hi {{first_name}},"
 *   arriving as "Hi ," is embarrassing; arriving as "Hi {{first_name}}," is
 *   worse. Rendering refuses rather than sending either.
 *
 *   EVERY EMAIL CARRIES AN UNSUBSCRIBE LINK AND A POSTAL ADDRESS. Appended
 *   here rather than left to whoever writes the template, because a template
 *   without one is the single most likely way this becomes a legal problem.
 */

export interface TemplateContext {
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  job_title: string | null;
  company_name: string | null;
  city: string | null;
  niche: string | null;
  website: string | null;
  sender_name: string | null;
  /** Filled from the pipeline's findings; the reason for writing at all. */
  top_opportunity: string | null;
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Placeholders a template may use. Anything else is a typo, not a variable. */
export const TEMPLATE_FIELDS: (keyof TemplateContext)[] = [
  'first_name',
  'last_name',
  'full_name',
  'job_title',
  'company_name',
  'city',
  'niche',
  'website',
  'sender_name',
  'top_opportunity'
];

/**
 * Substitute, or refuse.
 *
 * A missing value and an unknown field are both errors, and they say which
 * field so the person editing the template can fix it. The engine records the
 * refusal as a skipped send rather than mailing a half-rendered draft.
 */
export function render(template: string, context: TemplateContext): string {
  const missing: string[] = [];
  const unknown: string[] = [];

  const output = template.replace(PLACEHOLDER, (_match, rawField: string) => {
    const field = rawField as keyof TemplateContext;
    if (!TEMPLATE_FIELDS.includes(field)) {
      if (!unknown.includes(rawField)) unknown.push(rawField);
      return '';
    }
    const value = context[field];
    if (value === null || value === undefined || String(value).trim() === '') {
      if (!missing.includes(rawField)) missing.push(rawField);
      return '';
    }
    return String(value).trim();
  });

  if (unknown.length > 0) {
    throw new TemplateError(
      `Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
        `Available: ${TEMPLATE_FIELDS.join(', ')}.`
    );
  }
  if (missing.length > 0) {
    throw new TemplateError(
      `No value for ${missing.join(', ')} on this lead, so nothing was sent.`
    );
  }

  return output;
}

/** Which placeholders a template uses, for the preview and the editor. */
export function placeholdersIn(template: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp(PLACEHOLDER.source, 'g');
  let match = pattern.exec(template);
  while (match) {
    if (!found.includes(match[1])) found.push(match[1]);
    match = pattern.exec(template);
  }
  return found;
}

export interface FooterOptions {
  unsubscribeUrl: string;
  postalAddress: string | null;
  senderName: string | null;
}

/**
 * The footer, appended to every email without exception.
 *
 * Not optional and not template-controlled. UK marketing email has to identify
 * the sender and offer a way to stop; a template author forgetting is not a
 * failure mode worth allowing.
 */
export function emailFooter(options: FooterOptions): string {
  const lines = ['', '—'];
  if (options.senderName) lines.push(options.senderName);
  if (options.postalAddress) lines.push(options.postalAddress);
  lines.push(`Unsubscribe: ${options.unsubscribeUrl}`);
  return lines.join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A plain HTML part built from the text part.
 *
 * One source of words, so the two parts cannot say different things — and
 * escaped, because a lead's own company name ends up in here and
 * `Smith & Sons <Roofing>` should not become markup.
 */
export function textToHtml(text: string, unsubscribeUrl: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block.trim()).replace(/\n/g, '<br />')}</p>`)
    .join('\n');

  return [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.55;color:#111">',
    paragraphs,
    `<p style="font-size:12px;color:#666"><a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a></p>`,
    '</div>'
  ].join('\n');
}

/**
 * Does this reply read as "stop contacting me"?
 *
 * Deliberately eager. A false positive costs one prospect who has to be
 * re-enrolled by hand; a false negative means continuing to email somebody who
 * asked twice to be left alone. Those are not symmetrical, so the check leans
 * towards stopping.
 *
 * Only the reply's own words are read — the quoted original underneath would
 * otherwise match its own unsubscribe footer and opt out every single replier.
 */
export function detectOptOut(body: string): boolean {
  const reply = stripQuotedReply(body).toLowerCase();
  if (!reply.trim()) return false;

  const phrases = [
    'unsubscribe',
    'opt out',
    'opt-out',
    'remove me',
    'take me off',
    'stop contacting',
    'stop emailing',
    'do not contact',
    "don't contact",
    'do not email',
    "don't email",
    'not interested',
    'no thanks',
    'no thank you',
    'leave me alone'
  ];
  if (phrases.some((phrase) => reply.includes(phrase))) return true;

  // SMS convention: a message that is just STOP, and nothing else.
  return /^(stop|stopall|unsubscribe|cancel|end|quit|no)\W*$/i.test(reply.trim());
}

/**
 * Drop the quoted original from a reply.
 *
 * Without this, every reply contains our own footer — including the word
 * "Unsubscribe" — and the opt-out check above would fire on all of them.
 */
export function stripQuotedReply(body: string): string {
  const markers = [
    /^\s*on .+ wrote:\s*$/im,      // Gmail, Apple Mail
    /^\s*-{2,}\s*original message\s*-{2,}\s*$/im,
    /^\s*_{5,}\s*$/m,               // Outlook's rule
    /^\s*from:\s.+$/im,
    /^\s*>{1,}/m                    // quoted lines
  ];

  let cut = body.length;
  for (const marker of markers) {
    const match = marker.exec(body);
    if (match && match.index < cut) cut = match.index;
  }
  return body.slice(0, cut);
}
