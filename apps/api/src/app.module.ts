import { Module } from "@nestjs/common";

import { MetaModule } from "./meta/meta.module.js";

// Feature modules (auth, documents, indexing, retrieval, chat, usage) are
// added here phase by phase, starting in Phase 3.
@Module({
  imports: [MetaModule],
})
export class AppModule {}
