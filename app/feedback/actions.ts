"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "../../lib/supabase/server";

type FeedbackKind = "like" | "not_interested" | "seen";
type FeedbackVia = "button" | "swipe";

const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const feedbackKinds = new Set<FeedbackKind>(["like", "not_interested", "seen"]);
const feedbackVias = new Set<FeedbackVia>(["button", "swipe"]);

function validateItemId(itemId: unknown): asserts itemId is string {
  if (typeof itemId !== "string" || !uuidPattern.test(itemId)) {
    throw new Error("Invalid item ID.");
  }
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
