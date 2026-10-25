import { InvalidCommandError } from "./errors.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 255;

/** Same rule as the schema's text CHECKs: not blank and at most 255 characters. */
export function requireText(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_TEXT_LENGTH) {
    throw new InvalidCommandError(`${field} must be a non-blank string of at most 255 characters`);
  }
  return value;
}

export function optionalText(field: string, value: unknown): string | undefined {
  return value === undefined ? undefined : requireText(field, value);
}

/**
 * UUIDs are case-insensitive (RFC 9562), so any case is accepted and normalized to lowercase,
 * the form PostgreSQL returns. This happens before the payload hash, for HTTP and SQS alike:
 * an uppercase id is the same identifier (replay, not conflict) and never a false
 * WALLET_PLAYER_MISMATCH against the stored lowercase one.
 */
export function requireUuid(field: string, value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new InvalidCommandError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

export function requirePositiveInteger(field: string, value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new InvalidCommandError(`${field} must be an integer between 1 and ${max}`);
  }
  return value;
}
