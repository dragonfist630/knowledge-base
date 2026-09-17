import { Global, Module } from "@nestjs/common";

import { loadApiEnv } from "./env.js";
import type { ApiEnv } from "./env.js";

export const API_ENV = Symbol("API_ENV");

/**
 * Global so every feature module can `@Inject(API_ENV) private env: ApiEnv`
 * without re-importing this module everywhere. main.ts already calls
 * loadApiEnv() once before NestFactory.create, so a bad config fails before
 * any module even starts initializing; this factory re-parses the same,
 * already-known-good process.env into a typed, injectable object for DI.
 */
@Global()
@Module({
  providers: [{ provide: API_ENV, useFactory: (): ApiEnv => loadApiEnv() }],
  exports: [API_ENV],
})
export class ConfigModule {}
