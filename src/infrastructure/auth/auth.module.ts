import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthGuard, PROVIDER_IDENTITY } from "./auth.guard.ts";
import { NoopProviderIdentityAdapter } from "./noop-provider-identity.adapter.ts";

/** AuthGuard on every HTTP route (opt-out with @Public()) over the configured identity adapter. */
@Module({
  providers: [
    { provide: PROVIDER_IDENTITY, useClass: NoopProviderIdentityAdapter },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AuthModule {}
