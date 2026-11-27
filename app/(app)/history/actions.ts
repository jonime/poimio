"use server";

import type { HistoryFeedItem } from "@/lib/feed-ui";
import { createClient } from "@/lib/supabase/server";

const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const pageSize = 20;

export async function loadMoreHistory(
  beforeAt: string,
  beforeId: string,
): Promise<{ items: HistoryFeedItem[]; hasMore: boolean }> {
  if (
    typeof beforeAt !== "string" ||
    beforeAt.length === 0 ||
    !Number.isFinite(Date.parse(beforeAt)) ||
    !uuidPattern.test(beforeId)
  ) {
    throw new Error("Invalid history cursor.");
  }

  const supabase = await createClient();
  const { data: claims, error: claimsError } = await supabase.auth.getClaims();
  if (claimsError || typeof claims?.claims?.sub !== "string") {
    throw new Error("Authentication required.");
  }

  const { data, error } = await supabase.rpc("get_history", {
    p_limit: pageSize + 1,
    p_before_at: beforeAt,
    p_before_id: beforeId,
  });
  if (error) throw new Error("Could not load more history.");
  const rows = (data ?? []) as HistoryFeedItem[];
  return { items: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
}
