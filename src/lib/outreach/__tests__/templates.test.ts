import { describe, expect, it } from 'vitest';

import {
  detectOptOut,
  emailFooter,
  placeholdersIn,
  render,
  stripQuotedReply,
  TemplateError,
  textToHtml,
  type TemplateContext
} from '../templates';

function context(overrides: Partial<TemplateContext> = {}): TemplateContext {
  return {
    first_name: 'Dana',
    last_name: 'Okafor',
    full_name: 'Dana Okafor',
    job_title: 'Practice Manager',
    company_name: 'Riverside Dental',
    city: 'Sunderland',
    niche: 'dentistry',
    website: 'https://riverside.test',
    sender_name: 'Alex at Ascend',
    top_opportunity: 'no conversion tracking on the booking form',
    ...overrides
  };
}

describe('rendering', () => {
  it('substitutes every known placeholder', () => {
    expect(render('Hi {{first_name}} at {{company_name}}', context())).toBe(
      'Hi Dana at Riverside Dental'
    );
  });

  it('tolerates whitespace inside the braces', () => {
    expect(render('Hi {{ first_name }}', context())).toBe('Hi Dana');
  });

  /**
   * The rule that matters most here. "Hi ," reads as careless; "Hi
   * {{first_name}}," reads as a broken mail merge. Neither goes out.
   */
  it('refuses rather than sending a blank where a name should be', () => {
    expect(() => render('Hi {{first_name}},', context({ first_name: null }))).toThrow(TemplateError);
    expect(() => render('Hi {{first_name}},', context({ first_name: '  ' }))).toThrow(
      /No value for first_name/
    );
  });

  it('names every missing field at once, not just the first', () => {
    expect(() =>
      render('{{first_name}} {{city}}', context({ first_name: null, city: null }))
    ).toThrow(/first_name, city/);
  });

  it('catches a typo in a placeholder and lists what is available', () => {
    // A silent blank would be indistinguishable from a lead with no data.
    expect(() => render('Hi {{frist_name}}', context())).toThrow(/Unknown placeholder: frist_name/);
    expect(() => render('Hi {{frist_name}}', context())).toThrow(/Available: first_name/);
  });

  it('leaves a template with no placeholders alone', () => {
    expect(render('Just a flat message.', context())).toBe('Just a flat message.');
  });

  it('lists the placeholders a template uses', () => {
    expect(placeholdersIn('{{first_name}} {{company_name}} {{first_name}}')).toEqual([
      'first_name',
      'company_name'
    ]);
  });
});

describe('the footer', () => {
  it('always carries an unsubscribe link', () => {
    const footer = emailFooter({
      unsubscribeUrl: 'https://crm.test/u?token=abc',
      postalAddress: '1 Example Street',
      senderName: 'Ascend'
    });
    expect(footer).toContain('https://crm.test/u?token=abc');
    expect(footer).toContain('1 Example Street');
    expect(footer).toContain('Ascend');
  });

  it('still carries the link when nothing else is configured', () => {
    // Identification is nice to have; the opt-out is not optional.
    const footer = emailFooter({
      unsubscribeUrl: 'https://crm.test/u?token=abc',
      postalAddress: null,
      senderName: null
    });
    expect(footer).toContain('Unsubscribe: https://crm.test/u?token=abc');
  });
});

describe('the HTML part', () => {
  it('escapes the lead’s own words', () => {
    // A company really can be called "Smith & Sons <Roofing>".
    const html = textToHtml('Hi Smith & Sons <Roofing>', 'https://crm.test/u');
    expect(html).toContain('Smith &amp; Sons &lt;Roofing&gt;');
    expect(html).not.toContain('<Roofing>');
  });

  it('keeps paragraphs and includes the unsubscribe link', () => {
    const html = textToHtml('One.\n\nTwo.', 'https://crm.test/u');
    expect(html).toContain('<p>One.</p>');
    expect(html).toContain('<p>Two.</p>');
    expect(html).toContain('href="https://crm.test/u"');
  });
});

/**
 * Eager on purpose. A false positive costs one prospect who has to be
 * re-enrolled by hand; a false negative means emailing somebody who asked twice
 * to be left alone.
 */
describe('opt-out detection', () => {
  it('catches the ways people actually say it', () => {
    for (const reply of [
      'Please unsubscribe me',
      'Not interested, thanks',
      'remove me from your list',
      'Please take me off this list',
      'do not contact me again',
      "Don't email me",
      'STOP',
      'stop.',
      'No thanks'
    ]) {
      expect(detectOptOut(reply)).toBe(true);
    }
  });

  it('does not fire on a genuine reply', () => {
    for (const reply of [
      'Sounds interesting — can you send more detail?',
      'Can we speak on Thursday?',
      'What would this cost for two locations?',
      'I stopped using that agency last year, so yes.'
    ]) {
      expect(detectOptOut(reply)).toBe(false);
    }
  });

  /**
   * The bug this prevents: our own footer says "Unsubscribe", so every quoted
   * reply contains the word and every replier would be opted out.
   */
  it('ignores our own footer quoted underneath the reply', () => {
    const reply = [
      'Yes, Thursday works well.',
      '',
      'On Mon, 14 Sep 2026 at 09:00, Ascend <hello@ascend.test> wrote:',
      '> Hi Dana,',
      '> ...',
      '> Unsubscribe: https://crm.test/u?token=abc'
    ].join('\n');

    expect(stripQuotedReply(reply).trim()).toBe('Yes, Thursday works well.');
    expect(detectOptOut(reply)).toBe(false);
  });

  it('handles the Outlook and forwarded-message forms too', () => {
    const outlook = 'Happy to chat.\n\n_____________________\nFrom: Ascend\nUnsubscribe here';
    expect(detectOptOut(outlook)).toBe(false);

    const original = 'Sure.\n\n----- Original Message -----\nUnsubscribe: https://x';
    expect(detectOptOut(original)).toBe(false);
  });

  it('still opts out when the request sits above the quote', () => {
    const reply = 'Please remove me.\n\nOn Mon, Ascend wrote:\n> Hi Dana';
    expect(detectOptOut(reply)).toBe(true);
  });

  it('treats an empty reply as no signal either way', () => {
    expect(detectOptOut('')).toBe(false);
    expect(detectOptOut('   ')).toBe(false);
  });
});
