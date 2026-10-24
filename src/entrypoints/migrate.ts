import { MikroORM } from "@mikro-orm/postgresql";
import { loadConfig } from "../infrastructure/config/env.ts";
import { buildOrmOptions } from "../infrastructure/persistence/mikro-orm.config.ts";

type Command = "up" | "down" | "create" | "pending";

function parseCommand(raw: string | undefined): Command {
  if (raw === "up" || raw === "down" || raw === "create" || raw === "pending") return raw;
  throw new Error(`Uso: migrate.ts <up|down|create|pending> (recebido: ${raw ?? "nada"})`);
}

const log = (message: string): void => {
  console.log(JSON.stringify({ level: "info", process: "migrate", message }));
};

const command = parseCommand(process.argv[2]);
const orm = await MikroORM.init(buildOrmOptions(loadConfig().database));
try {
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
} finally {
  await orm.close(true);
}
