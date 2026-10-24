// MikroORM 7 falls back to node:fs globSync({ withFileTypes: true }) when tinyglobby is not installed.
import { globSync } from "node:fs";

try {
  globSync("*", { cwd: "/etc", withFileTypes: true });
  console.log("[probe] glob_withFileTypes=ok");
} catch {
  console.log("[probe] glob_withFileTypes=unsupported");
}
