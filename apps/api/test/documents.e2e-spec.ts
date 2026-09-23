import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { mintJwt } from "./e2e/jwt.js";
import { waitFor } from "./e2e/wait-for.js";

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

    const getDoc = () =>
      request(app.getHttpServer())
        .get(`/documents/${docId}`)
        .set("Authorization", authed(userA.jwt))
        .expect(200)
        .then((r) => r.body);

    // The real indexing pipeline (Phase 4) runs off-request, inside
    // IndexingQueue — poll the document's own HTTP-visible status rather
    // than reaching into internal queue state (content_hash isn't exposed
    // on the DTO at all — see documents.repository.ts's SUMMARY columns).
    // The mock embedder (this env's default) is fast and needs no network,
    // so this settles quickly in practice.
    const readyAfterCreate = await waitFor(getDoc, (doc) => doc.indexStatus === "ready", {
      label: "index after create",
    });
    expect(readyAfterCreate.chunkCount).toBeGreaterThan(0);
    expect(readyAfterCreate.indexedAt).toBeTruthy();
    const indexedAtAfterCreate: string = readyAfterCreate.indexedAt;

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
    // Tags-only: no new job enqueued at all (content_hash didn't change —
    // see computeContentHash / documents.service.spec.ts), so the document
    // is still exactly as indexed right after creation: same status, same
    // indexedAt, same chunk_count.
    expect(tagsUpdateRes.body.indexStatus).toBe("ready");
    expect(tagsUpdateRes.body.indexedAt).toBe(indexedAtAfterCreate);
    expect(tagsUpdateRes.body.chunkCount).toBe(readyAfterCreate.chunkCount);

    // A title/content change DOES re-trigger indexing (hash changes) — ends
    // back at 'ready', with a NEW indexedAt, reflecting the SECOND version.
    const contentUpdateRes = await request(app.getHttpServer())
      .patch(`/documents/${docId}`)
      .set("Authorization", authed(userA.jwt))
      .send({ content: "Step one. Step two. Step three." })
      .expect(200);
    expect(contentUpdateRes.body.content).toBe("Step one. Step two. Step three.");

    const readyAfterUpdate = await waitFor(
      getDoc,
      (doc) => doc.indexStatus === "ready" && doc.indexedAt !== indexedAtAfterCreate,
      { label: "index after content update" },
    );
    expect(readyAfterUpdate.chunkCount).toBeGreaterThan(0);

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

  it("rejects a non-'authenticated' role JWT even with a valid signature (D3.6)", async () => {
    // Regression test for D3.6: AuthGuard used to accept any correctly
    // signed JWT regardless of its `role` claim. A service_role token
    // still gets a *correctly signed* JWT through both verification
    // paths — the only thing stopping it from being treated as a normal
    // user (and, via PostgREST's role-switching, running future queries
    // with RLS bypassed) is this explicit role check.
    const createRes = await request(app.getHttpServer())
      .post("/documents")
      .set("Authorization", authed(userA.jwt))
      .send({ title: "Victim doc for the service-role probe", content: "secret" })
      .expect(201);
    const docId: string = createRes.body.id;

    const forgedServiceRoleJwt = mintJwt({
      sub: userA.id, // even claiming to *be* the real owner doesn't help.
      email: userA.email,
      role: "service_role",
      secret: globalThis.__KB_E2E__.SUPABASE_JWT_SECRET,
    });
    await request(app.getHttpServer())
      .get(`/documents/${docId}`)
      .set("Authorization", authed(forgedServiceRoleJwt))
      .expect(401);

    const forgedAnonJwt = mintJwt({
      sub: userA.id,
      email: userA.email,
      role: "anon",
      secret: globalThis.__KB_E2E__.SUPABASE_JWT_SECRET,
    });
    await request(app.getHttpServer()).get(`/documents/${docId}`).set("Authorization", authed(forgedAnonJwt)).expect(401);
  });

  it("400s a completely garbage bearer token", async () => {
    await request(app.getHttpServer()).get("/documents").set("Authorization", "Bearer not.a.jwt").expect(401);
  });

  it("list: q searches title (ilike), tag filters, limit/cursor paginate", async () => {
    const unique = `zz-search-probe-${Date.now()}`;
    const doc1 = await request(app.getHttpServer())
      .post("/documents")
      .set("Authorization", authed(userA.jwt))
      .send({ title: `${unique} first`, content: "x", tags: ["probe-tag"] })
      .expect(201);
    const doc2 = await request(app.getHttpServer())
      .post("/documents")
      .set("Authorization", authed(userA.jwt))
      .send({ title: `${unique} second`, content: "x" })
      .expect(201);
    // A literal `%` in the search term must be treated literally, not as
    // an ilike wildcard (documents.repository.ts's escapeIlike).
    const doc3 = await request(app.getHttpServer())
      .post("/documents")
      .set("Authorization", authed(userA.jwt))
      .send({ title: `${unique} 100% literal percent`, content: "x" })
      .expect(201);

    const byQuery = await request(app.getHttpServer())
      .get(`/documents?q=${encodeURIComponent(unique)}`)
      .set("Authorization", authed(userA.jwt))
      .expect(200);
    const idsByQuery: string[] = byQuery.body.items.map((d: { id: string }) => d.id);
    expect(idsByQuery.sort()).toEqual([doc1.body.id, doc2.body.id, doc3.body.id].sort());

    const literalPercentEscaped = await request(app.getHttpServer())
      .get(`/documents?q=${encodeURIComponent(`${unique} 100%`)}`)
      .set("Authorization", authed(userA.jwt))
      .expect(200);
    // Un-escaped, `100%` would ilike-match "100" followed by anything,
    // matching doc1/doc2 too via their shared `${unique}` prefix overlap
    // being irrelevant here — the real assertion is that it finds doc3
    // (the literal "100%" text) and nothing whose title lacks it.
    expect(literalPercentEscaped.body.items.map((d: { id: string }) => d.id)).toEqual([doc3.body.id]);

    const byTag = await request(app.getHttpServer())
      .get(`/documents?tag=probe-tag`)
      .set("Authorization", authed(userA.jwt))
      .expect(200);
    expect(byTag.body.items.some((d: { id: string }) => d.id === doc1.body.id)).toBe(true);
    expect(byTag.body.items.some((d: { id: string }) => d.id === doc2.body.id)).toBe(false);

    const firstPage = await request(app.getHttpServer())
      .get(`/documents?q=${encodeURIComponent(unique)}&limit=2`)
      .set("Authorization", authed(userA.jwt))
      .expect(200);
    expect(firstPage.body.items).toHaveLength(2);
    expect(firstPage.body.nextCursor).toBeTruthy();

    const secondPage = await request(app.getHttpServer())
      .get(`/documents?q=${encodeURIComponent(unique)}&limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`)
      .set("Authorization", authed(userA.jwt))
      .expect(200);
    expect(secondPage.body.items).toHaveLength(1);
    expect(secondPage.body.nextCursor).toBeNull();
    // Together, the two pages cover exactly the 3 seeded docs, no overlap.
    const pagedIds = [...firstPage.body.items, ...secondPage.body.items].map((d: { id: string }) => d.id);
    expect(pagedIds.sort()).toEqual([doc1.body.id, doc2.body.id, doc3.body.id].sort());
  });

  it("update: expectedUpdatedAt enables optimistic-concurrency conflict detection (D9.12)", async () => {
    const createRes = await request(app.getHttpServer())
      .post("/documents")
      .set("Authorization", authed(userA.jwt))
      .send({ title: "Concurrency probe", content: "v1" })
      .expect(201);
    const docId: string = createRes.body.id;
    const originalUpdatedAt: string = createRes.body.updatedAt;

    // A save that sends the CURRENT updatedAt as expectedUpdatedAt
    // succeeds normally, and comes back with a NEW updatedAt (the trigger
    // bumps it since content actually changed).
    const firstEditRes = await request(app.getHttpServer())
      .patch(`/documents/${docId}`)
      .set("Authorization", authed(userA.jwt))
      .send({ content: "v2 (tab A's edit)", expectedUpdatedAt: originalUpdatedAt })
      .expect(200);
    const afterFirstEditUpdatedAt: string = firstEditRes.body.updatedAt;
    expect(afterFirstEditUpdatedAt).not.toBe(originalUpdatedAt);

    // A second save that still believes the ORIGINAL (now-stale)
    // updatedAt is current — as if "tab B" had loaded the document before
    // tab A's edit landed, and only now tries to save its own,
    // independently-made edit — must be rejected with 409, not silently
    // overwrite tab A's already-saved edit (the lost-update this whole
    // feature exists to prevent).
    const conflictRes = await request(app.getHttpServer())
      .patch(`/documents/${docId}`)
      .set("Authorization", authed(userA.jwt))
      .send({ content: "v2 (tab B's conflicting edit)", expectedUpdatedAt: originalUpdatedAt })
      .expect(409);
    expect(conflictRes.body.code).toBe("conflict");

    // Tab A's edit really is still there — untouched by tab B's rejected
    // attempt.
    const afterConflictRes = await request(app.getHttpServer())
      .get(`/documents/${docId}`)
      .set("Authorization", authed(userA.jwt))
      .expect(200);
    expect(afterConflictRes.body.content).toBe("v2 (tab A's edit)");
    expect(afterConflictRes.body.updatedAt).toBe(afterFirstEditUpdatedAt);

    // Retrying with the NOW-current updatedAt succeeds.
    const retryRes = await request(app.getHttpServer())
      .patch(`/documents/${docId}`)
      .set("Authorization", authed(userA.jwt))
      .send({ content: "v3 (tab B's retry after reloading)", expectedUpdatedAt: afterFirstEditUpdatedAt })
      .expect(200);
    expect(retryRes.body.content).toBe("v3 (tab B's retry after reloading)");

    // Omitting expectedUpdatedAt entirely is still accepted — backward
    // compatible: an older client (or a script) that never fetched a
    // baseline keeps the previous last-write-wins behavior rather than
    // being forced to opt in.
    await request(app.getHttpServer())
      .patch(`/documents/${docId}`)
      .set("Authorization", authed(userA.jwt))
      .send({ tags: ["no-version-check"] })
      .expect(200);

    // A tags-only edit races just as easily as a content edit — the check
    // must apply unconditionally, not only when hashChanged (content_hash
    // deliberately excludes tags — see computeContentHash).
    const tagsRaceBaseline: string = (
      await request(app.getHttpServer()).get(`/documents/${docId}`).set("Authorization", authed(userA.jwt)).expect(200)
    ).body.updatedAt;
    await request(app.getHttpServer())
      .patch(`/documents/${docId}`)
      .set("Authorization", authed(userA.jwt))
      .send({ tags: ["fresh-tag"] })
      .expect(200); // bumps updated_at again, making tagsRaceBaseline stale
    const tagsConflictRes = await request(app.getHttpServer())
      .patch(`/documents/${docId}`)
      .set("Authorization", authed(userA.jwt))
      .send({ tags: ["stale-tag-only-edit"], expectedUpdatedAt: tagsRaceBaseline })
      .expect(409);
    expect(tagsConflictRes.body.code).toBe("conflict");
  });

  it("update: 404 (not 409) for a nonexistent document even when expectedUpdatedAt is sent", async () => {
    await request(app.getHttpServer())
      .patch("/documents/00000000-0000-0000-0000-000000000000")
      .set("Authorization", authed(userA.jwt))
      .send({ title: "hijacked", expectedUpdatedAt: new Date().toISOString() })
      .expect(404);
  });

  it("reindex: 409 on a document that isn't in a failed state, 404 on a nonexistent one", async () => {
    const createRes = await request(app.getHttpServer())
      .post("/documents")
      .set("Authorization", authed(userA.jwt))
      .send({ title: "Reindex target", content: "x" })
      .expect(201);
    // Freshly created docs are 'pending', not 'failed' — reindex should
    // refuse (it's for retrying a *failed* index, not re-triggering one
    // that's already in flight/queued).
    const conflictRes = await request(app.getHttpServer())
      .post(`/documents/${createRes.body.id}/reindex`)
      .set("Authorization", authed(userA.jwt))
      .expect(409);
    expect(conflictRes.body.code).toBe("conflict");

    await request(app.getHttpServer())
      .post(`/documents/00000000-0000-0000-0000-000000000000/reindex`)
      .set("Authorization", authed(userA.jwt))
      .expect(404);

    // User B can't reindex user A's document (RLS) — same 404-not-403
    // shape as every other cross-user case.
    await request(app.getHttpServer())
      .post(`/documents/${createRes.body.id}/reindex`)
      .set("Authorization", authed(userB.jwt))
      .expect(404);
  });
});
