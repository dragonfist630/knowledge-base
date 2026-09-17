import { randomUUID } from "node:crypto";

import type { NextFunction, Request, Response } from "express";
import { Injectable, type NestMiddleware } from "@nestjs/common";

export interface RequestWithId extends Request {
  id: string;
}

/**
 * Every response — success or error — carries the same request ID, so a
 * user reporting "I got this error" can be traced to one log line. Accepts
 * an inbound X-Request-Id (useful behind a proxy/load balancer that already
 * assigns one) rather than always minting a fresh one.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.headers["x-request-id"];
    const id = (typeof inbound === "string" && inbound.trim().length > 0 ? inbound : randomUUID());
    (req as RequestWithId).id = id;
    res.setHeader("x-request-id", id);
    next();
  }
}
