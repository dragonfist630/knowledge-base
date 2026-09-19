import { ApiErrorResponseSchema } from "@kb/shared";
import type { z } from "zod";

import { ApiError } from "@/lib/api/error";
import { createClient } from "@/lib/supabase/browser";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

/**
 * apps/api never has an anonymous route that returns app data — every
 * request needs the caller's own Supabase session as a Bearer token, so
 * this reads it fresh on every call rather than caching it: a stale
 * access token would just 401, and letting the browser Supabase client
 * (which refreshes tokens itself) be the single source of truth avoids a
 * second, competing notion of "the current session" living in this file.
 */
async function authHeader(): Promise<Record<string, string>> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}

export interface ApiFetchOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * The one place apps/web talks to apps/api. Attaches the Bearer token,
 * JSON-encodes `body`, and — when a zod schema is given — validates the
 * response shape before handing it back, so a contract drift between the
 * two apps fails loudly here instead of producing a confusing runtime
 * error three components downstream. A non-2xx response always throws
 * ApiError, parsed from apps/api's one documented error body shape
 * (@kb/shared's ApiErrorResponseSchema) when present.
 */
export async function apiFetch<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  options: ApiFetchOptions = {},
): Promise<z.infer<Schema>> {
  const headers: Record<string, string> = { ...(await authHeader()) };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  if (!res.ok) {
    throw await toApiError(res);
  }

  if (res.status === 204) {
    return schema.parse(undefined);
  }

  const json: unknown = await res.json();
  return schema.parse(json);
}

/** Same as apiFetch, but for endpoints with no response body worth validating (e.g. DELETE). */
export async function apiFetchVoid(path: string, options: ApiFetchOptions = {}): Promise<void> {
  const headers: Record<string, string> = { ...(await authHeader()) };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  if (!res.ok) {
    throw await toApiError(res);
  }
}

/** Exported so lib/api/chat-stream.ts (a non-JSON, non-2xx-checked fetch) can build the same ApiError shape from a failed SSE response. */
export async function toApiError(res: Response): Promise<ApiError> {
  let parsedBody: ReturnType<typeof ApiErrorResponseSchema.safeParse> | undefined;
  try {
    const json: unknown = await res.json();
    parsedBody = ApiErrorResponseSchema.safeParse(json);
  } catch {
    parsedBody = undefined;
  }
  return new ApiError(res.status, parsedBody?.success ? parsedBody.data : undefined, res.statusText || "Request failed.");
}

export { API_URL };
