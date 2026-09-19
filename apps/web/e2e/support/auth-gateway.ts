import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { mintJwt, verifyJwt } from "./jwt.js";

/**
 * A small GoTrue-compatible auth shim, combined with the same
 * `/rest/v1`-stripping reverse proxy apps/api's Gate 3 harness uses
 * (test/e2e/rest-proxy.ts) — see this repo's docs/DECISIONS.md D3.1 for
 * why there's no real local Supabase/GoTrue to run against instead.
 *
 * Gate 3/5's e2e harness (apps/api only) never needed this: AuthGuard has
 * a local-HS256 JWT-verification fallback, so a hand-minted JWT alone is
 * enough there. Gate 6 drives a *real browser* through apps/web, and
 * `@supabase/ssr`'s browser client calls `supabase.auth.getUser()` (in
 * apps/web/src/app/(app)/layout.tsx and proxy.ts), which — per Supabase's
 * own documented behavior — always makes a live network round trip to
 * `${SUPABASE_URL}/auth/v1/user` to revalidate the token server-side,
 * unlike `getSession()`'s local/cookie-only read. Without something
 * answering that endpoint, the whole app hangs waiting on it forever. This
 * is the minimum surface that unblocks that: signup, password grant,
 * refresh, get-user, logout, all signing/verifying with the same
 * well-known local secret PostgREST's `jwt-secret` and AuthGuard's
 * fallback already use (see constants.ts), so the real app validates
 * consistently end-to-end with no code under test aware it isn't talking
 * to real Supabase Auth.
 */

interface StoredUser {
  id: string;
  email: string;
  password: string;
}

interface StartOptions {
  gatewayPort: number;
  postgrestPort: number;
  jwtSecret: string;
  dbUrl: string;
  webOrigin: string;
}

function userObject(user: StoredUser) {
  const now = new Date().toISOString();
  return {
    id: user.id,
    aud: "authenticated",
    role: "authenticated",
    email: user.email,
    email_confirmed_at: now,
    created_at: now,
    updated_at: now,
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
    identities: [],
  };
}

function sessionResponse(user: StoredUser, jwtSecret: string) {
  const accessToken = mintJwt({ sub: user.id, email: user.email, secret: jwtSecret });
  return {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: `refresh_${user.id}_${Date.now()}`,
    user: userObject(user),
  };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-credentials": "true",
  }).end(text);
}

/** Best-effort insert into the real `auth.users` table (bootstrap.sql's shim) so `auth.uid()`/RLS see a row backing this session's `sub`. Ignores a duplicate-email conflict (re-signup, or the same demo user across runs). */
function insertAuthUser(dbUrl: string, id: string, email: string): void {
  const sql = `insert into auth.users (id, email) values ('${id}', '${email}') on conflict (id) do nothing;`;
  const result = spawnSync("psql", [dbUrl, "-q", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Failed to seed auth.users for ${email}: ${result.stderr}`);
  }
}

export function startAuthGateway(options: StartOptions): Promise<Server> {
  const { gatewayPort, postgrestPort, jwtSecret, dbUrl, webOrigin } = options;
  const usersByEmail = new Map<string, StoredUser>();
  const usersById = new Map<string, StoredUser>();

  function requireBearerUser(req: IncomingMessage): StoredUser | null {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    const claims = verifyJwt(header.slice("Bearer ".length), jwtSecret);
    if (!claims) return null;
    return usersById.get(claims.sub) ?? null;
  }

  const server = http.createServer((req, res) => {
    res.setHeader("access-control-allow-origin", webOrigin);
    res.setHeader("access-control-allow-credentials", "true");
    if (req.method === "OPTIONS") {
      res
        .writeHead(204, {
          "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
          "access-control-allow-headers": "authorization,content-type,apikey,x-client-info",
        })
        .end();
      return;
    }

    void handle(req, res).catch((error: unknown) => {
      sendJson(res, 500, { error: "internal", message: String(error) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${gatewayPort}`);

    // --- Auth ---------------------------------------------------------
    if (url.pathname === "/auth/v1/signup" && req.method === "POST") {
      const body = await readJsonBody(req);
      const email = String(body.email ?? "");
      const password = String(body.password ?? "");
      if (usersByEmail.has(email)) {
        sendJson(res, 422, { error: "user_already_exists", message: "User already registered", msg: "User already registered" });
        return;
      }
      const user: StoredUser = { id: randomUUID(), email, password };
      usersByEmail.set(email, user);
      usersById.set(user.id, user);
      insertAuthUser(dbUrl, user.id, email);
      sendJson(res, 200, sessionResponse(user, jwtSecret));
      return;
    }

    if (url.pathname === "/auth/v1/token" && req.method === "POST") {
      const grantType = url.searchParams.get("grant_type");
      if (grantType === "password") {
        const body = await readJsonBody(req);
        const user = usersByEmail.get(String(body.email ?? ""));
        if (!user || user.password !== body.password) {
          sendJson(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials" });
          return;
        }
        sendJson(res, 200, sessionResponse(user, jwtSecret));
        return;
      }
      if (grantType === "refresh_token") {
        // This harness's sessions are long-lived enough (1h) that no
        // smoke-test run needs a real refresh; accept any refresh token
        // tied to a still-known user id embedded in it isn't worth
        // reconstructing here — reject cleanly instead of pretending.
        sendJson(res, 400, { error: "invalid_grant", error_description: "Refresh not supported by the Gate 6 harness" });
        return;
      }
      sendJson(res, 400, { error: "unsupported_grant_type" });
      return;
    }

    if (url.pathname === "/auth/v1/logout" && req.method === "POST") {
      res.writeHead(204).end();
      return;
    }

    if (url.pathname === "/auth/v1/user" && req.method === "GET") {
      const user = requireBearerUser(req);
      if (!user) {
        sendJson(res, 401, { error: "unauthorized", message: "Invalid or expired token" });
        return;
      }
      sendJson(res, 200, userObject(user));
      return;
    }

    // --- REST (proxied to real PostgREST, /rest/v1 prefix stripped) ---
    if (url.pathname.startsWith("/rest/v1")) {
      const forwardPath = url.pathname.slice("/rest/v1".length) + url.search || "/";
      const upstream = http.request(
        { host: "127.0.0.1", port: postgrestPort, path: forwardPath, method: req.method, headers: req.headers },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      upstream.on("error", (err) => {
        res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: String(err) }));
      });
      req.pipe(upstream);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_found" }));
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(gatewayPort, "127.0.0.1", () => resolve(server));
  });
}

export function stopAuthGateway(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
