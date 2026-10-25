import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import type { Message, SQSClient } from "@aws-sdk/client-sqs";
import type { RandomSource } from "../../application/ports/system.ts";
import type { LogFields, Logger } from "../../application/ports/telemetry.ts";
import type { ProcessWagerTransaction } from "../../application/wager/process-wager-transaction.ts";
import type { ExponentialBackoff } from "../../domain/shared/backoff-policy.ts";
import { isAcceptableCorrelationId } from "../validation/wager-schemas.ts";
import { abortableSleep } from "./abortable-sleep.ts";
import type { DatabaseGate } from "./database-gate.ts";
import { ConsumerFailureCode, decideForError, decideForResult } from "./delivery-decision.ts";
import type { DeliveryDecision } from "./delivery-decision.ts";
import { parseWagerMessage } from "./wager-message-envelope.ts";

/**
 * The inbox key is (consumerName, messageId): the name must be the same in every instance,
 * otherwise each replica would have its own inbox and nothing would be deduplicated across them.
 */
export const WAGER_CONSUMER_NAME = "wager-transactions-consumer";

/** SQS limits. */
const MAX_BATCH = 10;
const MAX_VISIBILITY_SECONDS = 43_200;
const DLQ_ATTRIBUTE_MAX_LENGTH = 1_000;

export interface ConsumerMetrics {
  received(count: number): void;
  handled(action: DeliveryDecision["action"], outcome: string): void;
  deleteFailed(): void;
  released(count: number): void;
}

export interface WagerQueueConsumerOptions {
  readonly consumerName: string;
  readonly queueUrl: string;
  readonly dlqUrl: string;
  readonly concurrency: number;
  readonly waitTimeSeconds: number;
  /** Visibility of a retried message, by receive count. */
  readonly retryBackoff: ExponentialBackoff;
  readonly shutdownDrainMs: number;
}

export interface WagerQueueConsumerDependencies {
  readonly sqs: SQSClient;
  readonly processWager: ProcessWagerTransaction;
  readonly gate: DatabaseGate;
  readonly random: RandomSource;
  readonly logger: Logger;
  readonly metrics: ConsumerMetrics;
}

type MessageState = "waiting" | "processing" | "done";

interface Tracked {
  readonly message: Message;
  state: MessageState;
}

/**
 * Long-polling consumer of wager-transactions.fifo. Every message goes through the same use case as
 * HTTP, with the inbox recorded in the same SQL transaction, and is acknowledged only after that
 * transaction committed. See ARCHITECTURE.md, section 12.
 */
