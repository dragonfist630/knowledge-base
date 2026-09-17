import type { CanActivate, ExecutionContext} from "@nestjs/common";
import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
// Must stay a value import, not `import type`: it's a constructor-injected
// dependency, and Nest's DI resolves it from the `design:paramtypes`
// metadata tsc only emits for a real (non-type-only) import — see
// docs/DECISIONS.md Phase 3, D3.3.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { Reflector } from "@nestjs/core";
import { jwtVerify } from "jose";

import { API_ENV } from "../config/config.module.js";
import type { ApiEnv } from "../config/env.js";
import type { AuthedRequest } from "./auth-request.js";
import { IS_PUBLIC_KEY } from "./public.decorator.js";
import { createAnonClient, createUserScopedClient } from "./supabase-client.factory.js";

interface VerifiedClaims {
  userId: string;
  email: string | undefined;
}

/**
 * Bearer <jwt> -> req.auth = { userId, email, db }. `db` is a Supabase
 * client built from the publishable key plus this exact JWT, so every
 * downstream query runs under RLS as this user — no service-role client
 * exists anywhere in this app. Both verification paths below also reject
 * any token whose `role` claim isn't `"authenticated"` — a service_role
 * (or anon) token must never reach `createUserScopedClient` — see D3.6.
 *
 * Verification tries `getClaims()` first: against a real (local or hosted)
 * Supabase project this does local, network-light verification against the
 * project's JWKS and is the only path that ever runs in production. It only
 * fails here when the project signs with a shared HS256 secret instead of
 * asymmetric keys — the default for a bare `supabase start` with no
 * customized config — in which case there's no JWKS endpoint to verify
 * against and getClaims() throws. See docs/DECISIONS.md Phase 3 (D3.1) for
 * why this fallback exists and how it's exercised in the e2e tests without
 * Docker in this environment.
 *
 * The fallback here is a hand-rolled local HS256 `jose` verification, not
 * `supabase.auth.getUser()` — a deliberate, documented deviation from the
 * literal spec (which assumes a *running* local Supabase whose GoTrue just
 * lacks a JWKS endpoint, so `getUser()`'s network round trip to it still
 * succeeds). This environment has no Supabase Auth server running at all
 * (no Docker, ever — see D3.1), so `getUser()` would fail here exactly the
 * same way `getClaims()` does, for an unrelated reason (no server to call,
 * not "no JWKS"). See D3.6 for the full rationale and what changes for
 * anyone who *does* have Docker and runs a real `supabase start`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = this.extractBearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException("Missing or malformed Authorization header.");
    }

    const claims = await this.verify(token);
    request.auth = {
      userId: claims.userId,
      email: claims.email,
      db: createUserScopedClient(this.env, token),
      jwt: token,
    };
    return true;
  }

  private extractBearerToken(header: string | undefined): string | undefined {
    if (!header) return undefined;
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) return undefined;
    return token;
  }

  private async verify(token: string): Promise<VerifiedClaims> {
    try {
      const claims = await this.verifyViaGetClaims(token);
      if (claims) return claims;
    } catch {
      // fall through to the local HS256 fallback below
    }

    const fallback = await this.verifyViaLocalSecret(token);
    if (fallback) return fallback;

    throw new UnauthorizedException("Invalid or expired token.");
  }

  private async verifyViaGetClaims(token: string): Promise<VerifiedClaims | undefined> {
    const anon = createAnonClient(this.env);
    const { data, error } = await anon.auth.getClaims(token);
    if (error || !data?.claims || typeof data.claims.sub !== "string") {
      return undefined;
    }
    // Only ever authenticate as the "authenticated" role. Without this,
    // any JWT signed by the project's key — including a service_role
    // token, which bypasses RLS entirely — would authenticate here and
    // then be handed straight to createUserScopedClient, undermining the
    // "no service-role access in apps/api" guarantee documented in
    // supabase-client.factory.ts. See docs/DECISIONS.md Phase 3, D3.6.
    if (data.claims.role !== "authenticated") {
      return undefined;
    }
    const email = typeof data.claims.email === "string" ? data.claims.email : undefined;
    return { userId: data.claims.sub, email };
  }

  private async verifyViaLocalSecret(token: string): Promise<VerifiedClaims | undefined> {
    if (!this.env.SUPABASE_JWT_SECRET) {
      return undefined;
    }
    try {
      const secret = new TextEncoder().encode(this.env.SUPABASE_JWT_SECRET);
      const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
      if (typeof payload.sub !== "string") return undefined;
      // Same role restriction as verifyViaGetClaims — see the comment
      // there and D3.6.
      if (payload.role !== "authenticated") return undefined;
      const email = typeof payload.email === "string" ? payload.email : undefined;
      return { userId: payload.sub, email };
    } catch {
      return undefined;
    }
  }
}
