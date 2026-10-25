import type { PipeTransform } from "@nestjs/common";
import type { z } from "zod";
import { InvalidRequestError } from "./http-errors.ts";

/** Validates one request part (body, header, query) and reports every failing field (400). */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(
    private readonly schema: S,
    /** Prefix of each detail path, e.g. "body" or "header.Idempotency-Key". */
    private readonly location: string,
  ) {}

  transform(value: unknown): z.output<S> {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;
    const details = parsed.error.issues.map((issue) => ({
      path: [this.location, ...issue.path.map(String)].join("."),
      message: issue.message,
    }));
    throw new InvalidRequestError(`invalid ${this.location}`, details);
  }
}
