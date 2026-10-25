import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { ConfigError } from "../../../src/infrastructure/config/env.ts";
import type { DatabaseConfig, SqsConsumerConfig } from "../../../src/infrastructure/config/env.ts";
import { WAGER_CONSUMER_NAME } from "../../../src/infrastructure/messaging/wager-queue-consumer.ts";
import { useApplicationSuite } from "../../support/application-suite.ts";
import type { AppHandle } from "../../support/application-suite.ts";
import {
  createWallet,
  inboxRow,
  ledgerRows,
  outboxEventTypes,
  transactionRows,
  wagerCommand,
  walletState,
} from "../../support/command-builders.ts";
import {
  attribute,
  isQueueEmpty,
  peekDlq,
  queueCounts,
  sendCommand,
  sendRaw,
  startTestConsumer,
  wagerEnvelope,
} from "../../support/consumer-support.ts";
import type { TestConsumer } from "../../support/consumer-support.ts";
import { assertLedgerInvariant } from "../../support/ledger-invariant.ts";
import { holdWalletLock, lockWaiters } from "../../support/lock-barrier.ts";
import { waitFor } from "../../support/polling.ts";
import { createIsolatedQueues, testSqsClient } from "../../support/queues.ts";
import type { IsolatedQueues, IsolatedQueuesOptions } from "../../support/queues.ts";

