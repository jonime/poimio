"use client";

import { createBrowserClient } from "@supabase/ssr";
import { requireDefined } from "../required.ts";

export function createClient() {
  return createBrowserClient(
    requireDefined(process.env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"),
    requireDefined(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, "NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  );
}
