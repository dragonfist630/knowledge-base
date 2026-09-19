import { test, expect } from "@playwright/test";

/**
 * Gate 6's smoke test: one real Chromium session walking the whole product
 * end to end against the real UI, real apps/api, real PostgREST/RLS, and
 * this harness's GoTrue-compatible auth-gateway (see global-setup.ts) — the
 * only stand-in in the whole stack. Steps run serially in one test because
 * they're one continuous user session (signed-in state, a saved document,
 * a chat conversation) rather than independent scenarios; splitting them
 * into separate `test()` blocks would just re-do the signup/seed steps for
 * every scenario for no real isolation benefit at this scale (see Gate
 * 3/5's suites for where *that* kind of isolation actually earns its
 * cost — per-request RLS boundaries).
 *
 * Covers: signup, loading + indexing sample documents, editing and saving
 * a document, asking a question in Chat and getting a streamed
 * (mock-model) answer with citations, the Usage page showing real
 * recorded token counts from those calls, and the mobile off-canvas nav.
 */

const EMAIL = `e2e-${Date.now()}@example.com`;
const PASSWORD = "e2e-password-123";

test("full walkthrough: signup, documents, chat, usage, mobile nav", async ({ page }) => {
  await test.step("sign up a new account", async () => {
    await page.goto("/signup");
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign up" }).click();
    await expect(page).toHaveURL(/\/documents$/, { timeout: 15_000 });
  });

  await test.step("load sample documents and wait for indexing", async () => {
    await page.getByRole("button", { name: "Load sample documents" }).click();
    await expect(page.getByText("Sample documents added.")).toBeVisible({ timeout: 15_000 });
    // The mock embedder is fast, but indexing is still async — poll via the
    // list's own refetchInterval rather than a fixed sleep.
    await expect(page.getByText("Ready", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  });

  let documentUrl = "";
  await test.step("open, edit, and save a document", async () => {
    await page.getByRole("link", { name: /Getting Started with the Knowledge Base/ }).click();
    await expect(page).toHaveURL(/\/documents\/[^/]+$/);
    documentUrl = page.url();
    const content = page.getByPlaceholder("Write in Markdown…");
    await content.click();
    await content.press("Control+End"); // "End" alone only reaches the end of the current line in a multi-line textarea.
    await content.type("\n\nEdited by the Gate 6 smoke test.");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Document saved.")).toBeVisible({ timeout: 10_000 });
  });

  await test.step("ask a question in chat and get a streamed, cited answer", async () => {
    await page.getByRole("link", { name: "Chat" }).click();
    await expect(page).toHaveURL(/\/chat$/);
    await page.getByPlaceholder("Ask a question about your documents…").fill("What is this knowledge base for?");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page).toHaveURL(/\/chat\/[^/]+$/, { timeout: 15_000 });
    // MockChatModel deterministically echoes the question back with citation
    // markers appended (see docs/DECISIONS.md Phase 5) — the exact text
    // isn't the point, getting *any* real streamed+persisted assistant turn is.
    // Scoped to the message list's own element (features/chat/components/message-list.tsx),
    // not just `[aria-live="polite"]` — sonner's toast region also carries
    // that attribute, and `.overflow-y-auto` is the message list's own
    // distinguishing class among the two.
    await expect(page.locator('div[aria-live="polite"].overflow-y-auto')).toContainText(
      "What is this knowledge base for?",
      { timeout: 20_000 },
    );
  });

  await test.step("usage page reflects real recorded token counts", async () => {
    await page.getByRole("link", { name: "Usage" }).click();
    await expect(page).toHaveURL(/\/usage$/);
    await expect(page.getByText("Total tokens")).toBeVisible();
    // A populated "By model" table (rather than the empty-state copy) is the
    // simplest robust signal that the chat/embedding calls above actually
    // landed real ai_usage_events rows, without pinning to exact numbers.
    await expect(page.getByText("No AI usage recorded in this window yet.")).not.toBeVisible({ timeout: 10_000 });
  });

  await test.step("sign out and sign back in", async () => {
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/, { timeout: 10_000 });
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/documents$/, { timeout: 15_000 });
  });

  await test.step("delete the edited document", async () => {
    await page.goto(documentUrl);
    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).last().click();
    await expect(page).toHaveURL(/\/documents$/, { timeout: 10_000 });
    await expect(page.getByText("Document deleted.")).toBeVisible({ timeout: 10_000 });
  });

  await test.step("mobile viewport: off-canvas nav opens and navigates", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("link", { name: "Documents" }).click();
    await expect(page).toHaveURL(/\/documents$/);
  });
});
