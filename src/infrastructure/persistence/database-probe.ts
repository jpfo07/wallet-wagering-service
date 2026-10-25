import { Injectable } from "@nestjs/common";
import type { BeforeApplicationShutdown } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/core";

/** A probe refused because the process is shutting down (readiness then answers 503). */
export class DatabaseProbeClosedError extends Error {
  constructor() {
    super("database probe refused: shutting down");
    this.name = new.target.name;
  }
}

/**
 * The single place that pings PostgreSQL (`select 1`) for readiness and for the consumer's
 * DatabaseGate, so shutdown can wait for those pings before the ORM closes.
 *
 * Why: closing the pool while a connection is still being acquired hangs forever (kysely 0.29.6:
 * `destroy()` clears its pool before `end()`, the pending acquire then throws without releasing the
 * client, and `end()` waits for that client). A probe abandoned by a timeout or by a stopping loop is
 * exactly that case, and right after boot (first connection still opening) the window is widest.
 * Nest runs every `beforeApplicationShutdown` before any `onApplicationShutdown` (where MikroORM
 * closes), so waiting here is enough; probes asked for afterwards are refused at once.
 */
@Injectable()
export class DatabaseProbe implements BeforeApplicationShutdown {
  private readonly inFlight = new Set<Promise<unknown>>();
  private closed = false;

  constructor(private readonly orm: MikroORM) {}

  ping(): Promise<unknown> {
    if (this.closed) return Promise.reject(new DatabaseProbeClosedError());
    const probe = this.orm.em.getConnection().execute("select 1");
    this.inFlight.add(probe);
    void probe.then(
      () => this.inFlight.delete(probe),
      () => this.inFlight.delete(probe),
    );
    return probe;
  }

  /** Probes still running (diagnostics and tests). */
  get pending(): number {
    return this.inFlight.size;
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.inFlight]);
  }
}
