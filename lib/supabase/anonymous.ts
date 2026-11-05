import "server-only";
import { createClient } from "@supabase/supabase-js";
import { requireDefined } from "../required.ts";

/** Public metadata only; never reuse a request/session client here. */
export function createAnonymousClient() {
  return createClient(
    requireDefined(process.env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"),
    requireDefined(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, "NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  );
}
