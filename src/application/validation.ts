import { InvalidCommandError } from "./errors.ts";

// Lowercase only: PostgreSQL returns uuids in lowercase, so an uppercase id would hash differently
// from the stored one and compare unequal to it (a false WALLET_PLAYER_MISMATCH).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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

export function requireUuid(field: string, value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new InvalidCommandError(`${field} must be a lowercase UUID`);
  }
  return value;
}

export function requirePositiveInteger(field: string, value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new InvalidCommandError(`${field} must be an integer between 1 and ${max}`);
  }
  return value;
}
