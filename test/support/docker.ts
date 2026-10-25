const COMPOSE_FILE = new URL("../../docker-compose.test.yml", import.meta.url).pathname;

function run(args: readonly string[]): string {
  const result = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`docker ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

/** Container of the test PostgreSQL (docker-compose.test.yml), or TEST_POSTGRES_CONTAINER. */
export function testPostgresContainer(): string {
  const configured = process.env["TEST_POSTGRES_CONTAINER"];
  if (configured !== undefined && configured !== "") return configured;
  const id = run(["compose", "-f", COMPOSE_FILE, "ps", "-q", "postgres"]);
  if (id === "") throw new Error("test PostgreSQL container is not running");
  return id;
}

/**
 * Freezes the test PostgreSQL (`docker pause`): connections neither fail nor answer, the nastiest
 * outage for a client. Returns the function that unfreezes it; call it in a `finally`.
 */
export function pauseTestPostgres(): () => void {
  const container = testPostgresContainer();
  run(["pause", container]);
  let paused = true;
  return () => {
    if (!paused) return;
    run(["unpause", container]);
    paused = false;
  };
}
