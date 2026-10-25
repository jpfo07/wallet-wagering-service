import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import type { PendingReferenceCandidate } from "../../../src/application/ports/repositories.ts";
import { InvalidOperationError } from "../../../src/domain/shared/domain-error.ts";
import { WagerTransactionStatus as Status } from "../../../src/domain/wager/wager-transaction-status.ts";
import type { PendingReferenceConfig } from "../../../src/infrastructure/config/env.ts";
import { MikroOrmUnitOfWork } from "../../../src/infrastructure/persistence/mikro-orm-unit-of-work.ts";
import { useApplicationSuite } from "../../support/application-suite.ts";
import type { AppHandle } from "../../support/application-suite.ts";
import {
  CTX,
  createWallet,
  ledgerRows,
  outboxEventTypes,
  wagerCommand,
  walletState,
} from "../../support/command-builders.ts";
import { assertLedgerInvariant } from "../../support/ledger-invariant.ts";
import { TamperingUnitOfWork, override } from "../../support/tampering.ts";
import { TEST_PENDING_REFERENCE } from "../../support/test-env.ts";
import { ManualClock } from "../../support/worker-support.ts";

/** A backoff far longer than any test: only the expedite makes the transaction due. */
const LONG_BACKOFF: PendingReferenceConfig = {
  baseMs: 600_000,
  maxMs: 600_000,
  ttlMs: 3_600_000,
};

interface PendingRow {
  readonly status: string;
  readonly failure_code: string | null;
  readonly reference_attempts: number;
  readonly next_reference_check_at: Date | null;
}

async function transactionRow(sql: SQL, id: string): Promise<PendingRow> {
  const rows: PendingRow[] = await sql.unsafe(
    `select status, failure_code, reference_attempts, next_reference_check_at
       from wager_transactions where id = $1`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`transaction ${id} not found`);
  return row;
}

/**
 * The PENDING_REFERENCE worker's use case against real PostgreSQL, on a manual clock: backoff and
 * TTL are crossed by moving the clock, never by sleeping. Each test works on its own wallet; the
 * cycle helper only looks at candidates of that wallet, since the database is shared by the suite.
 */
