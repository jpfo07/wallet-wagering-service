import { describe, expect, test } from "bun:test";
import {
  PersistenceIntegrityError,
  PoisonMessageError,
  StaleWalletVersionError,
  TransientFailureError,
  WalletNotFoundError,
} from "../../../src/application/errors.ts";
import type { InboxDelivery } from "../../../src/application/wager/process-wager-transaction.ts";
import { TransactionRunner } from "../../../src/application/transaction-runner.ts";
import { computeWagerPayloadHash } from "../../../src/domain/idempotency/payload-hash.ts";
import { ExponentialBackoff } from "../../../src/domain/shared/backoff-policy.ts";
import { Money } from "../../../src/domain/shared/money.ts";
import { WagerTransactionKind } from "../../../src/domain/wager/wager-transaction-kind.ts";
import { WagerTransactionStatus } from "../../../src/domain/wager/wager-transaction-status.ts";
import { WagerTransaction } from "../../../src/domain/wager/wager-transaction.ts";
import { InMemoryApplicationMetrics, SilentLogger } from "../../support/in-memory-telemetry.ts";
import { MikroOrmUnitOfWork } from "../../../src/infrastructure/persistence/mikro-orm-unit-of-work.ts";
import { MathRandomSource } from "../../../src/infrastructure/system/system-adapters.ts";
import { RecordingSleeper, useApplicationSuite } from "../../support/application-suite.ts";
import {
  CTX,
  createWallet,
  inboxRow,
  ledgerRows,
  outboxEventTypes,
  transactionRows,
  wagerCommand,
  walletState,
} from "../../support/command-builders.ts";
import { assertLedgerInvariant } from "../../support/ledger-invariant.ts";
import { holdWalletLock } from "../../support/lock-barrier.ts";
import { InjectedFault, TamperingUnitOfWork, override } from "../../support/tampering.ts";

const CONSUMER = "wager-consumer";

