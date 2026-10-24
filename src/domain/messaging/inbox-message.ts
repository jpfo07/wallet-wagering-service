import { InvariantViolationError } from "../shared/domain-error.ts";

export class InvalidInboxStateError extends InvariantViolationError {
  constructor(message: string) {
    super("INVALID_INBOX_STATE", message);
  }
}

export interface ReceiveInboxProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  readonly processedAt?: Date | undefined;
}

/** Persistent dedup of SQS deliveries, keyed by (consumerName, messageId). */
export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (props.messageId.trim() === "" || props.consumerName.trim() === "") {
      throw new InvalidInboxStateError("messageId and consumerName are required");
    }
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
      undefined,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  /** Same messageId with a different payload is a poison message, not a duplicate. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    if (this._processedAt !== undefined) {
      throw new InvalidInboxStateError(`inbox message ${this.messageId} is already processed`);
    }
    this._processedAt = at;
  }
}
