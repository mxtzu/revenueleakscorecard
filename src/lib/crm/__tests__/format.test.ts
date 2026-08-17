import { describe, expect, it } from 'vitest';

import {
  EM_DASH,
  displayUrl,
  formatDate,
  formatMoney,
  formatNumber,
  humanise,
  isOverdue,
  orDash
} from '../format';

/**
 * The point of these is the null handling. A CRM that renders a missing score
 * as "0" tells the salesperson something the pipeline never claimed.
 */
describe('format helpers', () => {
  it('renders absent values as a dash, never as zero', () => {
    expect(formatMoney(null)).toBe(EM_DASH);
    expect(formatMoney(undefined)).toBe(EM_DASH);
    expect(formatNumber(null)).toBe(EM_DASH);
    expect(formatDate(null)).toBe(EM_DASH);
    expect(orDash('   ')).toBe(EM_DASH);
  });

  it('still renders a real zero', () => {
    expect(formatMoney(0)).toBe('£0');
    expect(formatNumber(0)).toBe('0');
  });

  it('formats money without stray decimals on whole amounts', () => {
    expect(formatMoney(1500)).toBe('£1,500');
    expect(formatMoney(1499.5)).toBe('£1,499.50');
    // en-GB disambiguates a non-local currency: "US$", not a bare "$".
    expect(formatMoney(1200, 'USD')).toBe('US$1,200');
  });

  it('rejects an unparseable date rather than printing "Invalid Date"', () => {
    expect(formatDate('not-a-date')).toBe(EM_DASH);
  });

  it('humanises enum values', () => {
    expect(humanise('ready_for_outreach')).toBe('Ready for outreach');
    expect(humanise(null)).toBe(EM_DASH);
  });

  it('strips the scheme from a display URL', () => {
    expect(displayUrl('https://riversidedentalstudio.co.uk/')).toBe('riversidedentalstudio.co.uk');
    expect(displayUrl(null)).toBe(EM_DASH);
  });

  it('treats a null due date as not overdue', () => {
    expect(isOverdue(null)).toBe(false);
    expect(isOverdue(new Date(Date.now() - 60_000).toISOString())).toBe(true);
    expect(isOverdue(new Date(Date.now() + 60_000).toISOString())).toBe(false);
  });
});
