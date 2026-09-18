import { Module } from "@nestjs/common";

import { IndexingQueue } from "./indexing.queue.js";
import { IndexingRepository } from "./indexing.repository.js";
import { IndexingService } from "./indexing.service.js";

@Module({
  providers: [IndexingQueue, IndexingRepository, IndexingService],
  exports: [IndexingQueue],
})
export class IndexingModule {}
