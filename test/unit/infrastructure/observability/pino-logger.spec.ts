import { describe, expect, test } from "bun:test";
import { logContext } from "../../../../src/infrastructure/observability/log-context.ts";
import { PinoLogger, REDACTED } from "../../../../src/infrastructure/observability/pino-logger.ts";
import { LogCapture } from "../../../support/log-capture.ts";

function logger() {
  const capture = new LogCapture();
  const log = PinoLogger.create({
    base: { process: "test-process", instanceId: "test-1" },
    destination: capture,
  });
  return { capture, log };
}

describe("PinoLogger", () => {
  test("one JSON line with level label, ISO time, process, instanceId and msg", () => {
    const { capture, log } = logger();
    log.warn("something happened", { attempt: 2 });
    const [line] = capture.lines();
    expect(line).toMatchObject({
      level: "warn",
      process: "test-process",
      instanceId: "test-1",
      msg: "something happened",
      attempt: 2,
    });
    expect(new Date(String(line?.["time"])).toISOString()).toBe(String(line?.["time"]));
  });

  test("the log context adds the five identifiers to every line; explicit fields win", async () => {
    const { capture, log } = logger();
    await logContext.run(
      { correlationId: "corr-1", messageId: "msg-1", providerId: "provider-a" },
      async () => {
        await Promise.resolve();
        logContext.run({ transactionId: "tx-1", walletId: "wallet-1" }, () => {
          log.info("nested", { walletId: "wallet-explicit" });
        });
        log.info("outer");
      },
    );
    log.info("outside");
    const [nested, outer, outside] = capture.lines();
    expect(nested).toMatchObject({
      correlationId: "corr-1",
      messageId: "msg-1",
      transactionId: "tx-1",
      walletId: "wallet-explicit",
      providerId: "provider-a",
    });
    expect(outer).toMatchObject({ correlationId: "corr-1", messageId: "msg-1" });
    expect(outer).not.toHaveProperty("transactionId");
    expect(outside).not.toHaveProperty("correlationId");
  });

  test("money, payloads and credentials are redacted wherever a caller puts them", () => {
    const { capture, log } = logger();
    log.info("careless caller", {
      amount: "25.00",
      balance: "75.00",
      authorization: "Bearer secret",
      cookie: "session=abc",
      transactionId: "tx-1",
    });
    const [line] = capture.lines();
    expect(line).toMatchObject({
      amount: REDACTED,
      balance: REDACTED,
      authorization: REDACTED,
      cookie: REDACTED,
      transactionId: "tx-1",
    });
    expect(capture.text()).not.toContain("25.00");
    expect(capture.text()).not.toContain("secret");
  });
});
