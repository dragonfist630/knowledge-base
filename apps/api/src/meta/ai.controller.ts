import { Controller, Get, Inject } from "@nestjs/common";
import type { Ai } from "@kb/ai";

import { AI } from "../ai/ai.module.js";
import { Public } from "../auth/public.decorator.js";

/**
 * Public — the frontend's provider badge ("chat: openai/gpt-4.1-mini")
 * needs this before the user is signed in, and it never returns anything
 * secret: Ai.describe() already masks API keys (see @kb/ai/create-ai.ts).
 */
@Controller("meta")
export class AiMetaController {
  constructor(@Inject(AI) private readonly ai: Ai) {}

  @Public()
  @Get("ai")
  describe(): ReturnType<Ai["describe"]> {
    return this.ai.describe();
  }
}