describe("PENDING_REFERENCE worker (real PostgreSQL)", () => {
  const suite = useApplicationSuite("workers-pending-reference");

  async function handleWith(clock: ManualClock, pendingReference = TEST_PENDING_REFERENCE) {
    return suite().open({ dependencies: () => ({ clock }), pendingReference });
  }

  /** One worker cycle restricted to the wallet: due candidates → recheck each. */
  async function cycle(handle: AppHandle, walletId: string) {
    const candidates = await handle.app.recheckPendingReferences.dueCandidates(500);
    const mine = candidates.filter((candidate) => candidate.walletId === walletId);
    const outcomes: string[] = [];
    for (const candidate of mine) {
      outcomes.push(await handle.app.recheckPendingReferences.recheck(candidate));
    }
    return { candidates: mine.map((candidate) => candidate.transactionId), outcomes };
  }

  test("events of a re-check keep the correlationId of the request that created the transaction", async () => {
    const { sql } = suite();
    const clock = new ManualClock();
    const handle = await handleWith(clock, LONG_BACKOFF);
    const wallet = await createWallet(handle.app, "100.00");
    const refund = await handle.app.processWagerTransaction.execute(
      wagerCommand(wallet, "REFUND", { amount: "30.00", reference: "bet-corr" }),
      { correlationId: "corr-refund-original" },
    );
    await handle.app.processWagerTransaction.execute(
      wagerCommand(wallet, "BET", { externalTransactionId: "bet-corr", amount: "30.00" }),
      { correlationId: "corr-bet" },
    );
    const stored: { correlation_id: string | null }[] = await sql.unsafe(
      `select correlation_id from wager_transactions where id = $1`,
      [refund.transactionId],
    );
    expect(stored).toEqual([{ correlation_id: "corr-refund-original" }]);

    expect((await cycle(handle, wallet.id)).outcomes).toEqual(["PROCESSED"]);
    const events: { event_type: string; correlation_id: string; causation_id: string }[] =
      await sql.unsafe(
        `select event_type, payload->>'correlationId' as correlation_id,
                payload->>'causationId' as causation_id
           from outbox_messages where aggregate_id = $1 and payload->>'causationId' = $2
          order by sequence`,
        [wallet.id, refund.transactionId],
      );
    expect(events).toEqual([
      {
        event_type: "WagerTransactionProcessed",
        correlation_id: "corr-refund-original",
        causation_id: refund.transactionId,
      },
      {
        event_type: "WalletBalanceChanged",
        correlation_id: "corr-refund-original",
        causation_id: refund.transactionId,
      },
    ]);
    expect(
      handle.metrics.count("wager_transaction{kind=REFUND,status=PROCESSED,source=pending_worker}"),
    ).toBe(1);
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("REFUND before its BET: the BET brings the check forward and the very next cycle resolves it", async () => {
    const { sql } = suite();
    const clock = new ManualClock();
    const handle = await handleWith(clock, LONG_BACKOFF);
    const wallet = await createWallet(handle.app, "100.00");
    const refundCommand = wagerCommand(wallet, "REFUND", { amount: "30.00", reference: "bet-1" });
    const refund = await handle.app.processWagerTransaction.execute(refundCommand, CTX);
    expect(refund.status).toBe(Status.PendingReference);

    // Waiting on a 5–10 min backoff: not due.
    const scheduled = await transactionRow(sql, refund.transactionId);
    expect(
      (scheduled.next_reference_check_at?.getTime() ?? 0) - clock.now().getTime(),
    ).toBeGreaterThanOrEqual(300_000);
    expect((await cycle(handle, wallet.id)).candidates).toEqual([]);

    // The BET arrives (same clock instant): the waiting REFUND becomes due right now.
    const bet = await handle.app.processWagerTransaction.execute(
      wagerCommand(wallet, "BET", { externalTransactionId: "bet-1", amount: "30.00" }),
      CTX,
    );
    expect(bet.status).toBe(Status.Processed);
    expect((await transactionRow(sql, refund.transactionId)).next_reference_check_at).toEqual(
      clock.now(),
    );

    // Next cycle, clock unchanged: resolved without waiting for the backoff.
    expect(await cycle(handle, wallet.id)).toEqual({
      candidates: [refund.transactionId],
      outcomes: ["PROCESSED"],
    });
    expect(await walletState(sql, wallet.id)).toEqual({ balance: "100.00", version: 3 });
    expect((await ledgerRows(sql, wallet.id)).map((row) => row.direction)).toEqual([
      "CREDIT",
      "DEBIT",
      "CREDIT",
    ]);
    expect(await outboxEventTypes(sql, wallet.id)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    // The replay now reflects the resolved state (decision 8).
    expect(await handle.app.processWagerTransaction.execute(refundCommand, CTX)).toMatchObject({
      transactionId: refund.transactionId,
      status: "PROCESSED",
      idempotentReplay: true,
    });
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("ROLLBACK before its BET keeps waiting with a growing backoff and no new event, then resolves", async () => {
    const { sql } = suite();
    const clock = new ManualClock();
    const handle = await handleWith(clock);
    const wallet = await createWallet(handle.app, "100.00");
    const rollback = await handle.app.processWagerTransaction.execute(
      wagerCommand(wallet, "ROLLBACK", { amount: "20.00", reference: "bet-rb" }),
      CTX,
    );
    expect(rollback.status).toBe(Status.PendingReference);
    const eventsBefore = await outboxEventTypes(sql, wallet.id);

    clock.advance(1_000);
    expect((await cycle(handle, wallet.id)).outcomes).toEqual(["PENDING_REFERENCE"]);
    const first = await transactionRow(sql, rollback.transactionId);
    expect(first.reference_attempts).toBe(1);
    const firstDelay = (first.next_reference_check_at?.getTime() ?? 0) - clock.now().getTime();
    expect(firstDelay).toBeGreaterThanOrEqual(1_000);
    expect(firstDelay).toBeLessThanOrEqual(2_000);

    clock.advance(firstDelay);
    expect((await cycle(handle, wallet.id)).outcomes).toEqual(["PENDING_REFERENCE"]);
    const second = await transactionRow(sql, rollback.transactionId);
    expect(second.reference_attempts).toBe(2);
    const secondDelay = (second.next_reference_check_at?.getTime() ?? 0) - clock.now().getTime();
    expect(secondDelay).toBeGreaterThanOrEqual(2_000);
    expect(secondDelay).toBeLessThanOrEqual(4_000);
    expect(await outboxEventTypes(sql, wallet.id)).toEqual(eventsBefore);

    await handle.app.processWagerTransaction.execute(
      wagerCommand(wallet, "BET", { externalTransactionId: "bet-rb", amount: "20.00" }),
      CTX,
    );
    expect((await cycle(handle, wallet.id)).outcomes).toEqual(["PROCESSED"]);
    expect(await walletState(sql, wallet.id)).toEqual({ balance: "100.00", version: 3 });
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("WIN whose BET has not arrived is credited once the BET is processed", async () => {
    const { sql } = suite();
    const clock = new ManualClock();
    const handle = await handleWith(clock, LONG_BACKOFF);
    const wallet = await createWallet(handle.app, "50.00");
    const win = await handle.app.processWagerTransaction.execute(
      wagerCommand(wallet, "WIN", { amount: "80.00", reference: "bet-w" }),
      CTX,
    );
    expect(win.status).toBe(Status.PendingReference);
    await handle.app.processWagerTransaction.execute(
      wagerCommand(wallet, "BET", { externalTransactionId: "bet-w", amount: "10.00" }),
      CTX,
    );
    expect((await cycle(handle, wallet.id)).outcomes).toEqual(["PROCESSED"]);
    expect(await walletState(sql, wallet.id)).toEqual({ balance: "120.00", version: 3 });
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("a chain resolves cycle by cycle: ROLLBACK of a REFUND that itself waited for its BET", async () => {
    const { sql } = suite();
    const clock = new ManualClock();
    const handle = await handleWith(clock, LONG_BACKOFF);
    const wallet = await createWallet(handle.app, "100.00");
    const refund = await handle.app.processWagerTransaction.execute(
      wagerCommand(wallet, "REFUND", {
        externalTransactionId: "refund-c",
        amount: "30.00",
        reference: "bet-c",
      }),
      CTX,
    );
    const rollback = await handle.app.processWagerTransaction.execute(
      wagerCommand(wallet, "ROLLBACK", { amount: "30.00", reference: "refund-c" }),
      CTX,
    );
    expect([refund.status, rollback.status]).toEqual([
      Status.PendingReference,
      Status.PendingReference,
    ]);

    await handle.app.processWagerTransaction.execute(
      wagerCommand(wallet, "BET", { externalTransactionId: "bet-c", amount: "30.00" }),
      CTX,
    );
    // Cycle 1: only the REFUND was due; resolving it brings the ROLLBACK forward.
    expect(await cycle(handle, wallet.id)).toEqual({
      candidates: [refund.transactionId],
      outcomes: ["PROCESSED"],
    });
    // Cycle 2: the ROLLBACK undoes the REFUND (DEBIT).
    expect(await cycle(handle, wallet.id)).toEqual({
      candidates: [rollback.transactionId],
      outcomes: ["PROCESSED"],
    });
    expect(await walletState(sql, wallet.id)).toEqual({ balance: "70.00", version: 4 });
    expect((await ledgerRows(sql, wallet.id)).map((row) => row.direction)).toEqual([
      "CREDIT",
      "DEBIT",
      "CREDIT",
      "DEBIT",
    ]);
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("TTL expired without the reference: REJECTED with REFERENCE_NOT_FOUND and its event", async () => {
    const { app, sql } = suite();
    const clock = new ManualClock();
    const handle = await handleWith(clock);
    const wallet = await createWallet(handle.app, "100.00");
    const refund = await handle.app.processWagerTransaction.execute(
      wagerCommand(wallet, "REFUND", { amount: "30.00", reference: "bet-never" }),
      CTX,
    );

    clock.advance(TEST_PENDING_REFERENCE.ttlMs);
    expect((await cycle(handle, wallet.id)).outcomes).toEqual(["REJECTED"]);
    expect(await transactionRow(sql, refund.transactionId)).toMatchObject({
      status: "REJECTED",
      failure_code: "REFERENCE_NOT_FOUND",
      next_reference_check_at: null,
    });
    expect((await outboxEventTypes(sql, wallet.id)).slice(-2)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
    ]);
    expect(await app.getTransaction.execute(refund.transactionId)).toMatchObject({
      status: "REJECTED",
      failureCode: "REFERENCE_NOT_FOUND",
      balance: { amount: "100.00", currency: "BRL" },
    });
    expect(await walletState(sql, wallet.id)).toEqual({ balance: "100.00", version: 1 });
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("TTL expired with the reference still pending: REFERENCE_NOT_PROCESSED", async () => {
    const { sql } = suite();
    const clock = new ManualClock();
    const handle = await handleWith(clock);
    const wallet = await createWallet(handle.app, "100.00");
    const refund = await handle.app.processWagerTransaction.execute(
      wagerCommand(wallet, "REFUND", {
        externalTransactionId: "refund-x",
        amount: "30.00",
        reference: "bet-x",
      }),
      CTX,
    );
    const rollback = await handle.app.processWagerTransaction.execute(
      wagerCommand(wallet, "ROLLBACK", { amount: "30.00", reference: "refund-x" }),
      CTX,
    );
    clock.advance(TEST_PENDING_REFERENCE.ttlMs);

    const recheck = handle.app.recheckPendingReferences;
    const candidate = (transactionId: string): PendingReferenceCandidate => ({
      transactionId,
      walletId: wallet.id,
    });
    // The ROLLBACK first, while the REFUND it references is still PENDING_REFERENCE.
    expect(await recheck.recheck(candidate(rollback.transactionId))).toBe(Status.Rejected);
    expect(await recheck.recheck(candidate(refund.transactionId))).toBe(Status.Rejected);
    expect((await transactionRow(sql, rollback.transactionId)).failure_code).toBe(
      "REFERENCE_NOT_PROCESSED",
    );
    expect((await transactionRow(sql, refund.transactionId)).failure_code).toBe(
      "REFERENCE_NOT_FOUND",
    );
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("the same candidate handled twice: the second finds it decided under the lock and skips", async () => {
    const { sql } = suite();
    const clock = new ManualClock();
    const handle = await handleWith(clock, LONG_BACKOFF);
    const wallet = await createWallet(handle.app, "100.00");
    const refund = await handle.app.processWagerTransaction.execute(
      wagerCommand(wallet, "REFUND", { amount: "30.00", reference: "bet-twice" }),
      CTX,
    );
    await handle.app.processWagerTransaction.execute(
      wagerCommand(wallet, "BET", { externalTransactionId: "bet-twice", amount: "30.00" }),
      CTX,
    );
    const candidate = { transactionId: refund.transactionId, walletId: wallet.id };
    expect(await handle.app.recheckPendingReferences.recheck(candidate)).toBe(Status.Processed);
    expect(await handle.app.recheckPendingReferences.recheck(candidate)).toBe("SKIPPED");
    expect(
      (await ledgerRows(sql, wallet.id)).filter(
        (row) => row.transaction_id === refund.transactionId,
      ),
    ).toHaveLength(1);
    expect(handle.metrics.count("pending_reference_checked{outcome=SKIPPED}")).toBe(1);
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("a permanent error of the transaction makes it FAILED, with WagerTransactionFailed", async () => {
    const { sql } = suite();
    const clock = new ManualClock();
    const handle = await handleWith(clock, LONG_BACKOFF);
    const wallet = await createWallet(handle.app, "100.00");
    const refund = await handle.app.processWagerTransaction.execute(
      wagerCommand(wallet, "REFUND", { amount: "30.00", reference: "bet-broken" }),
      CTX,
    );
    await handle.app.processWagerTransaction.execute(
      wagerCommand(wallet, "BET", { externalTransactionId: "bet-broken", amount: "30.00" }),
      CTX,
    );
    // Loading the reference state hits an invariant violation (as corrupted data would).
    const broken = await suite().open({
      pendingReference: LONG_BACKOFF,
      dependencies: (orm) => ({
        clock,
        unitOfWork: new TamperingUnitOfWork(new MikroOrmUnitOfWork(orm), (scope) => ({
          ...scope,
          transactions: override(scope.transactions, {
            findProcessedDependents: () =>
              Promise.reject(new InvalidOperationError("injected corrupted dependents")),
          }),
        })),
      }),
    });

    expect((await cycle(broken, wallet.id)).outcomes).toEqual(["FAILED"]);
    expect(await transactionRow(sql, refund.transactionId)).toMatchObject({
      status: "FAILED",
      failure_code: "INTERNAL_PERMANENT_ERROR",
      next_reference_check_at: null,
    });
    expect((await outboxEventTypes(sql, wallet.id)).at(-1)).toBe("WagerTransactionFailed");
    expect(await walletState(sql, wallet.id)).toEqual({ balance: "70.00", version: 2 });
    expect((await cycle(handle, wallet.id)).candidates).toEqual([]);
    await assertLedgerInvariant(sql, wallet.id);
  });
});
