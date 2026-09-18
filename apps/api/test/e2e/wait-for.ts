/**
 * Small polling helper for e2e assertions against async work (Phase 4's
 * indexing pipeline runs in-process, off the request/response cycle — see
 * IndexingQueue). The mock embedder is fast (no network calls), so this
 * settles in milliseconds in practice; the timeout is generous headroom,
 * not an expected wait.
 */
export async function waitFor<T>(
  poll: () => Promise<T>,
  predicate: (value: T) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const intervalMs = opts.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  let last: T;
  for (;;) {
    last = await poll();
    if (predicate(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitFor${opts.label ? ` (${opts.label})` : ""} timed out after ${timeoutMs}ms. Last value: ${JSON.stringify(last)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
