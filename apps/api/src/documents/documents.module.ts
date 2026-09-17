import { Module } from "@nestjs/common";

import { IndexingModule } from "../indexing/indexing.module.js";
import { DocumentsController } from "./documents.controller.js";
import { DocumentsRepository } from "./documents.repository.js";
import { DocumentsService } from "./documents.service.js";

@Module({
  imports: [IndexingModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentsRepository],
})
export class DocumentsModule {}
