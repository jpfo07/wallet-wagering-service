export interface WaitForOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly description?: string;
}

/**
 * Polls `probe` until it returns a value other than undefined/false, or fails after the timeout.
 * Replaces arbitrary sleeps: the test proceeds as soon as the condition holds.
 */
export async function waitFor<T>(
  probe: () => Promise<T | undefined | false> | T | undefined | false,
  { timeoutMs = 10_000, intervalMs = 50, description = "condition" }: WaitForOptions = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const reason = lastError instanceof Error ? ` (last error: ${lastError.message})` : "";
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}${reason}`);
    }
    await Bun.sleep(intervalMs);
  }
}
