// Container healthcheck (the slim image has no curl): bun src/entrypoints/healthcheck.ts <port> [path]
const port = process.argv[2] ?? "3000";
const path = process.argv[3] ?? "/health/live";

try {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(2000),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
