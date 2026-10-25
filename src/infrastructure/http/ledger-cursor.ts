import { InvalidRequestError } from "./http-errors.ts";

// Versioned so the format can change without breaking clients that hold an old cursor.
const PLAIN_CURSOR = /^v1:(0|[1-9]\d{0,15})$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Opaque, stable cursor of GET /wallets/:id/ledger: base64url("v1:<walletVersion>") of the last
 * entry already returned. Keyset on (wallet_id, wallet_version), so concurrent inserts never shift
 * a page and clock skew between instances does not matter.
 */
export function encodeLedgerCursor(afterVersion: number): string {
  return Buffer.from(`v1:${afterVersion}`, "utf8").toString("base64url");
}

export function decodeLedgerCursor(cursor: string): number {
  // Buffer's base64url decoder silently skips invalid characters: check the alphabet first and
  // the round trip after, so only cursors we issued are accepted.
  const plain = BASE64URL.test(cursor) ? Buffer.from(cursor, "base64url").toString("utf8") : "";
  const match = PLAIN_CURSOR.exec(plain);
  const version = match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
  if (
    version === undefined ||
    !Number.isSafeInteger(version) ||
    encodeLedgerCursor(version) !== cursor
  ) {
    throw new InvalidRequestError("invalid cursor", [
      { path: "query.cursor", message: "not a cursor issued by this API" },
    ]);
  }
  return version;
}
