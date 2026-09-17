import { Module } from "@nestjs/common";

import { IndexingQueue } from "./indexing.queue.js";

@Module({
  providers: [IndexingQueue],
  exports: [IndexingQueue],
})
export class IndexingModule {}
