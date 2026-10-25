import type { DestinationStream } from "pino";

export type LogLine = Readonly<Record<string, unknown>>;

/** A pino destination that keeps every line, raw and parsed, for assertions. */
export class LogCapture implements DestinationStream {
  readonly raw: string[] = [];

  write(line: string): void {
    this.raw.push(line);
  }

  lines(): LogLine[] {
    return this.raw.map((line) => JSON.parse(line) as LogLine);
  }

  find(message: string, predicate: (line: LogLine) => boolean = () => true): LogLine | undefined {
    return this.lines().find((line) => line["msg"] === message && predicate(line));
  }

  text(): string {
    return this.raw.join("");
  }
}
