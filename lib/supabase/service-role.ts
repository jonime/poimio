import "server-only";
import { createClient } from "@supabase/supabase-js";
import { requireDefined } from "../required.ts";

/** Service-role client for server-side writes. Never import this from a client component. */
export function createServiceRoleClient() {
  return createClient(
    requireDefined(process.env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"),
    requireDefined(process.env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    },
  );
}