describe("SQS consumer (real LocalStack and PostgreSQL)", () => {
  const suite = useApplicationSuite("sqs-consumer");
  let sqs: SQSClient;
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(() => {
    sqs = testSqsClient();
  });

  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    sqs.destroy();
  });

  /** Fresh queues and a running consumer, both torn down at the end of the suite. */
  async function consumerOn(
    options: {
      readonly queues?: IsolatedQueuesOptions;
      readonly database?: Partial<DatabaseConfig>;
      readonly consumer?: Partial<SqsConsumerConfig>;
    } = {},
  ): Promise<{ queues: IsolatedQueues; consumer: TestConsumer; handle: AppHandle }> {
    const queues = await createIsolatedQueues("consumer", options.queues);
    cleanups.push(() => queues.delete());
    const handle =
      options.database === undefined ? suite() : await suite().open({ database: options.database });
    const consumer = await startTestConsumer({
      sqs,
      queues,
      handle,
      database: { ...suite().db.config, ...options.database },
      ...(options.consumer === undefined ? {} : { consumer: options.consumer }),
    });
    cleanups.push(() => consumer.stop());
    return { queues, consumer, handle };
  }

  /** Wager transactions of the wallet, without the OPENING written by createWallet. */
  const wagers = async (walletId: string) =>
    (await transactionRows(suite().sql, walletId)).filter((row) => row.kind !== "OPENING");

  const acks = (consumer: TestConsumer): number =>
    consumer.metrics.count("sqs_handled{action=ack}");

  test("a BET is processed once: ledger, inbox, outbox, and the message is deleted", async () => {
    const { sql } = suite();
    const { queues, consumer } = await consumerOn();
    const wallet = await createWallet(suite().app, "100.00");
    const { messageId } = await sendCommand(
      sqs,
      queues.wagerQueueUrl,
      wagerCommand(wallet, "BET", { amount: "25.00" }),
    );

    await waitFor(() => acks(consumer) === 1, { description: "the BET to be acknowledged" });
    await waitFor(() => isQueueEmpty(sqs, queues.wagerQueueUrl), { description: "empty queue" });
    expect((await walletState(sql, wallet.id)).balance).toBe("75.00");
    expect(await ledgerRows(sql, wallet.id)).toHaveLength(2); // OPENING + BET
    expect(await inboxRow(sql, WAGER_CONSUMER_NAME, messageId)).toEqual({ processed: true });
    expect(await outboxEventTypes(sql, wallet.id)).toEqual([
      "WagerTransactionProcessed", // OPENING
      "WalletBalanceChanged",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    expect(await isQueueEmpty(sqs, queues.dlqUrl)).toBe(true);
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("redelivery of the same message (same messageId, new SQS send) has no second effect", async () => {
    const { sql } = suite();
    const { queues, consumer } = await consumerOn();
    const wallet = await createWallet(suite().app, "100.00");
    const envelope = wagerEnvelope(wagerCommand(wallet, "BET", { amount: "10.00" }));
    await sendRaw(sqs, queues.wagerQueueUrl, envelope.body, wallet.id);
    await sendRaw(sqs, queues.wagerQueueUrl, envelope.body, wallet.id);

    await waitFor(() => acks(consumer) === 2, { description: "both copies acknowledged" });
    expect((await walletState(sql, wallet.id)).balance).toBe("90.00");
    expect(await wagers(wallet.id)).toHaveLength(1);
    expect(await ledgerRows(sql, wallet.id)).toHaveLength(2);
    expect(consumer.logger.find("sqs message acknowledged")).toHaveLength(2);
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("business outcomes are acknowledged: REJECTED, PENDING_REFERENCE, WALLET_NOT_FOUND, conflict", async () => {
    const { sql } = suite();
    const { queues, consumer } = await consumerOn();
    const wallet = await createWallet(suite().app, "5.00");
    const bet = wagerCommand(wallet, "BET", { amount: "1.00" });
    await sendCommand(sqs, queues.wagerQueueUrl, bet);
    await waitFor(() => acks(consumer) === 1, { description: "first BET" });

    await sendCommand(sqs, queues.wagerQueueUrl, wagerCommand(wallet, "BET", { amount: "50.00" }));
    await sendCommand(
      sqs,
      queues.wagerQueueUrl,
      wagerCommand(wallet, "REFUND", { amount: "1.00", reference: "bet-not-yet-arrived" }),
    );
    // Same key as the first BET, another amount → IDEMPOTENCY_KEY_REUSED.
    await sendCommand(sqs, queues.wagerQueueUrl, {
      ...wagerCommand(wallet, "BET", { amount: "2.00" }),
      externalTransactionId: bet.externalTransactionId,
      idempotencyKey: bet.idempotencyKey,
    });
    await sendCommand(
      sqs,
      queues.wagerQueueUrl,
      wagerCommand(wallet, "BET", { walletId: Bun.randomUUIDv7() }),
    );

    await waitFor(() => acks(consumer) === 5, { description: "all outcomes acknowledged" });
    const outcomes = consumer.logger
      .find("sqs message acknowledged")
      .map((entry) => entry.fields["outcome"]);
    expect(outcomes.map(String).sort()).toEqual([
      "IDEMPOTENCY_KEY_REUSED",
      "INSUFFICIENT_FUNDS",
      "PENDING_REFERENCE",
      "PROCESSED",
      "WALLET_NOT_FOUND",
    ]);
    expect(await isQueueEmpty(sqs, queues.wagerQueueUrl)).toBe(true);
    expect(await isQueueEmpty(sqs, queues.dlqUrl)).toBe(true);
    expect((await walletState(sql, wallet.id)).balance).toBe("4.00");
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("malformed messages go to the DLQ at once (receiveCount 1), with the reason", async () => {
    const { sql } = suite();
    const { queues, consumer } = await consumerOn();
    const wallet = await createWallet(suite().app, "100.00");
    await sendRaw(sqs, queues.wagerQueueUrl, "{not json", "g-1");
    await sendRaw(
      sqs,
      queues.wagerQueueUrl,
      JSON.stringify({
        ...(JSON.parse(wagerEnvelope(wagerCommand(wallet, "BET")).body) as Record<string, unknown>),
        type: "X",
      }),
      wallet.id,
    );
    // Shape is fine; Money refuses "25" (INVALID_AMOUNT).
    await sendCommand(sqs, queues.wagerQueueUrl, wagerCommand(wallet, "BET", { amount: "25" }));

    await waitFor(async () => (await queueCounts(sqs, queues.dlqUrl)).visible === 3, {
      description: "3 messages in the DLQ",
    });
    expect(await isQueueEmpty(sqs, queues.wagerQueueUrl)).toBe(true);
    expect(consumer.metrics.count("sqs_handled{action=retry}")).toBe(0);
    const codes = consumer.logger
      .find("sqs message sent to the DLQ")
      .map((entry) => entry.fields["failureCode"]);
    expect(codes.sort()).toEqual(["INVALID_AMOUNT", "MALFORMED_MESSAGE", "MALFORMED_MESSAGE"]);
    for (const message of await peekDlq(sqs, queues.dlqUrl)) {
      expect(attribute(message, "receiveCount")).toBe("1");
      expect(attribute(message, "consumer")).toBe(WAGER_CONSUMER_NAME);
      expect(attribute(message, "reason")?.length).toBeGreaterThan(0);
    }
    expect(await wagers(wallet.id)).toHaveLength(0);
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("poison message: same messageId with another payload → DLQ; two of them both stay for audit", async () => {
    const { sql } = suite();
    const { queues, consumer } = await consumerOn();
    const wallet = await createWallet(suite().app, "100.00");
    const { messageId } = await sendCommand(
      sqs,
      queues.wagerQueueUrl,
      wagerCommand(wallet, "BET", { amount: "10.00" }),
    );
    await waitFor(() => acks(consumer) === 1, { description: "original processed" });

    // Two different sends reusing the producer's messageId: each SQS MessageId is unique, so the
    // DLQ deduplication (by SQS MessageId) keeps both.
    const poisonA = await sendCommand(
      sqs,
      queues.wagerQueueUrl,
      wagerCommand(wallet, "BET", { amount: "99.00" }),
      messageId,
    );
    const poisonB = await sendCommand(
      sqs,
      queues.wagerQueueUrl,
      wagerCommand(wallet, "BET", { amount: "98.00" }),
      messageId,
    );

    await waitFor(async () => (await queueCounts(sqs, queues.dlqUrl)).visible === 2, {
      description: "both poison messages in the DLQ",
    });
    const dead = consumer.logger.find("sqs message sent to the DLQ");
    expect(dead.map((entry) => entry.fields["failureCode"])).toEqual([
      "POISON_MESSAGE",
      "POISON_MESSAGE",
    ]);
    expect(dead.map((entry) => entry.fields["sqsMessageId"]).sort()).toEqual(
      [poisonA.sqsMessageId, poisonB.sqsMessageId].sort(),
    );
    expect((await walletState(sql, wallet.id)).balance).toBe("90.00");
    expect(await wagers(wallet.id)).toHaveLength(1);
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("transient failure: visibility backoff by receive count, then processed once", async () => {
    const { sql } = suite();
    const { queues, consumer } = await consumerOn({ database: { lockTimeoutMs: 100 } });
    const wallet = await createWallet(suite().app, "100.00");
    const lock = await holdWalletLock(sql, wallet.id);
    try {
      await sendCommand(sqs, queues.wagerQueueUrl, wagerCommand(wallet, "BET", { amount: "7.00" }));
      await waitFor(() => consumer.logger.find("sqs message will be retried").length >= 2, {
        timeoutMs: 15_000,
        description: "two retries",
      });
      const retries = consumer.logger.find("sqs message will be retried");
      expect(retries.map((entry) => entry.fields["receiveCount"]).slice(0, 2)).toEqual([1, 2]);
      expect(retries.every((entry) => entry.fields["reason"] === "55P03")).toBe(true);
      expect(retries.every((entry) => Number(entry.fields["delaySeconds"]) >= 1)).toBe(true);
      expect(await wagers(wallet.id)).toHaveLength(0);
    } finally {
      await lock.release();
    }
    await waitFor(() => acks(consumer) === 1, { timeoutMs: 15_000, description: "processed" });
    expect((await walletState(sql, wallet.id)).balance).toBe("93.00");
    expect(await isQueueEmpty(sqs, queues.dlqUrl)).toBe(true);
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("transient failures past maxReceiveCount: the redrive policy moves the message to the DLQ", async () => {
    const { sql } = suite();
    const { queues, consumer } = await consumerOn({
      queues: { maxReceiveCount: 2 },
      database: { lockTimeoutMs: 100 },
    });
    const wallet = await createWallet(suite().app, "100.00");
    const lock = await holdWalletLock(sql, wallet.id);
    try {
      await sendCommand(sqs, queues.wagerQueueUrl, wagerCommand(wallet, "BET", { amount: "7.00" }));
      await waitFor(async () => (await queueCounts(sqs, queues.dlqUrl)).visible === 1, {
        timeoutMs: 20_000,
        description: "message redriven to the DLQ",
      });
      expect(await isQueueEmpty(sqs, queues.wagerQueueUrl)).toBe(true);
      expect(consumer.logger.find("sqs message will be retried")).toHaveLength(2);
      expect(consumer.metrics.count("sqs_handled{action=dlq}")).toBe(0);
    } finally {
      await lock.release();
    }
    expect(await wagers(wallet.id)).toHaveLength(0);
    expect((await walletState(sql, wallet.id)).balance).toBe("100.00");
    await assertLedgerInvariant(sql, wallet.id);
  });

  test("stop() with a message in flight: waits the drain, then gives its visibility back", async () => {
    const { sql } = suite();
    const queues = await createIsolatedQueues("consumer-stop");
    cleanups.push(() => queues.delete());
    const first = await startTestConsumer({
      sqs,
      queues,
      handle: suite(),
      database: suite().db.config,
      consumer: { shutdownDrainMs: 300 },
    });
    const wallet = await createWallet(suite().app, "100.00");
    const lock = await holdWalletLock(sql, wallet.id);
    try {
      await sendCommand(sqs, queues.wagerQueueUrl, wagerCommand(wallet, "BET", { amount: "3.00" }));
      await waitFor(async () => (await lockWaiters(sql)) >= 1, {
        description: "consumer blocked on the wallet lock",
      });
      await first.stop();
      expect(first.metrics.count("sqs_released")).toBe(1);
      // Visible again right away, not after the 60 s VisibilityTimeout.
      await waitFor(async () => (await queueCounts(sqs, queues.wagerQueueUrl)).visible === 1, {
        timeoutMs: 3_000,
        description: "message visible again",
      });
    } finally {
      await lock.release();
    }
    const second = await startTestConsumer({
      sqs,
      queues,
      handle: suite(),
      database: suite().db.config,
    });
    cleanups.push(() => second.stop());
    await waitFor(() => acks(second) === 1, { description: "processed by the next consumer" });
    // The first attempt was still waiting on the lock when released; whichever commits first wins,
    // the other replays: one effect either way.
    await waitFor(() => isQueueEmpty(sqs, queues.wagerQueueUrl), { description: "empty queue" });
    expect((await walletState(sql, wallet.id)).balance).toBe("97.00");
    expect(await wagers(wallet.id)).toHaveLength(1);
    await assertLedgerInvariant(sql, wallet.id);
  });

  describe("boot checks", () => {
    test("a VisibilityTimeout below the worst case refuses to start", async () => {
      const queues = await createIsolatedQueues("consumer-vt", { visibilityTimeoutSeconds: 30 });
      cleanups.push(() => queues.delete());
      const error = await startTestConsumer({
        sqs,
        queues,
        handle: suite(),
        database: suite().db.config,
      }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ConfigError);
    });

    test("a queue without a redrive policy to the configured DLQ refuses to start", async () => {
      const queues = await createIsolatedQueues("consumer-redrive");
      const other = await createIsolatedQueues("consumer-redrive-other");
      cleanups.push(
        () => queues.delete(),
        () => other.delete(),
      );
      // Main queue of one topology, DLQ of another: the redrive points elsewhere.
      const error = await startTestConsumer({
        sqs,
        queues: { ...queues, dlqName: other.dlqName },
        handle: suite(),
        database: suite().db.config,
      }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain("RedrivePolicy");
    });
  });
});
