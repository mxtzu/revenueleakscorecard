/**
 * Converting between Stripe's minor units and the CRM's decimal amounts.
 *
 * Stripe counts in the smallest unit of the currency: 1500 is £15.00 in GBP
 * and ¥1500 in JPY, because the yen has no minor unit. Getting that backwards
 * is a hundredfold error in a money column, and it is silent — the number
 * still looks like a number.
 *
 * `payments.amount` is `numeric(12,2)`, so everything here rounds to two
 * decimal places at the boundary rather than letting float arithmetic decide.
 */

/**
 * Currencies Stripe bills without a minor unit. From Stripe's published list;
 * an unlisted currency is assumed to have two decimal places, which is true of
 * everything else Stripe supports.
 */
const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'
]);

/**
 * Currencies Stripe charges in minor units but requires to be a multiple of
 * 100. They still have two decimal places for display, so they need no special
 * conversion — noted here so the next person does not go looking.
 */
export function isZeroDecimal(currency: string): boolean {
  return ZERO_DECIMAL.has(currency.toLowerCase());
}

/** Stripe minor units → a decimal amount for the database. */
export function fromMinorUnits(amount: number | null | undefined, currency: string): number | null {
  if (amount === null || amount === undefined) return null;
  if (isZeroDecimal(currency)) return amount;
  return Math.round(amount) / 100;
}

/**
 * A decimal amount → Stripe minor units.
 *
 * Two floating-point traps, both of which cost real money:
 *
 *   `Math.trunc(19.99 * 100)` is 1998, undercharging by a penny on every
 *   invoice; hence rounding rather than truncating.
 *
 *   `Math.round(1.005 * 100)` is 100, because 1.005 cannot be represented
 *   exactly and lands just below the halfway point. Fixing the product to four
 *   decimal places first collapses that error before the rounding decision, so
 *   a half-penny rounds up as written rather than down as stored.
 */
export function toMinorUnits(amount: number, currency: string): number {
  const scaled = isZeroDecimal(currency) ? amount : amount * 100;
  return Math.round(Number(scaled.toFixed(4)));
}

/**
 * Monthly recurring value of a subscription.
 *
 * A yearly plan at £12,000 is £1,000 of MRR, not £12,000; quoting the first
 * number in a monthly total is how a forecast ends up wrong by an order of
 * magnitude. Intervals Stripe does not use return null rather than a guess.
 */
export function monthlyValue(
  amount: number | null,
  interval: string | null,
  intervalCount: number | null
): number | null {
  if (amount === null) return null;
  const count = intervalCount && intervalCount > 0 ? intervalCount : 1;
  const perPeriod = amount / count;

  switch (interval) {
    case 'month':
      return round2(perPeriod);
    case 'year':
      return round2(perPeriod / 12);
    case 'week':
      // 52 weeks over 12 months, rather than "about four".
      return round2((perPeriod * 52) / 12);
    case 'day':
      return round2((perPeriod * 365) / 12);
    default:
      return null;
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Stripe timestamps are epoch seconds. */
export function fromStripeTime(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined) return null;
  return new Date(seconds * 1000).toISOString();
}
