/**
 * Load test of the dev stack (docker-compose.yml: nginx + 3 APIs + workers), through the proxy.
 *
 *   docker compose up -d --build --wait && bun run test:load && docker compose down
 *
 * Two profiles, each with a short warm-up (not measured) and a measured window:
 *   - spread: traffic spread over many wallets (little lock contention);
 *   - hot:    70% of the traffic on 5 wallets (the wallet lock serializes them).
 * Mix per request: BET 60%, WIN 20%, LOSS 10%, REFUND of an earlier processed BET 8%, and 2% resends
 * of an earlier request with the same Idempotency-Key (must be a replay).
 *
 * Measured on the client: throughput, latency p50/p95/p99 (whole request through nginx), status
 * counts (business 422 apart from errors). From every API replica's /metrics (delta over the
 * window): lock conflicts and transient retries. From PostgreSQL every second: outbox lag (oldest
 * pending age, pending count), and how long the outbox takes to drain after the window. At the end:
 * balance == ledger on every wallet (SQL) and a reconciliation through the API on a sample.
 *
 * Money stays as strings end to end, as in the contract; no amount is ever a number here.
 */
import { SQL } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";

const BASE_URL = process.env["BASE_URL"] ?? "http://localhost:8080";
const DATABASE_URL =
  process.env["LOAD_DATABASE_URL"] ?? "postgres://wallet:wallet@127.0.0.1:5432/wallet";
const CONCURRENCY = Number(process.env["LOAD_CONCURRENCY"] ?? "32");
const WARMUP_S = Number(process.env["LOAD_WARMUP_S"] ?? "5");
const DURATION_S = Number(process.env["LOAD_DURATION_S"] ?? "30");
const PROVIDER = "load-provider";

type Kind = "BET" | "WIN" | "LOSS" | "REFUND";

interface Wallet {
  readonly id: string;
  readonly playerId: string;
  /** Processed BETs not refunded yet (externalTransactionId → amount string). */
  readonly refundable: Map<string, string>;
}

interface SentRequest {
  readonly key: string;
  readonly body: Record<string, unknown>;
}

interface Sample {
  readonly ms: number;
  readonly status: number | "network";
  readonly replay: boolean;
}

// ---------------------------------------------------------------- helpers

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? Number.NaN;
}

const round = (value: number, digits = 1): number => Number(value.toFixed(digits));

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
}

async function createWallets(count: number): Promise<Wallet[]> {
  const wallets: Wallet[] = [];
  const lanes = Array.from({ length: 16 }, async () => {
    while (wallets.length < count) {
      const playerId = crypto.randomUUID();
      const { status, body } = await post("/wallets", {
        playerId,
        initialBalance: { amount: "1000000.00", currency: "BRL" },
      });
      if (status !== 201) throw new Error(`wallet creation → ${status}`);
      wallets.push({ id: (body as { id: string }).id, playerId, refundable: new Map() });
    }
  });
  await Promise.all(lanes);
  return wallets.slice(0, count);
}

/** Sum of the given series over every API replica (docker exec, the replicas are not published). */
function scrapeApis(): Record<string, number> {
  const ids = Bun.spawnSync(["docker", "compose", "ps", "-q", "api"]).stdout.toString().trim();
  const totals: Record<string, number> = {};
  for (const id of ids.split("\n").filter(Boolean)) {
    const out = Bun.spawnSync([
      "docker",
      "exec",
      id,
      "bun",
      "-e",
      'console.log(await (await fetch("http://127.0.0.1:3000/metrics")).text())',
    ]).stdout.toString();
    for (const line of out.split("\n")) {
      const match =
        /^(wws_lock_conflicts_total|wws_retries_total|wws_wallet_lock_wait_seconds_sum|wws_wallet_lock_wait_seconds_count|wws_wager_transactions_total)\{([^}]*)\} (\S+)$/.exec(
          line,
        );
      if (match === null) continue;
      const [, name, labels, value] = match;
      const reason = /reason="([^"]+)"/.exec(labels ?? "")?.[1] ?? "";
      const key = `${name ?? ""}{${reason}}`;
      totals[key] = (totals[key] ?? 0) + Number(value);
    }
  }
  return totals;
}

function delta(after: Record<string, number>, before: Record<string, number>) {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(after)) {
    const diff = value - (before[key] ?? 0);
    if (diff !== 0) out[key] = diff;
  }
  return out;
}

