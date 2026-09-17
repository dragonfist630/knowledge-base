import type { MiddlewareConsumer, NestModule } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { LoggerModule } from "nestjs-pino";

import { AiModule } from "./ai/ai.module.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { AuthModule } from "./auth/auth.module.js";
import { HttpExceptionFilter } from "./common/http-exception.filter.js";
import { RequestIdMiddleware } from "./common/request-id.middleware.js";
import { UserThrottlerGuard } from "./common/user-throttler.guard.js";
import { API_ENV, ConfigModule } from "./config/config.module.js";
import type { ApiEnv } from "./config/env.js";
import { DocumentsModule } from "./documents/documents.module.js";
import { IndexingModule } from "./indexing/indexing.module.js";
import { MetaModule } from "./meta/meta.module.js";

// Feature modules (retrieval, chat, usage) are added here phase by phase,
// starting in Phase 5.
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => ({
        pinoHttp: {
          level: env.NODE_ENV === "production" ? "info" : "debug",
          autoLogging: { ignore: (req) => req.url === "/health" },
          transport: env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => [
        { name: "default", ttl: env.THROTTLE_DEFAULT_TTL_MS, limit: env.THROTTLE_DEFAULT_LIMIT },
        // Not applied to any route until Phase 5 adds POST /chat/stream —
        // registered here so that controller only needs @Throttle({ chat: {} }).
        { name: "chat", ttl: env.THROTTLE_CHAT_TTL_MS, limit: env.THROTTLE_CHAT_LIMIT },
      ],
    }),
    AuthModule,
    AiModule,
    IndexingModule,
    DocumentsModule,
    MetaModule,
  ],
  providers: [
    // Order matters: AuthGuard must populate req.auth before
    // UserThrottlerGuard reads it (see auth.module.ts). Multiple APP_GUARD
    // providers only have a guaranteed order when declared together, in
    // order, in one module's `providers` array.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every request gets a request ID before it reaches any guard, filter,
    // or handler, so the exception filter can always attach one.
    consumer.apply(RequestIdMiddleware).forRoutes("*");
  }
}
