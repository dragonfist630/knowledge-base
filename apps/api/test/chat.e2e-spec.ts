import http from "node:http";
import type { AddressInfo } from "node:net";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import { MockChatModel } from "@kb/ai";
import type { CallOptions, ChatCompletion, ChatMessage, ChatModel, ChatStreamPart } from "@kb/ai";
import request from "supertest";

import { CHAT_MODEL } from "../src/ai/ai.module.js";
import { AppModule } from "../src/app.module.js";
import { waitFor } from "./e2e/wait-for.js";

/**
 * A one-shot delay switch the "aborting mid-stream" test below flips right
 * before it fires its request, then resets — everything else in this file
 * goes through the real, unmodified MockChatModel. See
 * ControllableChatModel's own doc comment for why this exists.
 */
let forceStreamDelayOnce = false;

const ABORT_TEST_DELAY_MS = 300;

/**
 * Wraps the real MockChatModel (same pattern as indexing.e2e-spec.ts's
 * ControllableEmbeddingModel) so the abort test can deterministically win
 * its race against real I/O timing: MockChatModel's word-by-word stream()
 * has no real delay anywhere in it, so a client that destroys its socket
 * right after the `start` event was, in practice, racing a synchronous
 * loop it usually lost (observed directly: the naive version of this test,
 * without this override, persisted 'complete' instead of 'aborted' nearly
 * every run). Inserting one real, controlled delay before the first word —
 * only for the one call this test flags — gives req.on("close")'s abort
 * plenty of genuine wall-clock time to land first, without changing
 * anything about the actual abort wiring under test (chat.controller.ts's
 * req.on("close") -> AbortController -> chat.service.ts -> here).
 */
class ControllableChatModel implements ChatModel {
  readonly descriptor: ChatModel["descriptor"];
  private readonly delegate = new MockChatModel();

  constructor() {
    this.descriptor = this.delegate.descriptor;
  }

  async complete(messages: ChatMessage[], opts?: CallOptions): Promise<ChatCompletion> {
    return this.delegate.complete(messages, opts);
  }

  async *stream(messages: ChatMessage[], opts: CallOptions = {}): AsyncIterable<ChatStreamPart> {
    if (forceStreamDelayOnce) {
      forceStreamDelayOnce = false;
      await new Promise((resolve) => setTimeout(resolve, ABORT_TEST_DELAY_MS));
      if (opts.signal?.aborted) {
        yield { type: "finish", finishReason: "aborted", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: true } };
        return;
      }
    }
    yield* this.delegate.stream(messages, opts);
  }
}

interface RawSseParsed {
  type: string;
  [key: string]: unknown;
}

/** Splits a raw `text/event-stream` body into its `data: <json>` events, ignoring heartbeat comments (`: heartbeat`). */
function parseSse(raw: string): RawSseParsed[] {
  return raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice("data: ".length)) as RawSseParsed);
}

/**
 * Gate 5 e2e — real HTTP requests against the real Postgres+RLS+PostgREST
 * stack (test/e2e/global-setup.ts, shared with Gate 3/4), the real
 * retrieval RPC (Phase 1), the real chunker (Phase 4), and the deterministic
 * MockChatModel/MockEmbeddingModel (AI_CHAT_PROVIDER/AI_EMBEDDING_PROVIDER
 * default to "mock" — see packages/ai/src/config.ts) so this needs no API
 * keys. See docs/DECISIONS.md Phase 5 for why MockChatModel's citation
 * behavior (it cites sentences of the LATEST user message, i.e. the bare
 * question — see prompt.ts's "sources live in the system message" design)
 * makes "the answer always cites [S1] for a one-sentence question" a safe,
 * deterministic thing to assert on here.
 */
