import { InboxMessageRecord } from "./inbox-message.model.ts";
import { OutboxMessageRecord } from "./outbox-message.model.ts";
import { WagerTransactionRecord } from "./wager-transaction.model.ts";
import { WalletLedgerEntryRecord } from "./wallet-ledger-entry.model.ts";
import { WalletRecord } from "./wallet.model.ts";

export const PERSISTENCE_MODELS = [
  WalletRecord,
  WagerTransactionRecord,
  WalletLedgerEntryRecord,
  InboxMessageRecord,
  OutboxMessageRecord,
] as const;
