import http from "node:http";
import type { Server } from "node:http";

/**
 * supabase-js's `.from()` calls always target `${SUPABASE_URL}/rest/v1/<table>`,
 * but plain PostgREST (what the Gate 3 harness runs — see
 * docs/DECISIONS.md Phase 3, D3.1) serves tables at its own root with no
 * fixed path prefix. This tiny reverse proxy strips the `/rest/v1` prefix
 * before forwarding, and 404s everything else — including `/auth/v1/*`,
 * since there's no local GoTrue here, so AuthGuard's `getClaims()` attempt
 * fails fast and falls through to its local-HS256 verification path, the
 * same as it would against a real project whose local stack signs with a
 * shared secret instead of asymmetric keys.
 */
export function startRestProxy(proxyPort: number, postgrestPort: number): Promise<Server> {
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith("/rest/v1")) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const forwardPath = req.url.slice("/rest/v1".length) || "/";
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
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(proxyPort, "127.0.0.1", () => resolve(server));
  });
}

export function stopRestProxy(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