export class WagerQueueConsumer {
  private readonly abort = new AbortController();
  private readonly tracked = new Set<Tracked>();
  private readonly groups = new Set<Promise<void>>();
  private slotWaiters: (() => void)[] = [];
  private loop: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly options: WagerQueueConsumerOptions,
    private readonly deps: WagerQueueConsumerDependencies,
  ) {}

  start(): void {
    this.loop ??= this.run();
  }

  /**
   * Stops fetching, waits up to shutdownDrainMs for the messages in flight, and gives the
   * visibility of whatever did not finish back to the queue, so another instance takes it at once
   * instead of after the VisibilityTimeout.
   *
   * The long poll in progress is NOT aborted: the server does not see a client-side abort, and the
   * orphaned poll stays open there until WaitTimeSeconds, taking the next visible message (the very
   * ones released here) and hiding it for a whole VisibilityTimeout. Proven against LocalStack; see
   * ARCHITECTURE.md, section 12. So the last poll is awaited (≤ WaitTimeSeconds, short on purpose)
   * and whatever it brings is released too. The abort signal still cuts the database-gate wait and
   * the pauses between polls.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.abort.abort();
    this.wakeSlotWaiters();
    const deadline = new AbortController();
    const drained = Promise.all([this.loop, ...this.groups]).then(() => true);
    const timeout = abortableSleep(this.options.shutdownDrainMs, deadline.signal).then(() => false);
    const finished = await Promise.race([drained, timeout]);
    deadline.abort();
    // Release only after the last poll returned (≤ WaitTimeSeconds; run() releases what it
    // brings): a poll still open would take back the very messages released below.
    await this.loop;
    const unfinished = [...this.tracked];
    if (unfinished.length > 0) {
      // Marked done first, so the group loops do not release them a second time.
      for (const tracked of unfinished) this.finish(tracked);
      await this.release(
        unfinished.map((t) => t.message),
        "shutdown",
      );
    }
    this.deps.logger.info("sqs consumer stopped", {
      drained: finished,
      released: unfinished.length,
    });
  }

  private async run(): Promise<void> {
    const signal = this.abort.signal;
    while (!this.isStopping()) {
      await this.waitForSlot();
      if (this.isStopping()) break;
      if (!(await this.deps.gate.awaitAvailable(signal))) break;
      let messages: Message[];
      try {
        messages = await this.receive();
      } catch (error) {
        if (this.isStopping()) break;
        this.deps.logger.warn("sqs receive failed", { error: errorText(error) });
        await abortableSleep(1_000, signal);
        continue;
      }
      if (messages.length === 0) continue;
      this.deps.metrics.received(messages.length);
      if (this.isStopping()) {
        // The last poll, finished after the SIGTERM: not ours to process any more.
        await this.release(messages, "shutdown");
        break;
      }
      this.dispatch(messages);
    }
  }

  private async receive(): Promise<Message[]> {
    const free = this.options.concurrency - this.inFlight();
    const { Messages } = await this.deps.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages: Math.max(1, Math.min(MAX_BATCH, free)),
        WaitTimeSeconds: this.options.waitTimeSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
        MessageAttributeNames: ["correlationId"],
      }),
    );
    return Messages ?? [];
  }

  /**
   * A FIFO batch may hold several messages of the same group (walletId). They run one after the
   * other, in order; different groups run in parallel. Correctness does not depend on it (the
   * wallet lock does), but out-of-order processing would create needless PENDING_REFERENCEs.
   */
  private dispatch(messages: readonly Message[]): void {
    const byGroup = new Map<string, Tracked[]>();
    for (const message of messages) {
      const tracked: Tracked = { message, state: "waiting" };
      this.tracked.add(tracked);
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? "";
      const list = byGroup.get(group) ?? [];
      list.push(tracked);
      byGroup.set(group, list);
    }
    for (const list of byGroup.values()) {
      const task = this.runGroup(list);
      this.groups.add(task);
      void task.finally(() => {
        this.groups.delete(task);
      });
    }
  }

  private async runGroup(list: readonly Tracked[]): Promise<void> {
    for (let index = 0; index < list.length; index += 1) {
      const current = list[index];
      if (current === undefined) continue;
      if (current.state === "done") continue;
      if (this.stopping) {
        // Not started: give it back right away, the drain only waits for work in progress.
        const rest = list.slice(index).filter((t) => t.state !== "done");
        await this.finishAll(rest, (messages) => this.release(messages, "shutdown"));
        return;
      }
      current.state = "processing";
      let decision: DeliveryDecision;
      try {
        decision = await this.handle(current.message);
      } catch (error) {
        // handle() never throws by design; this is the last guard of the loop.
        this.deps.logger.error("sqs message handling crashed", { error: errorText(error) });
        decision = {
          action: "retry",
          reason: "HANDLER_CRASH",
          databaseUnavailable: false,
          log: "error",
        };
      } finally {
        this.finish(current);
      }
      if (decision.action === "retry") {
        // Keep the group's order: the later messages wait with it instead of overtaking it.
        const rest = list.slice(index + 1).filter((t) => t.state !== "done");
        if (rest.length > 0) {
          await this.finishAll(rest, (later) =>
            this.changeVisibility(later, this.retryDelaySeconds(current.message), "group-retry"),
          );
        }
        return;
      }
    }
  }

  /** Decides and applies the action for one message. Never throws. */
  private async handle(message: Message): Promise<DeliveryDecision> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    const parsed = parseWagerMessage(message.Body);
    if (!parsed.ok) {
      const decision: DeliveryDecision = {
        action: "dlq",
        failureCode: ConsumerFailureCode.MalformedMessage,
        reason: parsed.reason,
      };
      await this.apply(message, decision, { sqsMessageId: message.MessageId, receiveCount });
      return decision;
    }
    const { envelope } = parsed;
    const correlationAttribute = message.MessageAttributes?.["correlationId"]?.StringValue;
    const correlationId = isAcceptableCorrelationId(correlationAttribute)
      ? correlationAttribute
      : isAcceptableCorrelationId(envelope.messageId)
        ? envelope.messageId
        : (message.MessageId ?? "unknown");
    const fields: Record<string, LogFields[string]> = {
      messageId: envelope.messageId,
      sqsMessageId: message.MessageId,
      walletId: envelope.data.walletId,
      providerId: envelope.data.providerId,
      correlationId,
      receiveCount,
    };
    let decision: DeliveryDecision;
    try {
      const result = await this.deps.processWager.execute(
        envelope.data,
        { correlationId, causationId: envelope.messageId },
        { consumerName: this.options.consumerName, messageId: envelope.messageId },
      );
      this.deps.gate.markHealthy();
      decision = decideForResult(result);
      fields["transactionId"] = result.transactionId;
    } catch (error) {
      decision = decideForError(error);
      if (decision.action === "retry" && decision.databaseUnavailable) {
        this.deps.gate.markUnavailable(decision.reason);
      } else if (decision.action !== "retry") {
        // A terminal answer means the database was reached.
        this.deps.gate.markHealthy();
      }
      fields["error"] = errorText(error);
    }
    await this.apply(message, decision, fields);
    return decision;
  }

  private async apply(
    message: Message,
    decision: DeliveryDecision,
    fields: LogFields,
  ): Promise<void> {
    switch (decision.action) {
      case "ack":
        this.deps.logger[decision.log]("sqs message acknowledged", {
          ...fields,
          outcome: decision.outcome,
        });
        this.deps.metrics.handled("ack", decision.outcome);
        await this.delete(message);
        return;
      case "retry": {
        const delaySeconds = this.retryDelaySeconds(message);
        this.deps.logger[decision.log]("sqs message will be retried", {
          ...fields,
          reason: decision.reason,
          delaySeconds,
        });
        this.deps.metrics.handled("retry", decision.reason);
        await this.changeVisibility([message], delaySeconds, decision.reason);
        return;
      }
      case "dlq":
        this.deps.logger.error("sqs message sent to the DLQ", {
          ...fields,
          failureCode: decision.failureCode,
          reason: decision.reason,
        });
        this.deps.metrics.handled("dlq", decision.failureCode);
        await this.deadLetter(message, decision, fields);
        return;
    }
  }

  /**
   * Explicit dead-lettering: the original body and group, plus why. Deduplicated by the SQS
   * MessageId of the received message: stable across redeliveries of that message (a crash between
   * the send and the delete resends a copy the FIFO DLQ discards) and unique per send (two poison
   * messages reusing one producer messageId both stay in the DLQ for audit). Malformed bodies have
   * no envelope to read an id from anyway. If the send fails, the message is left alone: its
   * visibility expires and it is decided again.
   */
  private async deadLetter(
    message: Message,
    decision: Extract<DeliveryDecision, { action: "dlq" }>,
    fields: LogFields,
  ): Promise<void> {
    const attribute = (value: string) => ({
      DataType: "String",
      StringValue: value.slice(0, DLQ_ATTRIBUTE_MAX_LENGTH) || "-",
    });
    try {
      await this.deps.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.options.dlqUrl,
          MessageBody: message.Body ?? "",
          MessageGroupId: message.Attributes?.MessageGroupId ?? "malformed",
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: {
            failureCode: attribute(decision.failureCode),
            reason: attribute(decision.reason),
            consumer: attribute(this.options.consumerName),
            sourceMessageId: attribute(message.MessageId ?? ""),
            receiveCount: attribute(message.Attributes?.ApproximateReceiveCount ?? "1"),
          },
        }),
      );
    } catch (error) {
      this.deps.logger.error("sqs DLQ send failed, message left for redelivery", {
        ...fields,
        error: errorText(error),
      });
      return;
    }
    await this.delete(message);
  }

  /**
   * Only ever called after the use case returned, i.e. after COMMIT. If the process dies before
   * this, the message comes back and the inbox + idempotency turn it into a replay.
   */
  private async delete(message: Message): Promise<void> {
    try {
      await this.deps.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    } catch (error) {
      this.deps.metrics.deleteFailed();
      this.deps.logger.warn("sqs delete failed; a redelivery will be replayed", {
        sqsMessageId: message.MessageId,
        error: errorText(error),
      });
    }
  }

  private async release(messages: readonly Message[], reason: string): Promise<void> {
    await this.changeVisibility(messages, 0, reason);
    this.deps.metrics.released(messages.length);
  }

  private async changeVisibility(
    messages: readonly Message[],
    seconds: number,
    reason: string,
  ): Promise<void> {
    await Promise.all(
      messages.map(async (message) => {
        try {
          await this.deps.sqs.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.options.queueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: seconds,
            }),
          );
        } catch (error) {
          // The visibility simply expires on its own: a later redelivery, never a loss.
          this.deps.logger.warn("sqs change visibility failed", {
            sqsMessageId: message.MessageId,
            reason,
            error: errorText(error),
          });
        }
      }),
    );
  }

  /** Exponential by receive count: ~2 s, ~4 s, ~8 s… capped (with jitter, in whole seconds). */
  private retryDelaySeconds(message: Message): number {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    const attempt = Number.isInteger(receiveCount) && receiveCount > 0 ? receiveCount - 1 : 0;
    const ms = this.options.retryBackoff.delayFor(Math.min(attempt, 30), () =>
      this.deps.random.next(),
    );
    return Math.min(MAX_VISIBILITY_SECONDS, Math.max(1, Math.ceil(ms / 1000)));
  }

  private async finishAll(
    list: readonly Tracked[],
    action: (messages: Message[]) => Promise<void>,
  ): Promise<void> {
    try {
      await action(list.map((t) => t.message));
    } finally {
      for (const tracked of list) this.finish(tracked);
    }
  }

  private finish(tracked: Tracked): void {
    tracked.state = "done";
    this.tracked.delete(tracked);
    this.wakeSlotWaiters();
  }

  /** A method, not the field: the flag flips during awaits, which narrowing does not see. */
  private isStopping(): boolean {
    return this.stopping;
  }

  private inFlight(): number {
    return this.tracked.size;
  }

  private async waitForSlot(): Promise<void> {
    while (!this.stopping && this.inFlight() >= this.options.concurrency) {
      await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    }
  }

  private wakeSlotWaiters(): void {
    const waiters = this.slotWaiters;
    this.slotWaiters = [];
    for (const wake of waiters) wake();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
