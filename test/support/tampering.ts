import type {
  TransactionScope,
  UnitOfWork,
  UnitOfWorkOptions,
} from "../../src/application/ports/unit-of-work.ts";

export class InjectedFault extends Error {
  override readonly name = "InjectedFault";
}

/**
 * Wraps the real unit of work (real PostgreSQL transaction) and lets a test tamper with the scope
 * of each attempt: inject a failure at an exact step, or make something happen in between steps.
 */
export class TamperingUnitOfWork implements UnitOfWork {
  constructor(
    private readonly inner: UnitOfWork,
    private readonly tamper: (scope: TransactionScope) => TransactionScope,
  ) {}

  run<T>(work: (scope: TransactionScope) => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
    return this.inner.run((scope) => work(this.tamper(scope)), options);
  }
}

/** The same object with some methods replaced; the others stay bound to the original. */
export function override<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(original, property) {
      if (Object.hasOwn(overrides, property)) {
        return (overrides as Record<string | symbol, unknown>)[property];
      }
      const value: unknown = Reflect.get(original, property);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(original)
        : value;
    },
  });
}
