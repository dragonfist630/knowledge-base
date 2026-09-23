import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import { Logger } from "nestjs-pino";

import { bodyParserErrorMiddleware } from "./common/body-parser-error.middleware.js";

// A single root .env is shared by every app in the monorepo (see
// scripts/setup.mjs). Load it before anything else touches process.env.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, "../../../.env") });

// Validated here, before AppModule (and therefore ConfigModule) is even
// imported, so a bad config fails with one readable message instead of an
// opaque Nest DI stack trace — see config/env.ts and docs/DECISIONS.md
// ("Config is environment, validated at boot").
const { loadApiEnv } = await import("./config/env.js");
const env = loadApiEnv();

const { AppModule } = await import("./app.module.js");

async function bootstrap(): Promise<void> {
  // `bodyParser: false` skips Nest's own automatic body-parser
  // registration (which uses Express's undocumented default limit —
  // 100kb — regardless of what's documented as a request's own maximum),
  // so we can register json/urlencoded ourselves with a limit that
  // actually fits packages/shared's documented content maximum
  // (CONTENT_MAX = 500,000 characters). 2mb comfortably covers that even
  // accounting for JSON string-escaping overhead, `title`/`tags`, and
  // normal request-shape padding, while still bounding an unbounded body.
  // See docs/DECISIONS.md.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, bodyParser: false });

  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.enableCors({ origin: env.WEB_ORIGIN, credentials: true });
  app.useBodyParser("json", { limit: "2mb" });
  app.useBodyParser("urlencoded", { extended: true, limit: "2mb" });
  // Must come immediately after the parsers above — see its own doc
  // comment for why that ordering is load-bearing.
  app.use(bodyParserErrorMiddleware);
  app.enableShutdownHooks();

  await app.listen(env.PORT);
  app.get(Logger).log(`listening on http://localhost:${env.PORT}`, "Bootstrap");
}

await bootstrap();
