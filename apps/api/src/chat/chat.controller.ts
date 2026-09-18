import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  ChatRequestSchema,
  ConversationListQuerySchema,
  ConversationRenameSchema,
  ChatEventSchema,
  type ChatEvent,
  type ChatResponse,
  type ConversationDetail,
  type ConversationListResponse,
  type ConversationSummary,
} from "@kb/shared";
import type { Response } from "express";
import { z } from "zod";

import { CurrentAuth } from "../auth/current-auth.decorator.js";
import type { AuthContext } from "../auth/auth-request.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
// ChatService must stay a value import (constructor-injected) — see
// docs/DECISIONS.md Phase 3, D3.3.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ChatService } from "./chat.service.js";

const UuidParam = new ZodValidationPipe(z.string().uuid("must be a valid conversation id"));

/** Server -> browser heartbeat, sent as an SSE comment (ignored by EventSource/fetch readers) so idle proxies/load balancers don't time out a long-running stream. */
const HEARTBEAT_INTERVAL_MS = 15_000;

function writeEvent(res: Response, event: ChatEvent): void {
  // Validated against the shared contract before it ever reaches the wire
  // (see chat-events.ts's doc comment) — a bug that would otherwise silently
  // send a malformed event to the browser fails loudly server-side instead.
  const validated = ChatEventSchema.parse(event);
  res.write(`data: ${JSON.stringify(validated)}\n\n`);
}

@Controller()
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  /**
   * SSE stream: `start` -> `sources` -> (`delta` | `citation`)* -> `done`,
   * or `error` in place of `done` if the turn fails outright before any
   * partial answer could be persisted (see chat.service.ts's persistError).
   * Headers go out immediately so proxies start forwarding bytes right
   * away rather than buffering the whole response.
   */
  @Post("chat/stream")
  @Throttle({ chat: {} })
  @HttpCode(HttpStatus.OK)
  async stream(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(ChatRequestSchema)) body: z.infer<typeof ChatRequestSchema>,
    @Res() res: Response,
  ): Promise<void> {
    res.writeHead(HttpStatus.OK, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const controller = new AbortController();
    // res.on("close") (the ServerResponse's own lifecycle), not
    // req.on("close") (the IncomingMessage's) — on this stack (Express 5 /
    // Node 22, see docs/DECISIONS.md Phase 5) a client disconnecting
    // mid-stream fires the response's close event, not the request's;
    // req.on("close") was observed to never fire here even on a hard
    // client-side socket destroy.
    res.on("close", () => controller.abort());

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, HEARTBEAT_INTERVAL_MS);

    try {
      await this.chatService.runTurn(auth.db, body, {
        onEvent: (event) => writeEvent(res, event),
        signal: controller.signal,
      });
    } catch (error) {
      // Only reachable for a failure before any event was emitted (e.g. an
      // unknown conversationId) — everything after `start` is caught and
      // turned into a normal `error` event inside chat.service.ts itself,
      // since by then the response is already committed to SSE and can no
      // longer fall back to a JSON error via HttpExceptionFilter.
      const message = error instanceof Error ? error.message : "Something went wrong starting the chat turn.";
      writeEvent(res, { type: "error", code: "chat_start_failed", message });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }

  /** The brief's non-streaming equivalent — same orchestration, collected into one JSON body instead of an event stream. Errors flow through the normal HttpExceptionFilter since nothing has been written to the response yet. */
  @Post("chat")
  @Throttle({ chat: {} })
  async chat(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(ChatRequestSchema)) body: z.infer<typeof ChatRequestSchema>,
  ): Promise<ChatResponse> {
    const result = await this.chatService.runTurn(auth.db, body);
    return {
      conversationId: result.conversationId,
      userMessage: result.userMessage,
      assistantMessage: result.assistantMessage,
      sources: result.sources,
    };
  }

  @Get("conversations")
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(ConversationListQuerySchema)) query: z.infer<typeof ConversationListQuerySchema>,
  ): Promise<ConversationListResponse> {
    return this.chatService.listConversations(auth.db, query);
  }

  @Get("conversations/:id")
  async getById(@CurrentAuth() auth: AuthContext, @Param("id", UuidParam) id: string): Promise<ConversationDetail> {
    return this.chatService.getConversation(auth.db, id);
  }

  @Patch("conversations/:id")
  async rename(
    @CurrentAuth() auth: AuthContext,
    @Param("id", UuidParam) id: string,
    @Body(new ZodValidationPipe(ConversationRenameSchema)) body: z.infer<typeof ConversationRenameSchema>,
  ): Promise<ConversationSummary> {
    return this.chatService.renameConversation(auth.db, id, body.title);
  }

  @Delete("conversations/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentAuth() auth: AuthContext, @Param("id", UuidParam) id: string): Promise<void> {
    await this.chatService.deleteConversation(auth.db, id);
  }
}
