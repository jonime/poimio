import type { SupabaseClient } from "@supabase/supabase-js";

export async function getSourceDiscoveryAdminUserId(
  client: SupabaseClient,
): Promise<string | null> {
  try {
    const { data, error } = await client.auth.getClaims();
    const userId = data?.claims?.sub;
    if (error || typeof userId !== "string" || userId.length === 0) return null;

    if (!(await isSourceDiscoveryAdmin(client))) return null;

    return userId;
  } catch (error) {
    console.error("source_discovery_admin_check_failed", error);
    return null;
  }
}

export async function isSourceDiscoveryAdmin(client: SupabaseClient): Promise<boolean> {
  try {
    const { data, error } = await client.rpc("is_admin");
    return !error && data === true;
  } catch (error) {
    console.error("source_discovery_admin_check_failed", error);
    return false;
  }
}
