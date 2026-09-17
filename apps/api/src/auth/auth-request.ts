import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@kb/shared";

import type { RequestWithId } from "../common/request-id.middleware.js";

export interface AuthContext {
  userId: string;
  email: string | undefined;
  /** A Supabase client scoped to this request's user — every query it runs is under RLS. */
  db: SupabaseClient<Database>;
  /** The raw bearer token — carried into IndexingJob.userJwt so a later worker can act as this user. */
  jwt: string;
}

export interface AuthedRequest extends RequestWithId {
  auth: AuthContext;
}
