import { MikroORM } from "@mikro-orm/postgresql";
import { loadConfig } from "../infrastructure/config/env.ts";
import { ExponentialBackoff } from "../domain/shared/backoff-policy.ts";
import { withConnectionRetry } from "../infrastructure/persistence/connection-retry.ts";
import { buildOrmOptions } from "../infrastructure/persistence/mikro-orm.config.ts";
import { MathRandomSource, TimerSleeper } from "../infrastructure/system/system-adapters.ts";

type Command = "up" | "down" | "create" | "pending";

function parseCommand(raw: string | undefined): Command {
  if (raw === "up" || raw === "down" || raw === "create" || raw === "pending") return raw;
  throw new Error(`Uso: migrate.ts <up|down|create|pending> (recebido: ${raw ?? "nada"})`);
}

const log = (message: string, level: "info" | "warn" = "info"): void => {
  console.log(JSON.stringify({ level, process: "migrate", message }));
};

const command = parseCommand(process.argv[2]);
const database = loadConfig().database;

// O banco pode ainda não aceitar conexões (57P03 durante o restart da primeira inicialização do
// volume, ou o servidor reiniciando): repete a execução inteira, do zero. É seguro: cada migration
// roda na própria transação, e uma que falhou foi desfeita.
await withConnectionRetry(run, {
  attempts: 10,
  backoff: ExponentialBackoff.of({ baseMs: 500, maxMs: 5_000 }),
  sleeper: new TimerSleeper(),
  random: new MathRandomSource(),
  onRetry: ({ attempt, reason, delayMs }) => {
    log(`database not reachable (${reason}), attempt ${attempt}; retrying in ${delayMs}ms`, "warn");
  },
});

async function run(): Promise<void> {
  const orm = await MikroORM.init(buildOrmOptions(database));
  try {
    await execute(orm);
  } finally {
    await orm.close(true);
  }
}

async function execute(orm: MikroORM): Promise<void> {
  const migrator = orm.migrator;
  switch (command) {
    case "up": {
      const applied = await migrator.up();
      log(
        `applied ${applied.length} migration(s): ${applied.map((m) => m.name).join(", ") || "-"}`,
      );
      break;
    }
    case "down": {
      const reverted = await migrator.down();
      log(
        `reverted ${reverted.length} migration(s): ${reverted.map((m) => m.name).join(", ") || "-"}`,
      );
      break;
    }
    case "create": {
      const result = await migrator.create(undefined, true, false, process.argv[3]);
      log(`created ${result.fileName}`);
      break;
    }
    case "pending": {
      const pending = await migrator.getPending();
      log(`pending: ${pending.map((m) => m.name).join(", ") || "-"}`);
      break;
    }
  }
}
