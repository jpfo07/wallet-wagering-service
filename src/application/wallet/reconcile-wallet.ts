import type { MoneyProps } from "../../domain/shared/money.ts";
import { WalletNotFoundError } from "../errors.ts";
import type { ApplicationMetrics, Logger } from "../ports/telemetry.ts";
import type { TransactionRunner } from "../transaction-runner.ts";
import { requireUuid } from "../validation.ts";
import type { RequestContext } from "../request-context.ts";

export interface ReconciliationReport {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  /** stored − calculated. */
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

/**
 * Stored balance × balance rebuilt from the ledger. Both come from one SQL statement, so a commit
 * landing between two reads can never fake a divergence. A divergence is logged, counted and
 * reported, and never corrected: fixing it silently would destroy the evidence.
 */
export class ReconcileWallet {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly metrics: ApplicationMetrics,
    private readonly logger: Logger,
  ) {}

  async execute(walletId: string, context: RequestContext): Promise<ReconciliationReport> {
    const id = requireUuid("walletId", walletId);
    const snapshot = await this.runner.run((scope) => scope.ledger.reconciliationSnapshot(id), {
      readOnly: true,
    });
    if (snapshot === undefined) throw new WalletNotFoundError(id);

    const difference = snapshot.storedBalance.subtract(snapshot.calculatedBalance);
    const consistent = difference.isZero();
    if (!consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.error("wallet balance diverges from its ledger", {
        walletId: id,
        storedBalance: snapshot.storedBalance.amount,
        calculatedBalance: snapshot.calculatedBalance.amount,
        difference: difference.amount,
        currency: difference.currency,
        checkedEntries: snapshot.checkedEntries,
        correlationId: context.correlationId,
      });
    }
    return {
      walletId: id,
      storedBalance: snapshot.storedBalance.toJSON(),
      calculatedBalance: snapshot.calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snapshot.checkedEntries,
    };
  }
}
