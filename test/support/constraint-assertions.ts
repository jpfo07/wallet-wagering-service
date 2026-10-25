import { expect } from "bun:test";
import { sqlStateOf } from "./database.ts";

export const SQLSTATE = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  notNullViolation: "23502",
} as const;

export interface ExpectedViolation {
  readonly sqlState: string;
  readonly constraint: string;
}

function constraintOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value: unknown = (error as Record<string, unknown>)["constraint"];
  return typeof value === "string" ? value : undefined;
}

/**
 * Runs `run` and asserts the database refused it with exactly this SQLSTATE and constraint name,
 * so a test never passes because of some unrelated error. Works for immediate checks and for the
 * deferred triggers that only fire at COMMIT.
 */
export async function expectViolation(
  run: () => Promise<unknown>,
  expected: ExpectedViolation,
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) {
    throw new Error(`expected the database to refuse with ${expected.constraint}, but it accepted`);
  }
  expect({ sqlState: sqlStateOf(caught), constraint: constraintOf(caught) }).toEqual({
    sqlState: expected.sqlState,
    constraint: expected.constraint,
  });
}
