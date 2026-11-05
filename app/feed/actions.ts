"use server";

import type { FeedItem } from "../../lib/feed-ui";
import { createClient } from "../../lib/supabase/server";

const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const pageSize = 30;
const maximumItems = 1000;

export async function loadMoreFeed(excludeIds: string[]): Promise<FeedItem[]> {
  if (
    !Array.isArray(excludeIds) ||
    excludeIds.length > maximumItems ||
    excludeIds.some((id) => typeof id !== "string" || !uuidPattern.test(id))
  ) {
    throw new Error("Invalid feed exclusions.");
  }

  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  if (claimsError || typeof claimsData?.claims?.sub !== "string") {
    throw new Error("Authentication required.");
  }

  const requestedLimit = Math.min(pageSize, maximumItems - excludeIds.length);
  if (requestedLimit === 0) return [];

  const { data, error } = await supabase.rpc("get_feed", {
    p_limit: requestedLimit,
    p_exclude: excludeIds,
  });
  if (error) throw new Error("Could not load more feed items.");
  return (data ?? []) as FeedItem[];
}
