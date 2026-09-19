import { ChatEventSchema, type ChatEvent, type ChatRequest } from "@kb/shared";

import { API_URL, toApiError } from "@/lib/api/client";
import { createClient } from "@/lib/supabase/browser";

async function authHeader(): Promise<Record<string, string>> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}

/**
 * Consumes POST /chat/stream's SSE body and yields typed ChatEvent objects,
 * one per server frame: `start` -> `sources` -> (`delta` | `citation`)* ->
 * (`done` | `error`), mirroring apps/api's exact wire framing
 * (chat.controller.ts's `writeEvent`: `data: <json>\n\n` per event) and its
 * `: heartbeat\n\n` comment lines, which are read and discarded here rather
 * than ever reaching the caller. Every frame is re-validated against the
 * same ChatEventSchema apps/api validates against before writing, so a
 * contract drift between the two apps fails loudly in the UI instead of
 * silently rendering garbage.
 *
 * Callers drive cancellation with `signal` (an AbortController), same as
 * `apiFetch` — aborting mid-stream rejects the in-flight `reader.read()`
 * and the `for await` loop simply stops, no separate cleanup needed beyond
 * the `finally`'s `releaseLock()`.
 */
export async function* streamChat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  const headers: Record<string, string> = {
    ...(await authHeader()),
    "Content-Type": "application/json",
  };

  const res = await fetch(`${API_URL}/chat/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    signal,
  });

  if (!res.ok || !res.body) {
    throw await toApiError(res);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames are blank-line-delimited (the SSE spec's own framing, and
      // exactly what `res.write(\`data: ${json}\n\n\`)` produces); keep
      // whatever trailing partial frame hasn't arrived yet in `buffer`.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const event = parseFrame(frame);
        if (event) yield event;
      }
    }

    // `res.end()` after the final write can leave one frame with no
    // trailing blank line still sitting in `buffer` — flush it too.
    const trailing = parseFrame(buffer);
    if (trailing) yield trailing;
  } finally {
    reader.releaseLock();
  }
}

/** Parses one blank-line-delimited SSE frame. Returns null for a heartbeat comment (`: heartbeat`) or an empty trailing frame. */
function parseFrame(frame: string): ChatEvent | null {
  const dataLines = frame
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
  if (dataLines.length === 0) return null;

  const json: unknown = JSON.parse(dataLines.join("\n"));
  return ChatEventSchema.parse(json);
}
