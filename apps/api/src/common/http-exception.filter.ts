import type { ArgumentsHost, ExceptionFilter} from "@nestjs/common";
import { Catch, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Response } from "express";
import { isAiError } from "@kb/ai";
import { ZodError } from "zod";

import type { RequestWithId } from "./request-id.middleware.js";

interface PostgrestLikeError {
  code: string;
  message: string;
  details?: string | null;
  hint?: string | null;
}

function isPostgrestLikeError(error: unknown): error is PostgrestLikeError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  );
}

/** Postgres/PostgREST error code -> HTTP status. See docs/DECISIONS.md Phase 3. */
const POSTGRES_CODE_STATUS: Record<string, number> = {
  P0002: HttpStatus.NOT_FOUND, // raise_exception(..., errcode = 'P0002') — e.g. replace_document_chunks's "document not found"
  "23505": HttpStatus.CONFLICT, // unique_violation
  "42501": HttpStatus.FORBIDDEN, // insufficient_privilege — RLS blocked the row
  PGRST116: HttpStatus.NOT_FOUND, // PostgREST: .single()/.maybeSingle() found 0 or >1 rows
};

/** AiError.code -> HTTP status. Only these three are used, per the brief. */
function aiErrorStatus(code: string): number {
  if (code === "rate_limit") return HttpStatus.TOO_MANY_REQUESTS;
  if (code === "timeout") return HttpStatus.GATEWAY_TIMEOUT;
  return HttpStatus.BAD_GATEWAY;
}

interface ErrorBody {
  requestId: string;
  code: string;
  message: string;
  fieldErrors?: { path: string; message: string }[];
}

/**
 * The single place every thrown error in apps/api becomes an HTTP response.
 * Every branch below ends in the same JSON shape (packages/shared's
 * ApiErrorResponse) so apps/web never has to guess which kind of failure it
 * got. Order matters: ZodError and AiError are checked before the generic
 * Postgres/HttpException/unknown fallbacks because both are also plain
 * `Error` subclasses that would otherwise fall through.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithId>();
    const requestId = request.id ?? "unknown";

    const { status, body } = this.resolve(exception, requestId);

    if (status >= 500) {
      this.logger.error(`[${requestId}] ${body.code}: ${body.message}`, exception instanceof Error ? exception.stack : undefined);
    } else {
      this.logger.warn(`[${requestId}] ${status} ${body.code}: ${body.message}`);
    }

    response.status(status).json(body);
  }

  private resolve(exception: unknown, requestId: string): { status: number; body: ErrorBody } {
    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {
          requestId,
          code: "validation_error",
          message: "Request validation failed.",
          fieldErrors: exception.issues.map((issue) => ({
            path: issue.path.join(".") || "(root)",
            message: issue.message,
          })),
        },
      };
    }

    if (isAiError(exception)) {
      return {
        status: aiErrorStatus(exception.code),
        body: {
          requestId,
          code: `ai_${exception.code}`,
          message: this.friendlyAiMessage(exception.code),
        },
      };
    }

    if (isPostgrestLikeError(exception) && exception.code in POSTGRES_CODE_STATUS) {
      return {
        status: POSTGRES_CODE_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR,
        body: {
          requestId,
          code: `db_${exception.code}`,
          message: this.friendlyDbMessage(exception.code),
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === "string" ? payload : ((payload as { message?: string }).message ?? exception.message);
      return {
        status,
        body: { requestId, code: this.codeForStatus(status), message },
      };
    }

    // Truly unexpected — never leak the raw message (may contain internals).
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { requestId, code: "internal_error", message: "Something went wrong. Try again." },
    };
  }

  private friendlyAiMessage(code: string): string {
    switch (code) {
      case "rate_limit":
        return "The AI provider is rate-limiting requests right now. Try again shortly.";
      case "timeout":
        return "The AI provider took too long to respond.";
      case "unavailable":
        return "The AI provider is temporarily unavailable.";
      case "auth":
        return "The AI provider rejected our credentials.";
      case "config":
        return "The AI provider is misconfigured.";
      default:
        return "The AI provider returned an unexpected response.";
    }
  }

  private friendlyDbMessage(code: string): string {
    switch (code) {
      case "P0002":
        return "The requested resource was not found.";
      case "23505":
        return "That already exists.";
      case "42501":
        return "You don't have permission to do that.";
      case "PGRST116":
        return "The requested resource was not found.";
      default:
        return "A database error occurred.";
    }
  }

  private codeForStatus(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return "bad_request";
      case HttpStatus.UNAUTHORIZED:
        return "unauthorized";
      case HttpStatus.FORBIDDEN:
        return "forbidden";
      case HttpStatus.NOT_FOUND:
        return "not_found";
      case HttpStatus.CONFLICT:
        return "conflict";
      case HttpStatus.TOO_MANY_REQUESTS:
        return "rate_limited";
      default:
        return "error";
    }
  }
}
