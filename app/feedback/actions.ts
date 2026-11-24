"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "../../lib/supabase/server";

type FeedbackKind = "like" | "not_interested" | "seen";
type FeedbackVia = "button" | "swipe";

const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const feedbackKinds = new Set<FeedbackKind>(["like", "not_interested", "seen"]);
const feedbackVias = new Set<FeedbackVia>(["button", "swipe"]);

type SourceActionResult =
  | { ok: true; sourceId: string; sourceName?: string }
  | { ok: false; error: "not_found" | "save_failed" };

function validateUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new Error(`Invalid ${label} ID.`);
  }
}

function validateItemId(itemId: unknown): asserts itemId is string {
  validateUuid(itemId, "item");
}

function validateFeedback(kind: unknown, via: unknown): asserts kind is FeedbackKind {
  if (typeof kind !== "string" || !feedbackKinds.has(kind as FeedbackKind)) {
    throw new Error("Invalid feedback kind.");
  }
  if (typeof via !== "string" || !feedbackVias.has(via as FeedbackVia)) {
    throw new Error("Invalid feedback source.");
  }
}

async function getVerifiedUser(): Promise<{
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
}> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (error || typeof userId !== "string" || userId.length === 0) {
    throw new Error("Authentication required.");
  }
  return { supabase, userId };
}

export async function setFeedback(
  itemId: string,
  kind: FeedbackKind,
  via: FeedbackVia,
): Promise<void> {
  validateItemId(itemId);
  validateFeedback(kind, via);

  const { supabase } = await getVerifiedUser();
  const { error } = await supabase.rpc("set_feedback", {
    p_item_id: itemId,
    p_kind: kind,
    p_via: via,
  });
  if (error) throw new Error("Could not save feedback.");
  revalidatePath("/liked");
}

export async function clearFeedback(itemId: string): Promise<void> {
  validateItemId(itemId);

  const { supabase, userId } = await getVerifiedUser();
  const { error } = await supabase
    .from("feedback")
    .delete()
    .eq("user_id", userId)
    .eq("item_id", itemId);
  if (error) throw new Error("Could not clear feedback.");
  revalidatePath("/liked");
}

export async function hideSource(itemId: unknown): Promise<SourceActionResult> {
  validateItemId(itemId);
  const { supabase } = await getVerifiedUser();
  const { data, error } = await supabase.rpc("hide_source_of_item", { p_item_id: itemId });
  if (error) return { ok: false, error: "save_failed" };
  const source = Array.isArray(data) ? data[0] : null;
  if (
    typeof source !== "object" ||
    source === null ||
    typeof source.source_id !== "string" ||
    typeof source.source_name !== "string"
  ) {
    return { ok: false, error: "save_failed" };
  }
  revalidatePath("/preferences");
  return { ok: true, sourceId: source.source_id, sourceName: source.source_name };
}

export async function showSource(sourceId: unknown): Promise<SourceActionResult> {
  validateUuid(sourceId, "source");
  const { supabase, userId } = await getVerifiedUser();
  const { data, error } = await supabase
    .from("hidden_sources")
    .delete()
    .eq("user_id", userId)
    .eq("source_id", sourceId)
    .select("source_id");
  if (error) return { ok: false, error: "save_failed" };
  if (!Array.isArray(data) || data.length === 0) return { ok: false, error: "not_found" };
  revalidatePath("/preferences");
  return { ok: true, sourceId };
}
