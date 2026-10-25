import type { WagerTransactionCommand } from "../../src/application/wager/process-wager-transaction.ts";
import type { ReconciliationReport } from "../../src/application/wallet/reconcile-wallet.ts";
import type { WagerTransactionResult, WalletView } from "../../src/application/views.ts";

/** Statuses that are a final answer for a submitted transaction (section 9). */
const FINAL_STATUSES: ReadonlySet<number> = new Set([200, 202, 422]);

export interface SubmitOutcome {
  readonly result: WagerTransactionResult;
  /** HTTP status of the final answer. */
  readonly status: number;
  /** How many times the same request was sent until a final answer (1 = first try). */
  readonly attempts: number;
}

/**
 * Behaves like a well-behaved provider: sends to one API instance and, on 503 or when the instance
 * is unreachable (killed, restarting), resends THE SAME request (same Idempotency-Key) to the next
 * one, with a short pause, until a final answer or the deadline. Anything else (400, 404, 409) is a
 * test failure and is thrown at once.
 */
export class ProviderClient {
  private next = 0;

  constructor(
    private readonly apiUrls: () => readonly string[],
    private readonly deadlineMs = 90_000,
  ) {}

  /** Index of the instance the next call starts at (round robin). */
  pick(): number {
    const index = this.next;
    this.next = (this.next + 1) % this.apiUrls().length;
    return index;
  }

  async submit(command: WagerTransactionCommand, startAt = this.pick()): Promise<SubmitOutcome> {
    const { idempotencyKey, ...body } = command;
    const {
      status,
      body: answer,
      attempts,
    } = await this.send(
      "POST",
      "/wagering/transactions",
      body,
      { "Idempotency-Key": idempotencyKey },
      startAt,
      (code) => FINAL_STATUSES.has(code),
    );
    return { result: answer as WagerTransactionResult, status, attempts };
  }

  async createWallet(initialBalance: string, currency = "BRL"): Promise<WalletView> {
    const { body } = await this.send(
      "POST",
      "/wallets",
      { playerId: Bun.randomUUIDv7(), initialBalance: { amount: initialBalance, currency } },
      {},
      this.pick(),
      (code) => code === 201,
    );
    return body as WalletView;
  }

  async reconcile(walletId: string): Promise<ReconciliationReport> {
    const { body } = await this.send(
      "POST",
      `/wallets/${walletId}/reconciliation`,
      undefined,
      {},
      this.pick(),
      (code) => code === 200,
    );
    return body as ReconciliationReport;
  }

  async wallet(walletId: string): Promise<WalletView> {
    const { body } = await this.send(
      "GET",
      `/wallets/${walletId}`,
      undefined,
      {},
      this.pick(),
      (code) => code === 200,
    );
    return body as WalletView;
  }

  private async send(
    method: string,
    path: string,
    body: unknown,
    headers: Readonly<Record<string, string>>,
    startAt: number,
    isFinal: (status: number) => boolean,
  ): Promise<{ status: number; body: unknown; attempts: number }> {
    const deadline = Date.now() + this.deadlineMs;
    for (let attempt = 1; ; attempt += 1) {
      const urls = this.apiUrls();
      const url = urls[(startAt + attempt - 1) % urls.length];
      let retryReason: string;
      try {
        const response = await fetch(`${url ?? ""}${path}`, {
          method,
          headers: { "content-type": "application/json", ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(15_000),
        });
        const text = await response.text();
        const parsed: unknown = text === "" ? undefined : JSON.parse(text);
        if (isFinal(response.status))
          return { status: response.status, body: parsed, attempts: attempt };
        if (response.status !== 503) {
          throw new Error(`${method} ${path} → ${response.status}: ${text}`);
        }
        retryReason = "503";
      } catch (error) {
        if (error instanceof Error && error.message.startsWith(`${method} ${path} →`)) throw error;
        // Unreachable instance (killed, restarting) or a response cut by the kill.
        retryReason = error instanceof Error ? error.name : String(error);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `${method} ${path}: no final answer after ${attempt} attempts (${retryReason})`,
        );
      }
      await Bun.sleep(Math.min(500, 50 * attempt));
    }
  }
}

/** Runs the tasks with at most `limit` in flight; resolves with every result, in task order. */
export async function runLimited<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let cursor = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const task = tasks[index];
      if (task === undefined) return;
      results[index] = await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, lane));
  return results;
}
