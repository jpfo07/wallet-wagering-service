import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { WalletBalanceChanged } from "../../../src/domain/events/wallet-balance-changed.ts";
import { computeWagerPayloadHash } from "../../../src/domain/idempotency/payload-hash.ts";
import { InboxMessage } from "../../../src/domain/messaging/inbox-message.ts";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message.ts";
import { FailureCode } from "../../../src/domain/shared/failure-code.ts";
import { Money } from "../../../src/domain/shared/money.ts";
import { WagerTransactionKind } from "../../../src/domain/wager/wager-transaction-kind.ts";
import { WagerTransaction } from "../../../src/domain/wager/wager-transaction.ts";
import { Wallet } from "../../../src/domain/wallet/wallet.ts";
import { InboxMessageMapper } from "../../../src/infrastructure/persistence/mappers/inbox-message.mapper.ts";
import { OutboxMessageMapper } from "../../../src/infrastructure/persistence/mappers/outbox-message.mapper.ts";
import { WagerTransactionMapper } from "../../../src/infrastructure/persistence/mappers/wager-transaction.mapper.ts";
import { WalletLedgerEntryMapper } from "../../../src/infrastructure/persistence/mappers/wallet-ledger-entry.mapper.ts";
import { WalletMapper } from "../../../src/infrastructure/persistence/mappers/wallet.mapper.ts";
import { buildOrmOptions } from "../../../src/infrastructure/persistence/mikro-orm.config.ts";
import { InboxMessageRecord } from "../../../src/infrastructure/persistence/models/inbox-message.model.ts";
import { OutboxMessageRecord } from "../../../src/infrastructure/persistence/models/outbox-message.model.ts";
import { WagerTransactionRecord } from "../../../src/infrastructure/persistence/models/wager-transaction.model.ts";
import { WalletLedgerEntryRecord } from "../../../src/infrastructure/persistence/models/wallet-ledger-entry.model.ts";
import { WalletRecord } from "../../../src/infrastructure/persistence/models/wallet.model.ts";
import { createIsolatedDatabase, openSql } from "../../support/database.ts";
import type { IsolatedDatabase } from "../../support/database.ts";
import { assertLedgerInvariant } from "../../support/ledger-invariant.ts";
import { T0 } from "../../support/sql-fixtures.ts";
import { testDatabaseConfig } from "../../support/test-env.ts";

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const id = (): string => Bun.randomUUIDv7();

function openWallet(balance: string): { wallet: Wallet; opening: WagerTransaction | undefined } {
  const walletId = id();
  const playerId = id();
  const initialBalance = brl(balance);
  const transactionId = id();
  const wallet = Wallet.open({
    id: walletId,
    playerId,
    initialBalance,
    at: T0,
    opening: initialBalance.isPositive() ? { transactionId, ledgerEntryId: id() } : undefined,
  });
  const opening = initialBalance.isPositive()
    ? WagerTransaction.opening({
        id: transactionId,
        walletId,
        playerId,
        money: initialBalance,
        at: T0,
      })
    : undefined;
  return { wallet, opening };
}

function wager(
  wallet: Wallet,
  kind: WagerTransactionKind,
  props: { money?: Money; reference?: string } = {},
) {
  const externalTransactionId = `ext-${id()}`;
  const fields = {
    providerId: "provider-a",
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money: props.money ?? brl("10.00"),
    referenceExternalTransactionId: props.reference,
  };
  return WagerTransaction.create({
    ...fields,
    id: id(),
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: computeWagerPayloadHash(fields),
    createdAt: T0,
  });
}

