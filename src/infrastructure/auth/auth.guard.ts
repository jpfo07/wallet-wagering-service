import { Inject, Injectable } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ProviderIdentityPort } from "../../application/ports/provider-identity.ts";
import type { HttpRequest } from "../http/request-context.decorator.ts";
import { IS_PUBLIC } from "./public.decorator.ts";

export const PROVIDER_IDENTITY = Symbol("PROVIDER_IDENTITY");

/**
 * Global guard (APP_GUARD): every route resolves the caller through the ProviderIdentityPort and
 * carries the principal into the RequestContext; only @Public() routes skip it. A refusal is the
 * adapter's UnauthenticatedError (401, through the exception filter). Whether the principal may act
 * on the providerId of the request is decided by the use case, where the providerId is validated.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;
    const request = context.switchToHttp().getRequest<HttpRequest>();
    const authorization = request.headers["authorization"];
    request.principal = await this.identity.resolve({
      authorization: typeof authorization === "string" ? authorization : undefined,
    });
    return true;
  }
}