/**
 * Lock conflicts and retries, plus the wallet lock wait and how many decisions the replicas counted
 * (the latter proves the scrape worked: a missing counter would otherwise read as zero conflicts).
 */
function conflictsOf(window: Record<string, number>) {
  const sum = (prefix: string): number =>
    Object.entries(window)
      .filter(([key]) => key.startsWith(prefix))
      .reduce((total, [, value]) => total + value, 0);
  const waits = sum("wws_wallet_lock_wait_seconds_count");
  return {
    lockConflicts: Object.fromEntries(
      Object.entries(window).filter(([key]) => key.startsWith("wws_lock_conflicts_total")),
    ),
    transientRetries: sum("wws_retries_total"),
    walletLockWaitAvgMs:
      waits === 0 ? 0 : round((sum("wws_wallet_lock_wait_seconds_sum") / waits) * 1000),
    decisionsCountedByReplicas: sum("wws_wager_transactions_total"),
  };
}

// ---------------------------------------------------------------- traffic

function pickKind(): Kind {
  const r = Math.random();
  if (r < 0.6) return "BET";
  if (r < 0.8) return "WIN";
  if (r < 0.9) return "LOSS";
  return "REFUND";
}

const AMOUNTS = ["1.00", "2.50", "5.00", "10.00", "20.00"] as const;

function buildRequest(wallet: Wallet, kind: Kind): SentRequest | undefined {
  const externalTransactionId = `${kind.toLowerCase()}-${crypto.randomUUID()}`;
  let amount: string = AMOUNTS[Math.floor(Math.random() * AMOUNTS.length)] ?? "1.00";
  let reference: string | undefined;
  if (kind === "REFUND") {
    const first = wallet.refundable.entries().next();
    if (first.done === true) return undefined;
    [reference, amount] = first.value;
    wallet.refundable.delete(reference);
  }
  return {
    key: `${PROVIDER}:${externalTransactionId}`,
    body: {
      providerId: PROVIDER,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "load-round",
      gameId: "load-game",
      kind,
      money: { amount, currency: "BRL" },
      ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
    },
  };
}

async function runProfile(
  name: string,
  wallets: readonly Wallet[],
  pickWallet: () => Wallet,
  sql: SQL,
) {
  const sent: SentRequest[] = [];
  const samples: Sample[] = [];
  const lag: { age: number; pending: number }[] = [];
  // Flags flipped by the main flow and read by the lanes (an object, so they are not narrowed).
  const control = { measuring: false, stop: false };

  const one = async (): Promise<void> => {
    const resend = sent.length > 0 && Math.random() < 0.02;
    const wallet = pickWallet();
    const kind = pickKind();
    const request = resend
      ? sent[Math.floor(Math.random() * sent.length)]
      : buildRequest(wallet, kind);
    if (request === undefined) return;
    const started = performance.now();
    let status: number | "network";
    let replay = false;
    try {
      const response = await post("/wagering/transactions", request.body, {
        "Idempotency-Key": request.key,
      });
      status = response.status;
      const result = response.body as { status?: string; idempotentReplay?: boolean } | undefined;
      replay = result?.idempotentReplay === true;
      if (!resend) {
        sent.push(request);
        const body = request.body as {
          kind: Kind;
          externalTransactionId: string;
          money: { amount: string };
        };
        if (body.kind === "BET" && result?.status === "PROCESSED") {
          wallet.refundable.set(body.externalTransactionId, body.money.amount);
        }
      }
    } catch {
      status = "network";
    }
    if (control.measuring) samples.push({ ms: performance.now() - started, status, replay });
  };

  const lanes = Array.from({ length: CONCURRENCY }, async () => {
    while (!control.stop) await one();
  });
  const sampler = (async () => {
    while (!control.stop) {
      const rows: { pending: number; age: number }[] = await sql`
        select count(*)::int as pending,
               coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 as age
          from outbox_messages where published_at is null`;
      const row = rows[0];
      if (control.measuring && row !== undefined) lag.push({ age: row.age, pending: row.pending });
      await Bun.sleep(1000);
    }
  })();

  await Bun.sleep(WARMUP_S * 1000);
  const metricsBefore = scrapeApis();
  control.measuring = true;
  const windowStart = performance.now();
  await Bun.sleep(DURATION_S * 1000);
  control.measuring = false;
  const windowSeconds = (performance.now() - windowStart) / 1000;
  control.stop = true;
  await Promise.all([...lanes, sampler]);
  const metricsAfter = scrapeApis();

  // How long until the publishers caught up with everything committed.
  const drainStart = performance.now();
  for (;;) {
    const rows: { n: number }[] = await sql`
      select count(*)::int as n from outbox_messages where published_at is null`;
    const row = rows[0];
    if ((row?.n ?? 0) === 0) break;
    await Bun.sleep(100);
  }
  const drainMs = performance.now() - drainStart;

  const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
  const byStatus: Record<string, number> = {};
  for (const s of samples) byStatus[String(s.status)] = (byStatus[String(s.status)] ?? 0) + 1;
  const errors = samples.filter(
    (s) => s.status === "network" || (typeof s.status === "number" && s.status >= 500),
  );
  const ages = lag.map((l) => l.age).sort((a, b) => a - b);
  return {
    profile: name,
    wallets: wallets.length,
    windowSeconds: round(windowSeconds),
    requests: samples.length,
    throughputRps: round(samples.length / windowSeconds),
    latencyMs: {
      p50: round(percentile(latencies, 50)),
      p95: round(percentile(latencies, 95)),
      p99: round(percentile(latencies, 99)),
      max: round(latencies.at(-1) ?? Number.NaN),
    },
    statuses: byStatus,
    replays: samples.filter((s) => s.replay).length,
    errorRatePct: round((errors.length / Math.max(1, samples.length)) * 100, 2),
    concurrencyConflicts: conflictsOf(delta(metricsAfter, metricsBefore)),
    outboxLag: {
      oldestPendingAgeS: { p50: round(percentile(ages, 50), 2), max: round(ages.at(-1) ?? 0, 2) },
      maxPending: Math.max(0, ...lag.map((l) => l.pending)),
      drainAfterWindowMs: Math.round(drainMs),
    },
  };
}

