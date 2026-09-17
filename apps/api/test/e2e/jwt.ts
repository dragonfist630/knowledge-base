import { createHmac } from "node:crypto";

/**
 * Hand-rolled HS256 JWT minting for the Gate 3 e2e harness — no local
 * Supabase/GoTrue is running (see docs/DECISIONS.md Phase 3, D3.1), so
 * there's nothing to mint real session tokens for us. Signs with the same
 * well-known local dev secret `supabase start` always uses
 * (super-secret-jwt-token-with-at-least-32-characters-long), which is
 * exactly the secret AuthGuard's local-HS256 fallback path verifies
 * against — so this exercises the real production code path, just with a
 * hand-minted token standing in for a real GoTrue session.
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
