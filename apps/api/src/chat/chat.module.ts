import { Module } from "@nestjs/common";

import { RetrievalModule } from "../retrieval/retrieval.module.js";
import { ChatController } from "./chat.controller.js";
import { ChatService } from "./chat.service.js";
import { ConversationsRepository } from "./conversations.repository.js";

@Module({
  // RetrievalModule already exports UsageRepository (see retrieval.module.ts)
  // alongside RetrievalService, so ChatService gets both from this one import.
  imports: [RetrievalModule],
  controllers: [ChatController],
  providers: [ChatService, ConversationsRepository],
})
export class ChatModule {}
