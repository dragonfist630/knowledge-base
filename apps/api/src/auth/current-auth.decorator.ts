import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

import type { AuthContext, AuthedRequest } from "./auth-request.js";

/** `@CurrentAuth() auth: AuthContext` in a controller method — set by AuthGuard. */
export const CurrentAuth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const request = ctx.switchToHttp().getRequest<AuthedRequest>();
  return request.auth;
});
