import { randomUUID } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

interface BodyParserLikeError {
  status?: number;
  statusCode?: number;
}

function statusOf(err: unknown): number {
  if (typeof err === "object" && err !== null) {
    const candidate = err as BodyParserLikeError;
    if (typeof candidate.status === "number") return candidate.status;
    if (typeof candidate.statusCode === "number") return candidate.statusCode;
  }
  return 400;
}

function codeAndMessage(status: number): { code: string; message: string } {
  if (status === 413) return { code: "payload_too_large", message: "Request body is too large." };
  if (status === 415) return { code: "unsupported_media_type", message: "Unsupported request encoding." };
  return { code: "bad_request", message: "Request body could not be parsed." };
}

/**
 * `express.json()`/`express.urlencoded()` (registered explicitly in
 * main.ts, with a limit sized to packages/shared's documented content
 * maximum — see main.ts's own comment) throw BEFORE any Nest guard, pipe,
 * or controller runs, including RequestIdMiddleware and
 * HttpExceptionFilter. Left unhandled, a malformed or oversized body got
 * Express's own raw default error response instead of this app's
 * `{ requestId, code, message }` envelope every other error path
 * guarantees — not just a shape mismatch: in a non-production `NODE_ENV`,
 * Express's default handler also includes a stack trace, exactly what
 * HttpExceptionFilter's own "never leak the raw message" comment was
 * written to prevent, via a code path that filter doesn't cover at all.
 * See docs/DECISIONS.md.
 *
 * Registered immediately after (and only after) the body parsers
 * themselves in main.ts, so nothing else in the app can reach this
 * handler — any error it sees is safely assumed to be a body-parsing
 * error, no `err.type`/`instanceof` sniffing needed.
 */
export function bodyParserErrorMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const inbound = req.headers["x-request-id"];
  const requestId = typeof inbound === "string" && inbound.trim().length > 0 ? inbound : randomUUID();
  res.setHeader("x-request-id", requestId);
  const status = statusOf(err);
  const { code, message } = codeAndMessage(status);
  res.status(status).json({ requestId, code, message });
}
