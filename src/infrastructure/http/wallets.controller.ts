import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import type { z } from "zod";
import { GetLedgerPage, GetWallet } from "../../application/queries/queries.ts";
import type { RequestContext } from "../../application/request-context.ts";
import type { LedgerEntryView, WalletView } from "../../application/views.ts";
import { CreateWallet } from "../../application/wallet/create-wallet.ts";
import { ReconcileWallet } from "../../application/wallet/reconcile-wallet.ts";
import type { ReconciliationReport } from "../../application/wallet/reconcile-wallet.ts";
import { decodeLedgerCursor, encodeLedgerCursor } from "./ledger-cursor.ts";
import { Ctx } from "./request-context.decorator.ts";
import { createWalletBody, DEFAULT_LEDGER_PAGE_LIMIT, ledgerQuery } from "./schemas.ts";
import { ZodPipe } from "./zod-pipe.ts";

export interface LedgerPageResponse {
  readonly entries: readonly LedgerEntryView[];
  /** Present while there are more entries: pass it back as ?cursor=. */
  readonly nextCursor?: string;
}

@Controller("wallets")
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly getWallet: GetWallet,
    private readonly getLedgerPage: GetLedgerPage,
    private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodPipe(createWalletBody, "body")) body: z.output<typeof createWalletBody>,
    @Ctx() context: RequestContext,
  ): Promise<WalletView> {
    return this.createWallet.execute(body, context);
  }

  @Get(":walletId")
  get(@Param("walletId") walletId: string): Promise<WalletView> {
    return this.getWallet.execute(walletId);
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query(new ZodPipe(ledgerQuery, "query")) query: z.output<typeof ledgerQuery>,
  ): Promise<LedgerPageResponse> {
    const page = await this.getLedgerPage.execute({
      walletId,
      afterVersion: query.cursor === undefined ? undefined : decodeLedgerCursor(query.cursor),
      limit: query.limit ?? DEFAULT_LEDGER_PAGE_LIMIT,
    });
    return {
      entries: page.entries,
      ...(page.nextAfterVersion === undefined
        ? {}
        : { nextCursor: encodeLedgerCursor(page.nextAfterVersion) }),
    };
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  reconcile(
    @Param("walletId") walletId: string,
    @Ctx() context: RequestContext,
  ): Promise<ReconciliationReport> {
    return this.reconcileWallet.execute(walletId, context);
  }
}
