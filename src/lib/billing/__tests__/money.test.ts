import { describe, expect, it } from 'vitest';

import { fromMinorUnits, fromStripeTime, isZeroDecimal, monthlyValue, toMinorUnits } from '../money';

/**
 * Stripe counts in the smallest unit of the currency. Getting that backwards is
 * a hundredfold error in a money column, and it is silent — the number still
 * looks like a number.
 */
describe('minor units', () => {
  it('converts pounds and pence both ways', () => {
    expect(fromMinorUnits(150000, 'gbp')).toBe(1500);
    expect(fromMinorUnits(1999, 'gbp')).toBe(19.99);
    expect(toMinorUnits(1500, 'gbp')).toBe(150000);
    expect(toMinorUnits(19.99, 'gbp')).toBe(1999);
  });

  it('does not undercharge by a penny on floating point', () => {
    // Math.trunc(19.99 * 100) is 1998. Every invoice would be a penny light.
    expect(toMinorUnits(19.99, 'gbp')).toBe(1999);
    expect(toMinorUnits(0.29, 'gbp')).toBe(29);
    // 1.005 * 100 is 100.49999999999999 in binary floating point, so a naive
    // Math.round loses the half penny downwards.
    expect(toMinorUnits(1.005, 'gbp')).toBe(101);
    expect(toMinorUnits(8.165, 'gbp')).toBe(817);
  });

  it('leaves zero-decimal currencies alone', () => {
    // ¥1500 is 1500, not 150000. Multiplying would charge a hundred times over.
    expect(isZeroDecimal('JPY')).toBe(true);
    expect(fromMinorUnits(1500, 'jpy')).toBe(1500);
    expect(toMinorUnits(1500, 'jpy')).toBe(1500);
    expect(isZeroDecimal('gbp')).toBe(false);
  });

  it('is case-insensitive about the currency code', () => {
    expect(toMinorUnits(1000, 'JPY')).toBe(toMinorUnits(1000, 'jpy'));
  });

  it('passes null through rather than turning it into zero', () => {
    // A missing amount and a zero amount are different facts on an invoice.
    expect(fromMinorUnits(null, 'gbp')).toBeNull();
    expect(fromMinorUnits(undefined, 'gbp')).toBeNull();
    expect(fromMinorUnits(0, 'gbp')).toBe(0);
  });

  it('round-trips', () => {
    for (const amount of [0, 1, 19.99, 1500, 123456.78]) {
      expect(fromMinorUnits(toMinorUnits(amount, 'gbp'), 'gbp')).toBe(amount);
    }
  });
});

/**
 * A yearly plan at £12,000 is £1,000 of MRR. Quoting the first number in a
 * monthly total is how a forecast ends up wrong by an order of magnitude.
 */
describe('monthly recurring value', () => {
  it('normalises every interval to a month', () => {
    expect(monthlyValue(1500, 'month', 1)).toBe(1500);
    expect(monthlyValue(12000, 'year', 1)).toBe(1000);
    expect(monthlyValue(100, 'week', 1)).toBe(433.33);
    expect(monthlyValue(10, 'day', 1)).toBe(304.17);
  });

  it('accounts for a multi-period interval', () => {
    // Billed £3,000 every three months is £1,000 a month.
    expect(monthlyValue(3000, 'month', 3)).toBe(1000);
    expect(monthlyValue(24000, 'year', 2)).toBe(1000);
  });

  it('refuses to guess at an interval it does not know', () => {
    expect(monthlyValue(1000, 'fortnight', 1)).toBeNull();
    expect(monthlyValue(1000, null, 1)).toBeNull();
    expect(monthlyValue(null, 'month', 1)).toBeNull();
  });

  it('treats a missing or zero interval count as one', () => {
    expect(monthlyValue(1500, 'month', null)).toBe(1500);
    expect(monthlyValue(1500, 'month', 0)).toBe(1500);
  });
});

describe('timestamps', () => {
  it('reads Stripe epoch seconds', () => {
    expect(fromStripeTime(1_790_000_000)).toBe('2026-09-21T14:13:20.000Z');
    expect(fromStripeTime(null)).toBeNull();
    expect(fromStripeTime(undefined)).toBeNull();
  });
});
