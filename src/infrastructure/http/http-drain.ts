/**
 * Draining state of an API replica during graceful shutdown. While draining, the replica still
 * answers every request, but with `Connection: close` (so the proxy stops reusing its keepalive
 * sockets) and with readiness 503. Only after the drain window does it close its port. Without it,
 * the proxy can send a request over a pooled socket the replica is closing at that very moment; a
 * GET is then retried elsewhere, but a POST already sent becomes a 502 for the client.
 */
export class HttpDrain {
  private draining = false;

  get active(): boolean {
    return this.draining;
  }

  begin(): void {
    this.draining = true;
  }
}
