import { Injectable } from "@nestjs/common";
import type { Database, UsageDayRow } from "@kb/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Thin wrapper over the `usage_summary` RPC (supabase/migrations, "RPC 3
 * (optional): usage summary for the usage page") — grouped (day, operation,
 * model) token sums for the caller's own `ai_usage_events` rows. Like every
 * other repository in this app, this takes the caller's request-scoped
 * client: `usage_summary` is `security invoker` and filters on
 * `auth.uid()` itself, so there's no user_id param to pass and no RLS
 * bypass risk here (see docs/DECISIONS.md).
 */
@Injectable()
export class UsageRepository {
  async summarize(db: SupabaseClient<Database>, from: Date): Promise<UsageDayRow[]> {
    const { data, error } = await db.rpc("usage_summary", { p_from: from.toISOString() });
    if (error) throw error;
    return (data ?? []).map((row) => ({
      day: row.day,
      operation: row.operation as UsageDayRow["operation"],
      model: row.model,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
      eventCount: row.event_count,
    }));
  }
}
