import { createHmac } from "node:crypto";

/**
 * Hand-rolled HS256 JWT minting for Gate 6's Playwright harness — a
 * near-duplicate of apps/api/test/e2e/jwt.ts (same reason that file isn't
 * shared with scripts/e2e-fetch-postgrest.mjs: apps/web's tsconfig.json
 * only `include`s files inside apps/web itself, so an import reaching
 * outside it fails `tsc --noEmit`/Gate 6's own typecheck step). Only used
 * by auth-gateway.ts, which — unlike apps/api's Gate 3 harness — actually
 * needs to hand out real sessions to a real browser (see that file's doc
 * comment for why: apps/web's browser Supabase client calls `getUser()`,
 * which always makes a live `/auth/v1/user` round trip, unlike
 * `getSession()`).
 */
function b64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

export interface MintJwtInput {
  sub: string;
  email?: string;
  role?: string;
  secret: string;
  expiresInSeconds?: number;
}

export function mintJwt({ sub, email, role = "authenticated", secret, expiresInSeconds = 3600 }: MintJwtInput): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub, email, role, aud: "authenticated", iat: now, exp: now + expiresInSeconds };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

export function verifyJwt(token: string, secret: string): { sub: string; email?: string; role: string; exp: number } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signature] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  const expected = createHmac("sha256", secret).update(signingInput).digest("base64url");
  if (expected !== signature) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8"));
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
