/**
 * Decides which variables from the monorepo's root `.env` are allowed to
 * reach `next`. Kept apart from with-root-env.mjs (which spawns the
 * process) purely so this decision is a pure function and can be tested
 * directly — see root-env.test.mjs.
 *
 * The rule is an allowlist, and it is an allowlist because the two bugs
 * this file exists to prevent were both caused by passing `next` more of
 * that file than it asked for: `PORT=3001` belongs to apps/api, and made
 * `next dev` bind the API's port so apps/api died on EADDRINUSE (D6.12);
 * `NODE_ENV=development` made `next build` emit a development build that
 * then crashed while prerendering (D6.13). Blocking those two names would
 * have left the next one to be discovered in production, so instead only
 * `NEXT_PUBLIC_*` is taken — the whole of apps/web's contract with that
 * file. Everything else in it configures apps/api and the scripts.
 */

/** The one deliberate exception: a web-side counterpart to apps/api's PORT. */
const WEB_PORT_KEY = "WEB_PORT";

/**
 * @param {Record<string, string | undefined>} inherited environment as it
 *   arrived from the shell — always authoritative, never overridden here,
 *   so `PORT=3100 pnpm dev`, `CI=1` and Gate 6's playwright `webServer.env`
 *   all keep working.
 * @param {Record<string, string | undefined>} combined `process.env` merged
 *   with the parsed root `.env`, as @next/env's loadEnvConfig returns it.
 * @returns {Record<string, string | undefined>} the environment to hand to `next`.
 */
export function resolveWebEnv(inherited, combined) {
  const result = { ...inherited };

  for (const [key, value] of Object.entries(combined)) {
    if (Object.hasOwn(inherited, key)) continue;
    if (key.startsWith("NEXT_PUBLIC_")) result[key] = value;
  }

  if (!Object.hasOwn(inherited, "PORT") && combined[WEB_PORT_KEY]) {
    result.PORT = combined[WEB_PORT_KEY];
  }

  return result;
}