// ---------------------------------------------------------------- main

const sql = new SQL(DATABASE_URL, { max: 2 });
console.log(
  `load test against ${BASE_URL}: concurrency ${CONCURRENCY}, warm-up ${WARMUP_S}s, window ${DURATION_S}s per profile`,
);

const spread = await createWallets(500);
const hotSet = await createWallets(5);
const background = await createWallets(100);
console.log(`created ${spread.length + hotSet.length + background.length} wallets`);

const randomOf = (list: readonly Wallet[]) => (): Wallet =>
  list[Math.floor(Math.random() * list.length)] ?? (list[0] as Wallet);
const results = [
  await runProfile("spread", spread, randomOf(spread), sql),
  await runProfile(
    "hot",
    [...hotSet, ...background],
    () => (Math.random() < 0.7 ? randomOf(hotSet)() : randomOf(background)()),
    sql,
  ),
];

// Consistency after the load: balance == ledger on EVERY wallet, and the API's reconciliation agrees.
const diverging: { id: string }[] = await sql`
  select w.id from wallets w
  left join (select wallet_id,
                    sum(case direction when 'CREDIT' then amount else -amount end) as total
               from wallet_ledger_entries group by wallet_id) l on l.wallet_id = w.id
  where w.balance <> coalesce(l.total, 0)`;
const sample = [...hotSet, ...spread.slice(0, 20)];
let reconciliationsConsistent = 0;
for (const wallet of sample) {
  const { status, body } = await post(`/wallets/${wallet.id}/reconciliation`, {});
  if (status === 200 && (body as { consistent: boolean }).consistent)
    reconciliationsConsistent += 1;
}
await sql.close();

const report = {
  at: new Date().toISOString(),
  environment: {
    cpu: `${cpus()[0]?.model ?? "?"} × ${cpus().length}`,
    memoryGiB: round(totalmem() / 2 ** 30),
    bun: Bun.version,
    docker: Bun.spawnSync(["docker", "--version"]).stdout.toString().trim(),
    topology:
      "nginx + 3 API + 2 sqs-consumer + 2 outbox-publisher + 2 pending-reference-worker (docker compose, WSL2)",
  },
  settings: { concurrency: CONCURRENCY, warmupS: WARMUP_S, windowS: DURATION_S },
  results,
  consistency: {
    walletsWhereBalanceDiffersFromLedger: diverging.length,
    reconciliations: `${reconciliationsConsistent}/${sample.length} consistent`,
  },
};

mkdirSync("scripts/load-results", { recursive: true });
const file = `scripts/load-results/${report.at.replaceAll(":", "-")}.json`;
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`saved ${file}`);
if (diverging.length > 0 || reconciliationsConsistent !== sample.length) {
  console.error("CONSISTENCY FAILURE");
  process.exit(1);
}
