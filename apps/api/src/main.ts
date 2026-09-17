import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import { Logger } from "nestjs-pino";

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
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.enableCors({ origin: env.WEB_ORIGIN, credentials: true });
  app.enableShutdownHooks();

  await app.listen(env.PORT);
  app.get(Logger).log(`listening on http://localhost:${env.PORT}`, "Bootstrap");
}

await bootstrap();