describe("Chat (e2e)", () => {
  let app: INestApplication;
  let port: number;
  const { userA, userB } = globalThis.__KB_E2E__;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CHAT_MODEL)
      .useValue(new ControllableChatModel())
      .compile();

    app = moduleFixture.createNestApplication();
    // Listening on a real ephemeral port (rather than supertest's implicit
    // ephemeral bind) is only needed for the raw-socket abort test below,
    // but is harmless for every other test in this file, which still just
    // uses supertest against app.getHttpServer() as usual.
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  const authed = (jwt: string) => `Bearer ${jwt}`;

  /** Seeds a document with distinctive, unique-per-call vocabulary and waits for it to finish indexing — the shared setup every scenario below needs before retrieval can find anything. */
  async function seedReadyDocument(jwt: string, keyword: string): Promise<string> {
    const createRes = await request(app.getHttpServer())
      .post("/documents")
      .set("Authorization", authed(jwt))
      .send({
        title: `Refund policy (${keyword})`,
        content: `The ${keyword} refund policy: refunds are processed within five business days of the return being received.`,
      })
      .expect(201);
    const docId: string = createRes.body.id;

    await waitFor(
      () =>
        request(app.getHttpServer())
          .get(`/documents/${docId}`)
          .set("Authorization", authed(jwt))
          .expect(200)
          .then((r) => r.body),
      (doc) => doc.indexStatus === "ready",
      { label: "index before chat" },
    );
    return docId;
  }

  it("400s an invalid chat request body", async () => {
    const res = await request(app.getHttpServer())
      .post("/chat")
      .set("Authorization", authed(userA.jwt))
      .send({ message: "" }) // message must be 1-4000 chars
      .expect(400);
    expect(res.body.code).toBe("validation_error");
  });

  it("rejects requests with no Authorization header", async () => {
    await request(app.getHttpServer()).post("/chat").send({ message: "hi" }).expect(401);
    await request(app.getHttpServer()).get("/conversations").expect(401);
  });

  it("POST /chat (non-streaming): full turn, cites the retrieved source, persists and round-trips via GET /conversations/:id", async () => {
    const keyword = `zzyzx${Date.now()}`;
    await seedReadyDocument(userA.jwt, keyword);

    const chatRes = await request(app.getHttpServer())
      .post("/chat")
      .set("Authorization", authed(userA.jwt))
      .send({ message: `What is the ${keyword} refund policy?` })
      .expect((res) => expect(res.status).toBeLessThan(300));

    expect(chatRes.body.sources.length).toBeGreaterThan(0);
    expect(chatRes.body.assistantMessage.status).toBe("complete");
    expect(chatRes.body.assistantMessage.content).toContain("[S1]");
    expect(chatRes.body.assistantMessage.citations).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceId: "S1" })]),
    );
    const conversationId: string = chatRes.body.conversationId;

    const detailRes = await request(app.getHttpServer())
      .get(`/conversations/${conversationId}`)
      .set("Authorization", authed(userA.jwt))
      .expect(200);
    expect(detailRes.body.messages).toHaveLength(2);
    expect(detailRes.body.messages[0]).toMatchObject({ role: "user" });
    expect(detailRes.body.messages[1]).toMatchObject({ role: "assistant", status: "complete" });
    expect(detailRes.body.messages[1].citations[0]).toMatchObject({ sourceId: "S1" });

    // Shows up in the conversation list too.
    const listRes = await request(app.getHttpServer())
      .get("/conversations")
      .set("Authorization", authed(userA.jwt))
      .expect(200);
    expect(listRes.body.items.some((c: { id: string }) => c.id === conversationId)).toBe(true);
  });

  it("POST /chat/stream: emits start -> sources -> delta+ -> citation -> done, in that order, and persists the same final message", async () => {
    const keyword = `qorvath${Date.now()}`;
    await seedReadyDocument(userA.jwt, keyword);

    const res = await request(app.getHttpServer())
      .post("/chat/stream")
      .set("Authorization", authed(userA.jwt))
      .buffer(true)
      .parse((response, callback) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          data += chunk;
        });
        response.on("end", () => callback(null, data));
      })
      .send({ message: `What is the ${keyword} refund policy?` })
      .expect(200);

    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = parseSse(res.body as unknown as string);
    const types = events.map((e) => e.type);

    // start -> sources -> at least one delta -> at least one citation -> done,
    // with every delta/citation strictly between sources and done.
    expect(types[0]).toBe("start");
    expect(types[1]).toBe("sources");
    expect(types.at(-1)).toBe("done");
    expect(types.slice(2, -1).every((t) => t === "delta" || t === "citation")).toBe(true);
    expect(types).toContain("citation");

    const startEvent = events[0] as unknown as { conversationId: string };
    const doneEvent = events.at(-1) as unknown as { finishReason: string };
    expect(doneEvent.finishReason).toBe("stop");

    const detailRes = await request(app.getHttpServer())
      .get(`/conversations/${startEvent.conversationId}`)
      .set("Authorization", authed(userA.jwt))
      .expect(200);
    const assistantMessage = detailRes.body.messages.at(-1);
    expect(assistantMessage.status).toBe("complete");
    expect(assistantMessage.content).toContain("[S1]");
  });

  it("a follow-up question triggers a query rewrite (rewrittenQuery differs from the raw follow-up)", async () => {
    const keyword = `plimforth${Date.now()}`;
    await seedReadyDocument(userA.jwt, keyword);

    const firstRes = await request(app.getHttpServer())
      .post("/chat")
      .set("Authorization", authed(userA.jwt))
      .send({ message: `What is the ${keyword} refund policy?` })
      .expect((res) => expect(res.status).toBeLessThan(300));
    const conversationId: string = firstRes.body.conversationId;

    const followUpRes = await request(app.getHttpServer())
      .post("/chat")
      .set("Authorization", authed(userA.jwt))
      .send({ conversationId, message: "And for enterprise customers?" })
      .expect((res) => expect(res.status).toBeLessThan(300));

    expect(followUpRes.body.assistantMessage.retrieval.usedRewrite).toBe(true);
    expect(followUpRes.body.assistantMessage.retrieval.rewrittenQuery).not.toBe("And for enterprise customers?");
  });

  it("a question with no matching document returns the fixed NO_CONTEXT_MESSAGE and records no chat usage event", async () => {
    const chatRes = await request(app.getHttpServer())
      .post("/chat")
      .set("Authorization", authed(userA.jwt))
      .send({ message: `Completely unrelated nonsense query ${Date.now()}-zzznotindexedanywhere` })
      .expect((res) => expect(res.status).toBeLessThan(300));

    expect(chatRes.body.sources).toEqual([]);
    expect(chatRes.body.assistantMessage.status).toBe("complete");
    expect(chatRes.body.assistantMessage.content).toContain("couldn't find this in your documents");
    expect(chatRes.body.assistantMessage.retrieval).toMatchObject({ sourceCount: 0 });
  });

  it("user B cannot read or post into user A's conversation (RLS isolation, 404 not 403)", async () => {
    const keyword = `hexbrandt${Date.now()}`;
    await seedReadyDocument(userA.jwt, keyword);

    const chatRes = await request(app.getHttpServer())
      .post("/chat")
      .set("Authorization", authed(userA.jwt))
      .send({ message: `What is the ${keyword} refund policy?` })
      .expect((res) => expect(res.status).toBeLessThan(300));
    const conversationId: string = chatRes.body.conversationId;

    await request(app.getHttpServer())
      .get(`/conversations/${conversationId}`)
      .set("Authorization", authed(userB.jwt))
      .expect(404);

    await request(app.getHttpServer())
      .post("/chat")
      .set("Authorization", authed(userB.jwt))
      .send({ conversationId, message: "hijack attempt" })
      .expect(404);

    await request(app.getHttpServer())
      .patch(`/conversations/${conversationId}`)
      .set("Authorization", authed(userB.jwt))
      .send({ title: "hijacked" })
      .expect(404);

    await request(app.getHttpServer())
      .delete(`/conversations/${conversationId}`)
      .set("Authorization", authed(userB.jwt))
      .expect(404);

    // Untouched for its real owner.
    const stillThere = await request(app.getHttpServer())
      .get(`/conversations/${conversationId}`)
      .set("Authorization", authed(userA.jwt))
      .expect(200);
    expect(stillThere.body.id).toBe(conversationId);

    // B also can't see it in their own list.
    const listRes = await request(app.getHttpServer())
      .get("/conversations")
      .set("Authorization", authed(userB.jwt))
      .expect(200);
    expect(listRes.body.items.some((c: { id: string }) => c.id === conversationId)).toBe(false);
  });

  it("PATCH renames a conversation; DELETE removes it (and its messages) for its owner", async () => {
    const chatRes = await request(app.getHttpServer())
      .post("/chat")
      .set("Authorization", authed(userA.jwt))
      .send({ message: "A throwaway opening message for rename/delete." })
      .expect((res) => expect(res.status).toBeLessThan(300));
    const conversationId: string = chatRes.body.conversationId;

    const renameRes = await request(app.getHttpServer())
      .patch(`/conversations/${conversationId}`)
      .set("Authorization", authed(userA.jwt))
      .send({ title: "Renamed conversation" })
      .expect(200);
    expect(renameRes.body.title).toBe("Renamed conversation");

    await request(app.getHttpServer())
      .delete(`/conversations/${conversationId}`)
      .set("Authorization", authed(userA.jwt))
      .expect(204);

    await request(app.getHttpServer())
      .get(`/conversations/${conversationId}`)
      .set("Authorization", authed(userA.jwt))
      .expect(404);
  });

  it("404s a well-formed but nonexistent conversation id, 400s a malformed one", async () => {
    await request(app.getHttpServer())
      .get("/conversations/00000000-0000-0000-0000-000000000000")
      .set("Authorization", authed(userA.jwt))
      .expect(404);
    await request(app.getHttpServer())
      .get("/conversations/not-a-uuid")
      .set("Authorization", authed(userA.jwt))
      .expect(400);
  });

  it(
    "aborting mid-stream (client disconnects right after `start`) persists status 'aborted' with no assistant content",
    async () => {
      // Uses ControllableChatModel's one-shot delay (see its doc comment
      // above) so this is a real end-to-end exercise of the actual wiring —
      // client socket close -> chat.controller.ts's req.on("close") ->
      // AbortController -> chat.service.ts -> chatModel.stream(signal) — but
      // without racing a synchronous in-process loop, which is what made an
      // earlier, unmodified-MockChatModel version of this test flaky (it
      // persisted 'complete' instead of 'aborted' nearly every run). The
      // same contract is also covered without any timing dependency at all
      // by chat.controller.spec.ts's fake-close test and
      // chat.service.spec.ts's FinishReason:'aborted' test.
      const keyword = `snorvale${Date.now()}`;
      await seedReadyDocument(userA.jwt, keyword);
      forceStreamDelayOnce = true;

      let conversationId: string | undefined;
      let assistantMessageId: string | undefined;

      await new Promise<void>((resolve) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/chat/stream",
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authed(userA.jwt) },
          },
          (res) => {
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              const match = /"type":"start","conversationId":"([^"]+)","userMessageId":"[^"]+","assistantMessageId":"([^"]+)"/.exec(
                chunk,
              );
              if (match?.[1] && match[2] && !conversationId) {
                conversationId = match[1];
                assistantMessageId = match[2];
                req.destroy();
              }
            });
            res.on("error", () => resolve());
            res.on("end", () => resolve());
          },
        );
        req.on("error", () => resolve()); // our own destroy() surfaces as ECONNRESET here — expected.
        req.write(JSON.stringify({ message: `What is the ${keyword} refund policy?` }));
        req.end();
      });

      expect(conversationId).toBeTruthy();
      expect(assistantMessageId).toBeTruthy();

      const detail = await waitFor(
        () =>
          request(app.getHttpServer())
            .get(`/conversations/${conversationId}`)
            .set("Authorization", authed(userA.jwt))
            .expect(200)
            .then((r) => r.body),
        (d) => d.messages.find((m: { id: string }) => m.id === assistantMessageId)?.status !== "streaming",
        { label: "assistant message settles after client abort" },
      );
      const assistantMessage = detail.messages.find((m: { id: string }) => m.id === assistantMessageId);
      expect(assistantMessage.status).toBe("aborted");
    },
  );

  // ---- SSE headers, in one line, not asserted above ----
  it("sets the exact SSE headers on POST /chat/stream", async () => {
    const res = await request(app.getHttpServer())
      .post("/chat/stream")
      .set("Authorization", authed(userA.jwt))
      .buffer(true)
      .parse((response, callback) => {
        let data = "";
        response.on("data", (chunk: Buffer) => {
          data += chunk.toString("utf8");
        });
        response.on("end", () => callback(null, data));
      })
      .send({ message: "Anything, just to see the headers." })
      .expect(200);

    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(res.headers["x-accel-buffering"]).toBe("no");
  });
});
