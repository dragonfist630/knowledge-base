import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
import { NestFactory } from "@nestjs/core";

// A single root .env is shared by every app in the monorepo (see
// scripts/setup.mjs). Load it before anything else touches process.env.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, "../../../.env") });

const { AppModule } = await import("./app.module.js");

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.info(`[api] listening on http://localhost:${port}`);
}

await bootstrap();
