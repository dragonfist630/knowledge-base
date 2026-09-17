import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { IndexingQueue } from "../src/indexing/indexing.queue.js";

/**
 * Gate 3 e2e — real HTTP requests against a real Postgres+RLS+PostgREST
 * stack (test/e2e/global-setup.ts), two real seeded users, hand-minted
 * JWTs verified by AuthGuard's actual local-HS256 fallback path. See
 * docs/DECISIONS.md Phase 3, D3.1 for why there's no Docker/local Supabase
 * involved and why that doesn't make this a weaker test of AuthGuard
 * itself.
 */
describe("Documents (e2e)", () => {
  let app: INestApplication;
  const { userA, userB } = globalThis.__KB_E2E__;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const authed = (jwt: string) => `Bearer ${jwt}`;

  it("rejects requests with no Authorization header", async () => {
    await request(app.getHttpServer()).get("/documents").expect(401);
  });

  it("400s an invalid create body with field-level errors", async () => {
    const res = await request(app.getHttpServer())
      .post("/documents")
      .set("Authorization", authed(userA.jwt))
      .send({ title: "" }) // title must be 1-200 chars after trim
      .expect(400);

    expect(res.body.code).toBe("validation_error");
    expect(Array.isArray(res.body.fieldErrors)).toBe(true);
    expect(res.body.fieldErrors.some((e: { path: string }) => e.path === "title")).toBe(true);
  });

  it("full CRUD lifecycle for user A", async () => {
    // Create
    const createRes = await request(app.getHttpServer())
      .post("/documents")
      .set("Authorization", authed(userA.jwt))
      .send({ title: "Runbook: deploys", content: "Step one. Step two.", tags: ["Ops", "ops", " Runbook "] })
      .expect(201);

    expect(createRes.body.title).toBe("Runbook: deploys");
    expect(createRes.body.content).toBe("Step one. Step two.");
    // Tag normalization: trimmed, lowercased, deduped.
    expect(createRes.body.tags.sort()).toEqual(["ops", "runbook"]);
    expect(createRes.body.indexStatus).toBe("pending");
    const docId: string = createRes.body.id;

    // content_hash isn't exposed on the DTO (see documents.repository.ts's
    // SUMMARY/DETAIL columns), so this reaches into the same in-process
    // IndexingQueue instance the running app uses to observe it directly —
    // documents.service only enqueues a new job when the hash actually
    // changes (see documents.service.ts / documents.service.spec.ts).
    const indexingQueue = app.get(IndexingQueue);
    const hashAfterCreate = indexingQueue.peek(docId)?.contentHash;
    expect(hashAfterCreate).toBeTruthy();

    // Read
    const getRes = await request(app.getHttpServer())
      .get(`/documents/${docId}`)
      .set("Authorization", authed(userA.jwt))
      .expect(200);
    expect(getRes.body.id).toBe(docId);

    // List includes it
    const listRes = await request(app.getHttpServer())
      .get("/documents")
      .set("Authorization", authed(userA.jwt))
      .expect(200);
    expect(listRes.body.items.some((d: { id: string }) => d.id === docId)).toBe(true);

    // Tags-only update must NOT change content_hash / re-trigger indexing.
    const tagsUpdateRes = await request(app.getHttpServer())
      .patch(`/documents/${docId}`)
      .set("Authorization", authed(userA.jwt))
      .send({ tags: ["ops", "runbook", "deploys"] })
      .expect(200);
    expect(tagsUpdateRes.body.tags.sort()).toEqual(["deploys", "ops", "runbook"]);
    // Tags-only: no new job enqueued at all, so the queue still shows
    // exactly the hash that was there right after creation.
    expect(indexingQueue.peek(docId)?.contentHash).toBe(hashAfterCreate);

    // A title/content change DOES re-trigger indexing (hash changes).
    const contentUpdateRes = await request(app.getHttpServer())
      .patch(`/documents/${docId}`)
      .set("Authorization", authed(userA.jwt))
      .send({ content: "Step one. Step two. Step three." })
      .expect(200);
    expect(contentUpdateRes.body.content).toBe("Step one. Step two. Step three.");
    expect(indexingQueue.peek(docId)?.contentHash).not.toBe(hashAfterCreate);

    // Delete
    await request(app.getHttpServer()).delete(`/documents/${docId}`).set("Authorization", authed(userA.jwt)).expect(204);

    // Gone for its own owner too.
    await request(app.getHttpServer()).get(`/documents/${docId}`).set("Authorization", authed(userA.jwt)).expect(404);
  });

  it("404s user B on user A's document (RLS isolation, not a leaked 403)", async () => {
    const createRes = await request(app.getHttpServer())
      .post("/documents")
      .set("Authorization", authed(userA.jwt))
      .send({ title: "User A private doc", content: "secret" })
      .expect(201);
    const docId: string = createRes.body.id;

    // User B can't see it at all — RLS makes the row simply not exist from
    // B's perspective, so this is a 404, never a 403 (which would leak
    // that *something* is there).
    await request(app.getHttpServer()).get(`/documents/${docId}`).set("Authorization", authed(userB.jwt)).expect(404);

    // Nor can B list, update, or delete it.
    const listRes = await request(app.getHttpServer()).get("/documents").set("Authorization", authed(userB.jwt)).expect(200);
    expect(listRes.body.items.some((d: { id: string }) => d.id === docId)).toBe(false);

    await request(app.getHttpServer())
      .patch(`/documents/${docId}`)
      .set("Authorization", authed(userB.jwt))
      .send({ title: "hijacked" })
      .expect(404);

    await request(app.getHttpServer()).delete(`/documents/${docId}`).set("Authorization", authed(userB.jwt)).expect(404);

    // Still there for its real owner.
    await request(app.getHttpServer()).get(`/documents/${docId}`).set("Authorization", authed(userA.jwt)).expect(200);
  });

  it("400s an invalid update body (empty patch) with field-level errors", async () => {
    const createRes = await request(app.getHttpServer())
      .post("/documents")
      .set("Authorization", authed(userA.jwt))
      .send({ title: "Doc for empty-patch check", content: "x" })
      .expect(201);

    const res = await request(app.getHttpServer())
      .patch(`/documents/${createRes.body.id}`)
      .set("Authorization", authed(userA.jwt))
      .send({}) // DocumentUpdateSchema.refine() requires >= 1 field present
      .expect(400);
    expect(res.body.code).toBe("validation_error");
    expect(Array.isArray(res.body.fieldErrors)).toBe(true);
  });

  it("404s a well-formed but nonexistent document id", async () => {
    await request(app.getHttpServer())
      .get("/documents/00000000-0000-0000-0000-000000000000")
      .set("Authorization", authed(userA.jwt))
      .expect(404);
  });

  it("400s a malformed document id (not a uuid)", async () => {
    await request(app.getHttpServer()).get("/documents/not-a-uuid").set("Authorization", authed(userA.jwt)).expect(400);
  });
});
