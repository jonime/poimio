import { CircleAlertIcon } from "lucide-react";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  INTEREST_SUMMARY_DAILY_LIMIT,
  type InterestSummary,
} from "@/lib/interest-summary-contract";
import { PREFERENCE_DAILY_LIMIT } from "@/lib/preference-tuning";
import { createClient } from "@/lib/supabase/server";
import { InterestSummaryCard } from "../interest-summary-card";
import { type PreferenceListItem, PreferencesForm } from "../preferences-form";

export const instant = true;

interface PreferenceRow {
  id: string;
  label: string;
  direction: string;
}

export default function TuneFeedPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <h1 id="tune-feed-heading" className="text-2xl font-semibold tracking-tight">
        Tune feed
      </h1>
      <Suspense
        fallback={
          <div className="flex flex-col gap-4" aria-busy="true">
            <p role="status" className="sr-only">
              Loading preferences...
            </p>
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        }
      >
        <PreferencesContent />
      </Suspense>
    </main>
  );
}

async function PreferencesContent() {
  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  if (claimsError || !claimsData?.claims?.sub) redirect("/login");

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [
    preferencesResult,
    preferenceUsageResult,
    summaryResult,
    summaryUsageResult,
    likeCountResult,
  ] = await Promise.all([
    supabase
      .from("feed_preferences")
      .select("id,label,direction")
      .order("created_at", { ascending: false }),
    supabase
      .from("llm_usage")
      .select("id", { count: "exact", head: true })
      .eq("kind", "preferences")
      .gte("created_at", since),
    supabase
      .from("interest_summaries")
      .select("summary,topics,like_count,generated_at")
      .maybeSingle(),
    supabase
      .from("llm_usage")
      .select("id", { count: "exact", head: true })
      .eq("kind", "interest_summary")
      .gte("created_at", since),
    supabase.from("feedback").select("item_id", { count: "exact", head: true }).eq("kind", "like"),
  ]);

  if (preferencesResult.error) {
    return (
      <Alert variant="destructive">
        <CircleAlertIcon aria-hidden="true" />
        <AlertTitle>Preferences could not be loaded. Please try again.</AlertTitle>
      </Alert>
    );
  }

  const items = ((preferencesResult.data ?? []) as PreferenceRow[]).flatMap((row) => {
    if (row.direction !== "more" && row.direction !== "less") return [];
    const item: PreferenceListItem = {
      id: row.id,
      label: row.label,
      direction: row.direction,
    };
    return [item];
  });
  const remaining =
    preferenceUsageResult.error || preferenceUsageResult.count === null
      ? null
      : Math.max(0, PREFERENCE_DAILY_LIMIT - preferenceUsageResult.count);
  const summaryRemaining =
    summaryUsageResult.error || summaryUsageResult.count === null
      ? null
      : Math.max(0, INTEREST_SUMMARY_DAILY_LIMIT - summaryUsageResult.count);
  const summaryRow = summaryResult.error ? null : summaryResult.data;
  const initialSummary: InterestSummary | null = summaryRow
    ? {
        summary: summaryRow.summary,
        topics: summaryRow.topics,
        likeCount: summaryRow.like_count,
        generatedAt: summaryRow.generated_at,
      }
    : null;
  const positiveSignalCount =
    (likeCountResult.error || likeCountResult.count === null ? 0 : likeCountResult.count) +
    items.filter((item) => item.direction === "more").length;

  return (
    <div className="flex flex-col gap-4">
      <InterestSummaryCard
        initialSummary={initialSummary}
        remaining={summaryRemaining}
        positiveSignalCount={positiveSignalCount}
      />
      <PreferencesForm items={items} remaining={remaining} />
    </div>
  );
}
