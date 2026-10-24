import { InvariantViolationError } from "../shared/domain-error.ts";
import { WagerTransactionKind } from "./wager-transaction-kind.ts";
import { WagerTransactionStatus } from "./wager-transaction-status.ts";
import type { WagerTransaction } from "./wager-transaction.ts";

export class InvalidReferenceStateError extends InvariantViolationError {
  constructor(message: string) {
    super("INVALID_REFERENCE_STATE", message);
  }
}

export interface EvaluateReferenceProps {
  /** The referenced transaction. */
  readonly reference: WagerTransaction;
  /** PROCESSED transactions whose referenceTransactionId is reference.id. */
  readonly dependents: readonly WagerTransaction[];
  /** PROCESSED ROLLBACKs whose referenceTransactionId is one of the dependents. */
  readonly dependentRollbacks: readonly WagerTransaction[];
}

/**
 * What has already happened to a referenced transaction. A transaction is "undone" when a PROCESSED
 * ROLLBACK references it. Two levels are enough: a ROLLBACK can never reference another ROLLBACK, so
 * the only possible chains are BET ← REFUND ← ROLLBACK and BET ← WIN ← ROLLBACK.
 *
 * - everReversed: some REFUND/ROLLBACK of the reference was PROCESSED, even if later undone. Used for
 *   new reversals ("at most one reversal per reference", same as the unique index in the schema).
 * - effectivelyReversed: some REFUND/ROLLBACK of the reference is PROCESSED and not undone. Used for
 *   WIN/LOSS: a refund that was rolled back puts the bet back in play.
 * - hasActiveWin: some WIN of the reference is PROCESSED and not undone. Used for reversals of a BET.
 *   LOSS is ignored on purpose: it never moved the balance.
 */
export class ReferenceState {
  private constructor(
    readonly transaction: WagerTransaction | undefined,
    readonly everReversed: boolean,
    readonly effectivelyReversed: boolean,
    readonly hasActiveWin: boolean,
  ) {
    Object.freeze(this);
  }

  static notFound(): ReferenceState {
    return new ReferenceState(undefined, false, false, false);
  }

  static evaluate(props: EvaluateReferenceProps): ReferenceState {
    const { reference, dependents, dependentRollbacks } = props;
    const dependentIds = new Set<string>();
    for (const dependent of dependents) {
      if (
        dependent.status !== WagerTransactionStatus.Processed ||
        dependent.referenceTransactionId !== reference.id
      ) {
        throw new InvalidReferenceStateError(
          `transaction ${dependent.id} is not a PROCESSED dependent of ${reference.id}`,
        );
      }
      dependentIds.add(dependent.id);
    }
    const undone = new Set<string>();
    for (const rollback of dependentRollbacks) {
      const target = rollback.referenceTransactionId;
      if (
        rollback.kind !== WagerTransactionKind.Rollback ||
        rollback.status !== WagerTransactionStatus.Processed ||
        target === undefined ||
        !dependentIds.has(target)
      ) {
        throw new InvalidReferenceStateError(
          `transaction ${rollback.id} is not a PROCESSED ROLLBACK of a dependent of ${reference.id}`,
        );
      }
      undone.add(target);
    }

    const reversals = dependents.filter((dependent) => dependent.isReversal());
    return new ReferenceState(
      reference,
      reversals.length > 0,
      reversals.some((reversal) => !undone.has(reversal.id)),
      dependents.some(
        (dependent) => dependent.kind === WagerTransactionKind.Win && !undone.has(dependent.id),
      ),
    );
  }
}