describe("failures, retries and inbox (real PostgreSQL)", () => {
  const suite = useApplicationSuite("app-failures-inbox");

  /** Everything a wager could have written, for "nothing persisted" assertions. */
  const footprint = async (walletId: string, delivery?: InboxDelivery) => {
    const { sql } = suite();
    return {
      wallet: await walletState(sql, walletId),
      transactions: await transactionRows(sql, walletId),
      ledger: await ledgerRows(sql, walletId),
      outbox: await outboxEventTypes(sql, walletId),
      inbox: delivery === undefined ? undefined : await inboxRow(sql, CONSUMER, delivery.messageId),
    };
  };

  describe("atomicity: a failure in the middle persists nothing", () => {
    test("application fault after transaction, ledger and wallet were written, before the outbox", async () => {
      const { sql } = suite();
      const wallet = await createWallet(suite().app, "100.00");
      const delivery = { consumerName: CONSUMER, messageId: `msg-${Bun.randomUUIDv7()}` };
      const before = await footprint(wallet.id, delivery);
      const reached: string[] = [];
      const faulty = await suite().open({
        dependencies: (orm) => ({
          unitOfWork: new TamperingUnitOfWork(new MikroOrmUnitOfWork(orm), (scope) => ({
            ...scope,
            transactions: override(scope.transactions, {
              insert: async (tx) => {
                await scope.transactions.insert(tx);
                reached.push("transaction");
              },
            }),
            wallets: override(scope.wallets, {
              save: async (w, version) => {
                const entries = await scope.wallets.save(w, version);
                reached.push("ledger+wallet");
                return entries;
              },
            }),
            outbox: override(scope.outbox, {
              enqueue: () => Promise.reject(new InjectedFault("outbox down")),
            }),
          })),
        }),
      });

      const error = await faulty.app.processWagerTransaction
        .execute(wagerCommand(wallet, "BET", { amount: "30.00" }), CTX, delivery)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InjectedFault);
      expect(reached).toEqual(["transaction", "ledger+wallet"]);
      expect(await footprint(wallet.id, delivery)).toEqual(before);

      // The same request without the fault is processed exactly once.
      const ok = await suite().app.processWagerTransaction.execute(
        wagerCommand(wallet, "BET", { amount: "30.00" }),
        CTX,
        delivery,
      );
      expect(ok).toMatchObject({ status: "PROCESSED", idempotentReplay: false });
      expect(await walletState(sql, wallet.id)).toEqual({ balance: "70.00", version: 2 });
      await assertLedgerInvariant(sql, wallet.id);
    });

    test("database fault: a real PostgreSQL error on the outbox insert rolls everything back", async () => {
      const { sql } = suite();
      const wallet = await createWallet(suite().app, "100.00");
      const delivery = { consumerName: CONSUMER, messageId: `msg-${Bun.randomUUIDv7()}` };
      const before = await footprint(wallet.id, delivery);
      await sql.unsafe(`
        create function test_outbox_fault() returns trigger language plpgsql as $$
        begin raise exception 'injected outbox failure' using errcode = 'P0001'; end $$`);
      await sql.unsafe(`create trigger test_outbox_fault before insert on outbox_messages
                          for each row execute function test_outbox_fault()`);
      try {
        const error = await suite()
          .app.processWagerTransaction.execute(
            wagerCommand(wallet, "BET", { amount: "30.00" }),
            CTX,
            delivery,
          )
          .catch((e: unknown) => e);
        expect(String(error)).toContain("injected outbox failure");
        expect(await footprint(wallet.id, delivery)).toEqual(before);
      } finally {
        await sql.unsafe("drop trigger test_outbox_fault on outbox_messages");
        await sql.unsafe("drop function test_outbox_fault()");
      }
      await assertLedgerInvariant(sql, wallet.id);
    });
  });

  describe("transient errors are retried a bounded number of times", () => {
    test("lock held by another instance: lock_timeout (55P03) → retries → TransientFailureError, nothing written", async () => {
      const { sql } = suite();
      const wallet = await createWallet(suite().app, "100.00");
      const impatient = await suite().open({ database: { lockTimeoutMs: 150 } });
      const before = await footprint(wallet.id);
      const command = wagerCommand(wallet, "BET", { amount: "10.00" });

      const lock = await holdWalletLock(sql, wallet.id);
      let error: unknown;
      try {
        error = await impatient.app.processWagerTransaction
          .execute(command, CTX)
          .catch((e: unknown) => e);
      } finally {
        await lock.release();
      }
      expect(error).toBeInstanceOf(TransientFailureError);
      expect((error as TransientFailureError).attempts).toBe(3);
      expect(impatient.sleeper.delays).toHaveLength(2);
      expect(impatient.metrics.count("transient_retry{reason=55P03}")).toBe(2);
      expect(await footprint(wallet.id)).toEqual(before);

      // Lock released: the same request now goes through, once.
      const result = await impatient.app.processWagerTransaction.execute(command, CTX);
      expect(result).toMatchObject({ status: "PROCESSED", balance: { amount: "90.00" } });
      await assertLedgerInvariant(sql, wallet.id);
    });

    test("serialization failure (40001) on the first attempt only: retried, one single debit", async () => {
      const { sql } = suite();
      const wallet = await createWallet(suite().app, "100.00");
      // nextval is not transactional: the failed attempt's rollback does not reset it.
      await sql.unsafe("create sequence test_fail_once_seq");
      await sql.unsafe(`
        create function test_fail_once() returns trigger language plpgsql as $$
        begin
          if nextval('test_fail_once_seq') = 1 then
            raise exception 'injected serialization failure' using errcode = '40001';
          end if;
          return new;
        end $$`);
      await sql.unsafe(`create trigger test_fail_once before insert on wallet_ledger_entries
                          for each row execute function test_fail_once()`);
      try {
        const retriesBefore = suite().metrics.count("transient_retry{reason=40001}");
        const result = await suite().app.processWagerTransaction.execute(
          wagerCommand(wallet, "BET", { amount: "10.00" }),
          CTX,
        );
        expect(result).toMatchObject({ status: "PROCESSED", balance: { amount: "90.00" } });
        expect(suite().metrics.count("transient_retry{reason=40001}")).toBe(retriesBefore + 1);
      } finally {
        await sql.unsafe("drop trigger test_fail_once on wallet_ledger_entries");
        await sql.unsafe("drop function test_fail_once()");
        await sql.unsafe("drop sequence test_fail_once_seq");
      }
      const debits = (await ledgerRows(sql, wallet.id)).filter((e) => e.direction === "DEBIT");
      expect(debits).toHaveLength(1);
      await assertLedgerInvariant(sql, wallet.id);
    });
  });

  describe("bugs are never retried", () => {
    const runnerWithSleeper = () => {
      const sleeper = new RecordingSleeper();
      const runner = new TransactionRunner(
        suite().app.dependencies.unitOfWork,
        { maxAttempts: 3, backoff: ExponentialBackoff.of({ baseMs: 10, maxMs: 40 }) },
        sleeper,
        new MathRandomSource(),
        new InMemoryApplicationMetrics(),
        new SilentLogger(),
      );
      return { runner, sleeper };
    };

    test("a deferred check failing at COMMIT is a PersistenceIntegrityError, attempted once", async () => {
      const { sql } = suite();
      const wallet = await createWallet(suite().app, "100.00");
      const { runner, sleeper } = runnerWithSleeper();
      const fields = {
        providerId: "provider-a",
        externalTransactionId: `bug-${Bun.randomUUIDv7()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: "10.00", currency: "BRL" }),
      };
      const at = new Date();
      const tx = WagerTransaction.create({
        ...fields,
        id: Bun.randomUUIDv7(),
        idempotencyKey: `provider-a:${fields.externalTransactionId}`,
        payloadHash: computeWagerPayloadHash(fields),
        createdAt: at,
      });
      // A PROCESSED BET without its ledger entry: only T7, at COMMIT, can notice.
      tx.markProcessed({
        referenceTransactionId: undefined,
        observedBalance: Money.from({ amount: "90.00", currency: "BRL" }),
        at,
      });

      const error = await runner
        .run((scope) => scope.transactions.insert(tx))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PersistenceIntegrityError);
      expect(error).toMatchObject({
        sqlState: "23514",
        constraint: "wager_transactions_processed_has_entry",
      });
      expect(sleeper.delays).toEqual([]);
      expect(await transactionRows(sql, wallet.id)).toHaveLength(1);
      await assertLedgerInvariant(sql, wallet.id);
    });

    test("versioned UPDATE matching no row is StaleWalletVersionError and rolls back the entry", async () => {
      const { sql } = suite();
      const wallet = await createWallet(suite().app, "100.00");
      const { runner, sleeper } = runnerWithSleeper();
      const before = await footprint(wallet.id);

      const error = await runner
        .run(async (scope) => {
          const locked = await scope.wallets.lockById(wallet.id);
          if (locked === undefined) throw new Error("wallet must exist");
          locked.debit({
            transactionId: Bun.randomUUIDv7(),
            money: Money.from({ amount: "10.00", currency: "BRL" }),
            ledgerEntryId: Bun.randomUUIDv7(),
            at: new Date(),
          });
          // Wrong expectation on purpose: the version read was 1, not 2.
          await scope.wallets.save(locked, locked.version);
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StaleWalletVersionError);
      expect(sleeper.delays).toEqual([]);
      expect(await footprint(wallet.id)).toEqual(before);
      await assertLedgerInvariant(sql, wallet.id);
    });
  });

  describe("inbox (SQS deliveries), in the same transaction", () => {
    const deliver = (messageId: string) => ({ consumerName: CONSUMER, messageId });

    test("first delivery is recorded as processed", async () => {
      const { sql } = suite();
      const wallet = await createWallet(suite().app, "100.00");
      const messageId = `msg-${Bun.randomUUIDv7()}`;
      const result = await suite().app.processWagerTransaction.execute(
        wagerCommand(wallet, "BET"),
        { correlationId: "corr-sqs", causationId: messageId },
        deliver(messageId),
      );
      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(await inboxRow(sql, CONSUMER, messageId)).toEqual({ processed: true });
      const causation: { causation: string }[] = await sql.unsafe(
        "select payload->>'causationId' as causation from outbox_messages where aggregate_id = $1 and event_type = 'WalletBalanceChanged' order by occurred_at desc limit 1",
        [wallet.id],
      );
      expect(causation[0]?.causation).toBe(messageId);
      await assertLedgerInvariant(sql, wallet.id);
    });

    test("redelivery of the same message (same payload) replays without a second effect", async () => {
      const { sql } = suite();
      const wallet = await createWallet(suite().app, "100.00");
      const messageId = `msg-${Bun.randomUUIDv7()}`;
      const command = wagerCommand(wallet, "BET", { amount: "20.00" });
      const first = await suite().app.processWagerTransaction.execute(
        command,
        CTX,
        deliver(messageId),
      );
      const again = await suite().app.processWagerTransaction.execute(
        command,
        CTX,
        deliver(messageId),
      );
      expect(again).toEqual({ ...first, idempotentReplay: true });
      expect(await walletState(sql, wallet.id)).toEqual({ balance: "80.00", version: 2 });
      await assertLedgerInvariant(sql, wallet.id);
    });

    test("same command under a new messageId: replay, and the new delivery is recorded", async () => {
      const { sql } = suite();
      const wallet = await createWallet(suite().app, "100.00");
      const command = wagerCommand(wallet, "BET");
      const first = `msg-${Bun.randomUUIDv7()}`;
      const second = `msg-${Bun.randomUUIDv7()}`;
      await suite().app.processWagerTransaction.execute(command, CTX, deliver(first));
      const replay = await suite().app.processWagerTransaction.execute(
        command,
        CTX,
        deliver(second),
      );
      expect(replay.idempotentReplay).toBe(true);
      expect(await inboxRow(sql, CONSUMER, second)).toEqual({ processed: true });
      await assertLedgerInvariant(sql, wallet.id);
    });

    test.each([
      ["another amount", { amount: "99.00" }],
      ["another idempotency key", { idempotencyKey: "other-key" }],
    ] as const)(
      "same messageId with %s is a poison message; nothing is written",
      async (_label, patch) => {
        const { sql } = suite();
        const wallet = await createWallet(suite().app, "100.00");
        const messageId = `msg-${Bun.randomUUIDv7()}`;
        const externalTransactionId = `bet-${Bun.randomUUIDv7()}`;
        await suite().app.processWagerTransaction.execute(
          wagerCommand(wallet, "BET", { externalTransactionId }),
          CTX,
          deliver(messageId),
        );
        const before = await footprint(wallet.id);
        const error = await suite()
          .app.processWagerTransaction.execute(
            wagerCommand(wallet, "BET", { externalTransactionId, ...patch }),
            CTX,
            deliver(messageId),
          )
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(PoisonMessageError);
        expect(await footprint(wallet.id)).toEqual(before);
        await assertLedgerInvariant(sql, wallet.id);
      },
    );

    test("WALLET_NOT_FOUND from SQS leaves no inbox row", async () => {
      const { sql } = suite();
      const wallet = await createWallet(suite().app, "100.00");
      const messageId = `msg-${Bun.randomUUIDv7()}`;
      const error = await suite()
        .app.processWagerTransaction.execute(
          wagerCommand(wallet, "BET", { walletId: Bun.randomUUIDv7() }),
          CTX,
          deliver(messageId),
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WalletNotFoundError);
      expect(await inboxRow(sql, CONSUMER, messageId)).toBeUndefined();
    });
  });
});
