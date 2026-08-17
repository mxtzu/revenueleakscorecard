/**
 * Error types shared by the mutation layer and the server actions.
 *
 * Kept in their own module so `validation.ts` and `permissions.ts` can both
 * raise them without importing each other, and so a Client Component can import
 * the type without dragging server code into the browser bundle.
 */

/** A field the user can fix. The message is written to be shown verbatim. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Turn whatever a write threw into one sentence worth showing.
 *
 * Postgres messages are accurate and unreadable. The ones that reach a user
 * routinely are constraint violations, and each has a cause the user can act
 * on, so they get translated; everything else is passed through, because an
 * internal tool showing its real error is more useful than a shrug.
 */
export function readableWriteError(error: unknown): string {
  if (error instanceof ValidationError) return error.message;

  const message = error instanceof Error ? error.message : String(error);

  if (/row-level security|permission denied/i.test(message)) {
    return 'The database refused that write. Your role may have changed — reload and try again.';
  }
  if (/contacts_one_primary_per_lead/i.test(message)) {
    return 'This lead already has a primary contact. Clear the existing one first.';
  }
  if (/appointments_ends_after_starts/i.test(message)) {
    return 'The end time cannot be before the start time.';
  }
  if (/notes_has_subject_entity/i.test(message)) {
    return 'A note has to belong to a lead, a client or an appointment.';
  }
  if (/opportunities_probability_check/i.test(message)) {
    return 'Probability must be between 0 and 100.';
  }
  if (/opportunities_contract_months_check/i.test(message)) {
    return 'Contract length must be at least one month.';
  }
  if (/violates foreign key constraint/i.test(message)) {
    return 'That record refers to something which no longer exists. Reload and try again.';
  }
  if (/duplicate key value/i.test(message)) {
    return 'That record already exists.';
  }
  return message;
}
