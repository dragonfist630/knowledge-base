import type { MiddlewareConsumer, NestModule } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { LoggerModule } from "nestjs-pino";

import { AiModule } from "./ai/ai.module.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { AuthModule } from "./auth/auth.module.js";
import { ChatModule } from "./chat/chat.module.js";
import { HttpExceptionFilter } from "./common/http-exception.filter.js";
import { PreAuthThrottlerGuard } from "./common/preauth-throttler.guard.js";
import { RequestIdMiddleware } from "./common/request-id.middleware.js";
import { UserThrottlerGuard } from "./common/user-throttler.guard.js";
import { API_ENV, ConfigModule } from "./config/config.module.js";
import type { ApiEnv } from "./config/env.js";
import { DocumentsModule } from "./documents/documents.module.js";
import { IndexingModule } from "./indexing/indexing.module.js";
import { MetaModule } from "./meta/meta.module.js";
import { RetrievalModule } from "./retrieval/retrieval.module.js";
import { UsageModule } from "./usage/usage.module.js";

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
          // Without this, pino-http's default `req` serializer logs the
          // ENTIRE headers object verbatim on every request — including
          // the caller's live Supabase JWT in `authorization`. Confirmed
          // by reading the installed pino-std-serializers source
          // (reqSerializer does `_req.headers = req.headers`, no
          // filtering) — every authenticated request would otherwise
          // write a replayable bearer token to whatever log sink is
          // configured, undermining the entire "no service-role client,
          // everything scoped to the caller's own JWT" model one layer up
          // from the DB/auth code that actually enforces it. See
          // docs/DECISIONS.md.
          redact: {
            paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"],
            censor: "[redacted]",
          },
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => [
        { name: "default", ttl: env.THROTTLE_DEFAULT_TTL_MS, limit: env.THROTTLE_DEFAULT_LIMIT },
        // Applied to POST /chat and /chat/stream via @Throttle({ chat: {} })
        // (see chat.controller.ts) — registered here since named throttlers
        // must be declared at the module root, not per-controller.
        { name: "chat", ttl: env.THROTTLE_CHAT_TTL_MS, limit: env.THROTTLE_CHAT_LIMIT },
        // Checked by PreAuthThrottlerGuard only (see its own doc comment)
        // — a per-IP ceiling that runs before AuthGuard, so an
        // unauthenticated flood can't skip rate limiting entirely just by
        // never presenting a valid token.
        { name: "preauth", ttl: env.THROTTLE_PREAUTH_TTL_MS, limit: env.THROTTLE_PREAUTH_LIMIT },
      ],
    }),
    AuthModule,
    AiModule,
    IndexingModule,
    DocumentsModule,
    RetrievalModule,
    ChatModule,
    MetaModule,
    UsageModule,
  ],
  providers: [
    // Order matters, and multiple APP_GUARD providers only have a
    // guaranteed order when declared together, in order, in one module's
    // `providers` array:
    //  1. PreAuthThrottlerGuard runs first, by IP, before auth is even
    //     checked — see its own doc comment for why a guard that runs
    //     later can't cover this case.
    //  2. AuthGuard populates req.auth.
    //  3. UserThrottlerGuard reads req.auth (must run after AuthGuard).
    { provide: APP_GUARD, useClass: PreAuthThrottlerGuard },
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
