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
} from "@nestjs/common";
import {
  DocumentCreateSchema,
  DocumentListQuerySchema,
  DocumentUpdateSchema,
  type DocumentDetail,
  type DocumentListResponse,
} from "@kb/shared";
import { z } from "zod";

import { CurrentAuth } from "../auth/current-auth.decorator.js";
import type { AuthContext } from "../auth/auth-request.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
// Must stay a value import (constructor-injected) — see docs/DECISIONS.md
// Phase 3, D3.3.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { DocumentsService } from "./documents.service.js";

const UuidParam = new ZodValidationPipe(z.string().uuid("must be a valid document id"));

@Controller("documents")
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(DocumentListQuerySchema)) query: z.infer<typeof DocumentListQuerySchema>,
  ): Promise<DocumentListResponse> {
    return this.documentsService.list(auth, query);
  }

  @Get(":id")
  async getById(@CurrentAuth() auth: AuthContext, @Param("id", UuidParam) id: string): Promise<DocumentDetail> {
    return this.documentsService.getById(auth, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(DocumentCreateSchema)) body: z.infer<typeof DocumentCreateSchema>,
  ): Promise<DocumentDetail> {
    return this.documentsService.create(auth, body);
  }

  @Patch(":id")
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param("id", UuidParam) id: string,
    @Body(new ZodValidationPipe(DocumentUpdateSchema)) body: z.infer<typeof DocumentUpdateSchema>,
  ): Promise<DocumentDetail> {
    return this.documentsService.update(auth, id, body);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentAuth() auth: AuthContext, @Param("id", UuidParam) id: string): Promise<void> {
    await this.documentsService.remove(auth, id);
  }

  @Post(":id/reindex")
  async reindex(@CurrentAuth() auth: AuthContext, @Param("id", UuidParam) id: string): Promise<DocumentDetail> {
    return this.documentsService.reindex(auth, id);
  }
}
