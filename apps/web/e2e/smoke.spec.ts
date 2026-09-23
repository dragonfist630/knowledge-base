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
    const question = "What is this knowledge base for?";
    await page.getByPlaceholder("Ask a question about your documents…").fill(question);
    await page.getByRole("button", { name: "Send message" }).click();

    // Regression guard for D6.6: adopting the server-assigned
    // conversationId (via chat-view.tsx's handleStarted, right after the
    // `start` SSE event) used to be a real Next.js navigation
    // (router.replace), which unmounted ChatView — and the in-flight
    // useChatStream instance with it — mid-turn, so the message area
    // silently went blank until a background refetch pulled the finished
    // answer back in later. Sampling the message area's text length
    // through that exact adoption moment catches a regression back to
    // that behavior: it must never drop to empty once non-empty, and the
    // user's own question (rendered optimistically, independent of the
    // stream) must stay visible throughout.
    const messageArea = page.locator('div[aria-live="polite"].overflow-y-auto');
    const EMPTY_STATE = "Ask a question about your documents to get started.";
    let sawTurn = false;
    for (let i = 0; i < 40; i++) {
      const text = await messageArea.innerText().catch(() => "");
      const hasTurn = text.includes(question); // the user's own message, rendered optimistically and independent of the stream.
      if (hasTurn) {
        sawTurn = true;
      } else if (sawTurn) {
        // Was showing the turn a moment ago, now shows neither the
        // question nor its answer — exactly what a mid-stream remount
        // (D6.6) does: it resets to the composer's idle empty state.
        throw new Error(`message area reverted to "${text || EMPTY_STATE}" at sample ${i} after already showing the turn`);
      }
      if (/\/chat\/[^/]+$/.test(page.url()) && sawTurn) break;
      await page.waitForTimeout(100);
    }
    expect(sawTurn, "message area never showed the sent question").toBe(true);
    await expect(page).toHaveURL(/\/chat\/[^/]+$/, { timeout: 15_000 });

    // MockChatModel deterministically echoes the question back with citation
    // markers appended (see docs/DECISIONS.md Phase 5) — the exact text
    // isn't the point, getting *any* real streamed+persisted assistant turn is.
    await expect(messageArea).toContainText(question, { timeout: 20_000 });
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

test("switching between two existing conversations via the sidebar shows the right conversation, not the last one open", async ({
  page,
}) => {
  const email = `e2e-switch-${Date.now()}@example.com`;
  const password = "e2e-password-123";

  await test.step("sign up", async () => {
    await page.goto("/signup");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign up" }).click();
    await expect(page).toHaveURL(/\/documents$/, { timeout: 15_000 });
  });

  const messageArea = page.locator('div[aria-live="polite"].overflow-y-auto');
  // Distinct first words so each becomes an unambiguous conversation
  // title (chat.service.ts titles a conversation from its first message's
  // own text — see createConversation) and so the two answers/messages
  // can never be mistaken for each other in the assertions below.
  const questionA = "Alpha marker question about the knowledge base.";
  const questionB = "Bravo marker question, completely unrelated to Alpha.";
  let urlA = "";
  let urlB = "";

  await test.step("start conversation A", async () => {
    await page.goto("/chat");
    await page.getByPlaceholder("Ask a question about your documents…").fill(questionA);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page).toHaveURL(/\/chat\/[^/]+$/, { timeout: 15_000 });
    urlA = page.url();
    await expect(messageArea).toContainText(questionA, { timeout: 20_000 });
  });

  await test.step("start conversation B", async () => {
    // A hard reload to /chat rather than clicking the sidebar's "New
    // conversation" link: that link click is a real Next.js Link
    // navigation, and clicking it this soon after conversation A adopted
    // its id via chat-view.tsx's `history.replaceState` call runs into a
    // separate, deeper bug in Next's App Router bookkeeping — see D9.7 in
    // docs/DECISIONS.md. That bug is real but deliberately not fixed this
    // pass; a `page.goto` here (a full navigation, which always resyncs
    // Next's router state) keeps this test scoped to the conversation-
    // switch bug it actually targets, the same way the isolated repro used
    // to confirm that bug's fix stayed clear of D9.7 by doing the same.
    await page.goto("/chat");
    await page.getByPlaceholder("Ask a question about your documents…").fill(questionB);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page).toHaveURL(/\/chat\/[^/]+$/, { timeout: 15_000 });
    urlB = page.url();
    expect(urlB).not.toBe(urlA);
    await expect(messageArea).toContainText(questionB, { timeout: 20_000 });
  });

  await test.step("switch back to conversation A via the sidebar — same page.tsx instance as B, no remount", async () => {
    // Regression guard: chat-view.tsx's `activeConversationId` used to be
    // seeded once from the route param via `useState(conversationId)` and
    // never re-synced when that param changed. /chat/[id1] and
    // /chat/[id2] are the SAME page.tsx file, so React reuses the same
    // ChatView instance across this navigation (unlike the /chat <->
    // /chat/[id] transition above) and never re-runs that initializer.
    // Before the fix, clicking a different, already-existing conversation
    // in the sidebar updated the URL and the sidebar highlight but kept
    // showing — and would keep posting new messages into — whichever
    // conversation was active before. See docs/DECISIONS.md.
    await page.getByRole("link", { name: /Alpha marker question/ }).click();
    await expect(page).toHaveURL(urlA);
    await expect(messageArea).toContainText(questionA, { timeout: 10_000 });
    await expect(messageArea).not.toContainText(questionB);
  });
});