describe("persistence mapping: domain → PostgreSQL → domain (real ORM)", () => {
  let db: IsolatedDatabase;
  let orm: MikroORM;

  beforeAll(async () => {
    db = await createIsolatedDatabase("schema-mapping");
    orm = await MikroORM.init(buildOrmOptions(testDatabaseConfig(db.name)));
  });

  afterAll(async () => {
    await orm.close(true);
    await db.drop();
  });

  async function persistOpened(balance: string): Promise<Wallet> {
    const { wallet, opening } = openWallet(balance);
    const entries = wallet.pullNewLedgerEntries();
    await orm.em.fork().transactional((em) => {
      em.create(WalletRecord, WalletMapper.toRow(wallet));
      if (opening !== undefined)
        em.create(WagerTransactionRecord, WagerTransactionMapper.toRow(opening));
      for (const entry of entries)
        em.create(WalletLedgerEntryRecord, WalletLedgerEntryMapper.toRow(entry));
    });
    return wallet;
  }

  test.each(["0.10", "999999999999999999.99", "0.00"])(
    "wallet opened with %p: exact string round trip, OPENING and its entry",
    async (balance) => {
      const wallet = await persistOpened(balance);
      const em = orm.em.fork();
      const row = await em.findOneOrFail(WalletRecord, { id: wallet.id });
      expect(typeof row.balance).toBe("string");
      expect(row.balance).toBe(balance);
      expect(WalletMapper.toRow(WalletMapper.toDomain(row))).toEqual(WalletMapper.toRow(wallet));

      const entries = await em.find(WalletLedgerEntryRecord, { walletId: wallet.id });
      expect(
        entries.map((e) => WalletLedgerEntryMapper.toRow(WalletLedgerEntryMapper.toDomain(e))),
      ).toEqual(entries.map((e) => ({ ...e })));
      expect(entries.map((e) => e.walletVersion)).toEqual(balance === "0.00" ? [] : [1]);

      const sql = openSql(db.name);
      try {
        await assertLedgerInvariant(sql, wallet.id);
      } finally {
        await sql.close();
      }
    },
  );

  test("transactions in every persisted state keep all fields (null ↔ undefined)", async () => {
    const wallet = await persistOpened("100.00");
    const pending = wager(wallet, WagerTransactionKind.Refund, { reference: "bet-not-yet" });
    pending.markPendingReference({
      observedBalance: wallet.balance,
      nextCheckAt: at(1_000),
      expiresAt: at(900_000),
      at: T0,
    });
    pending.scheduleNextReferenceCheck({ nextCheckAt: at(3_000), at: at(1_000) });

    const currencyMismatch = wager(wallet, WagerTransactionKind.Bet, {
      money: Money.from({ amount: "10.00", currency: "USD" }),
    });
    currencyMismatch.reject({
      code: FailureCode.CurrencyMismatch,
      observedBalance: wallet.balance,
      at: T0,
    });

    const failed = wager(wallet, WagerTransactionKind.Bet);
    failed.fail({ code: FailureCode.InternalPermanentError, at: T0 });

    const loss = wager(wallet, WagerTransactionKind.Loss, { money: brl("0.00") });
    loss.markProcessed({
      referenceTransactionId: undefined,
      observedBalance: wallet.balance,
      at: T0,
    });

    const all = [pending, currencyMismatch, failed, loss];
    await orm.em.fork().transactional((em) => {
      for (const tx of all) em.create(WagerTransactionRecord, WagerTransactionMapper.toRow(tx));
    });

    const em = orm.em.fork();
    for (const tx of all) {
      const row = await em.findOneOrFail(WagerTransactionRecord, { id: tx.id });
      const back = WagerTransactionMapper.toDomain(row);
      expect(WagerTransactionMapper.toRow(back)).toEqual(WagerTransactionMapper.toRow(tx));
    }
    const failedBack = WagerTransactionMapper.toDomain(
      await em.findOneOrFail(WagerTransactionRecord, { id: failed.id }),
    );
    expect(failedBack.observedBalance).toBeUndefined();
    expect(failedBack.processedAt).toBeUndefined();
    const pendingBack = WagerTransactionMapper.toDomain(
      await em.findOneOrFail(WagerTransactionRecord, { id: pending.id }),
    );
    expect(pendingBack.referenceAttempts).toBe(1);
    expect(pendingBack.nextReferenceCheckAt?.toISOString()).toBe(at(3_000).toISOString());
  });

  test("inbox and outbox messages", async () => {
    const wallet = await persistOpened("100.00");
    const entry = wallet.debit({
      transactionId: id(),
      money: brl("25.00"),
      ledgerEntryId: id(),
      at: T0,
    });
    const outbox = OutboxMessage.enqueue(
      WalletBalanceChanged.from(wallet, entry, {
        eventId: id(),
        correlationId: "corr-1",
        occurredAt: T0,
      }),
    );
    const inbox = InboxMessage.receive({
      messageId: "msg-123",
      consumerName: "wager-consumer",
      payloadHash: "f".repeat(64),
      receivedAt: T0,
    });
    inbox.markProcessed(T0);

    await orm.em.fork().transactional((em) => {
      em.create(OutboxMessageRecord, OutboxMessageMapper.toRow(outbox));
      em.create(InboxMessageRecord, InboxMessageMapper.toRow(inbox));
    });

    const em = orm.em.fork();
    const outboxBack = OutboxMessageMapper.toDomain(
      await em.findOneOrFail(OutboxMessageRecord, { id: outbox.id }),
    );
    expect(OutboxMessageMapper.toRow(outboxBack)).toEqual(OutboxMessageMapper.toRow(outbox));
    expect(outboxBack.isDue(T0)).toBe(true);
    const inboxBack = InboxMessageMapper.toDomain(
      await em.findOneOrFail(InboxMessageRecord, {
        consumerName: "wager-consumer",
        messageId: "msg-123",
      }),
    );
    expect(InboxMessageMapper.toRow(inboxBack)).toEqual(InboxMessageMapper.toRow(inbox));
  });
});
