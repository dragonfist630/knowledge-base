import { Injectable, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";

/**
 * Validates (and transforms — trims, lowercases tags, applies defaults) a
 * single param/body/query against a zod schema. Left as a plain ZodError on
 * failure rather than caught here: http-exception.filter.ts is the single
 * place that turns a ZodError into the shared 400 + fieldErrors shape, so
 * every validation failure in the app — pipe or manual `.parse()` deeper in
 * a service — looks identical to the client.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    return this.schema.parse(value);
  }
}
