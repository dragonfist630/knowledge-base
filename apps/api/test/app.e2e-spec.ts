import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";

// `supertest@7` ships no bundled types, and `@types/supertest@6` doesn't
// expose a `supertest/types` subpath (the Nest 12 e2e template assumes one
// that doesn't exist for this version pair — see docs/DECISIONS.md). Nest's
// own `INestApplication<TServer = any>` default covers us without it.
describe("AppModule (e2e)", () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it("GET /health -> { status: 'ok' }", () => {
    return request(app.getHttpServer())
      .get("/health")
      .expect(200)
      .expect({ status: "ok" });
  });

  afterEach(async () => {
    await app.close();
  });
});
