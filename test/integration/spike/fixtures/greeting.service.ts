import { Injectable } from "@nestjs/common";

@Injectable()
export class ClockService {
  now(): string {
    return "2026-01-01T00:00:00.000Z";
  }
}

@Injectable()
export class GreetingService {
  // Injected by type only: requires design:paramtypes emitted by Bun's transpiler.
  constructor(private readonly clock: ClockService) {}

  greet(name: string): string {
    return `hello ${name} at ${this.clock.now()}`;
  }
}
