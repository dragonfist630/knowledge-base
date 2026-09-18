import { Module } from "@nestjs/common";

import { UsageRepository } from "../common/usage.repository.js";
import { RetrievalRepository } from "./retrieval.repository.js";
import { RetrievalService } from "./retrieval.service.js";

// UsageRepository is provided (and exported) here rather than its own
// one-line module: retrieval is its first consumer, and ChatModule (Phase
// 5's other consumer, for the 'chat' completion usage event) already needs
// to import RetrievalModule for RetrievalService anyway — see chat.module.ts.
@Module({
  providers: [RetrievalRepository, RetrievalService, UsageRepository],
  exports: [RetrievalService, UsageRepository],
})
export class RetrievalModule {}
