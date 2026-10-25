import { Body, Controller, Get, Param, Post, Res } from "@nestjs/common";
import type { z } from "zod";
import { GetTransaction, GetTransactionByExternalId } from "../../application/queries/queries.ts";
import type { RequestContext } from "../../application/request-context.ts";
import { ProcessWagerTransaction } from "../../application/wager/process-wager-transaction.ts";
import type { TransactionView, WagerTransactionResult } from "../../application/views.ts";
import { httpStatusForResult } from "./http-status.ts";
import { Ctx, RequestHeader } from "./request-context.decorator.ts";
import type { HttpResponse } from "./request-context.decorator.ts";
import { idempotencyKeyHeader, wagerTransactionBody } from "./schemas.ts";
import { ZodPipe } from "./zod-pipe.ts";

@Controller()
export class WageringController {
  constructor(
    private readonly processWagerTransaction: ProcessWagerTransaction,
    private readonly getTransaction: GetTransaction,
    private readonly getTransactionByExternalId: GetTransactionByExternalId,
  ) {}

  /**
   * Same body for success, rejection and replay; the status comes from the transaction status
   * (200 PROCESSED, 202 PENDING_REFERENCE, 422 REJECTED/FAILED), so a replay answers exactly like
   * the original request.
   */
  @Post("wagering/transactions")
  async submit(
    @RequestHeader("idempotency-key", new ZodPipe(idempotencyKeyHeader, "header.Idempotency-Key"))
    idempotencyKey: string,
    @Body(new ZodPipe(wagerTransactionBody, "body")) body: z.output<typeof wagerTransactionBody>,
    @Ctx() context: RequestContext,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<WagerTransactionResult> {
    const result = await this.processWagerTransaction.execute({ ...body, idempotencyKey }, context);
    response.status(httpStatusForResult(result));
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  get(@Param("transactionId") transactionId: string): Promise<TransactionView> {
    return this.getTransaction.execute(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<TransactionView> {
    return this.getTransactionByExternalId.execute(providerId, externalTransactionId);
  }
}
