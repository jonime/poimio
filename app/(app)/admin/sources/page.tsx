import { CircleAlertIcon } from "lucide-react";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { sortDiscoveryCandidates } from "@/lib/source-discovery";
import { getSourceDiscoveryAdminUserId } from "@/lib/source-discovery-access";
import { createClient } from "@/lib/supabase/server";
import { AdminSourcesReview, type CandidateRow, type DiscoveryRunRow } from "./review";

export const maxDuration = 300;
export const instant = true;

export default function AdminSourcesPage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6">
      <Suspense
        fallback={
          <Skeleton className="h-48 w-full" role="status" aria-label="Loading source discovery" />
        }
      >
        <AdminSourcesContent />
      </Suspense>
    </main>
  );
}

async function AdminSourcesContent() {
  const client = await createClient();
  if (!(await getSourceDiscoveryAdminUserId(client))) notFound();

  const [candidateResult, runResult] = await Promise.all([
    client
      .from("source_candidates")
      .select(
        "id,origin,name,feed_url,site_url,kind,language,status,failure,item_count,items_per_day,relevance,relevance_basis,mean_match_share,duplicate_share,sample_titles,scanned_at,decided_at",
      )
      .order("scanned_at", { ascending: false }),
    client
      .from("source_discovery_runs")
      .select("id,kind,started_at,finished_at,status,failures")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (candidateResult.error || runResult.error) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Source discovery</h1>
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>Source discovery could not be loaded. Please try again.</AlertTitle>
        </Alert>
      </div>
    );
  }

  const candidates = (candidateResult.data ?? []) as CandidateRow[];
  const latestRun = (runResult.data ?? null) as DiscoveryRunRow | null;
  const pending = sortDiscoveryCandidates(
    candidates
      .filter((candidate) => candidate.status === "pending")
      .map((candidate) => ({
        candidate,
        relevance: candidate.relevance,
        meanMatchShare: numeric(candidate.mean_match_share),
        duplicateShare: numeric(candidate.duplicate_share),
      })),
  ).map(({ candidate }) => candidate);

  return (
    <AdminSourcesReview
      pending={pending}
      failed={candidates.filter((candidate) => candidate.status === "failed")}
      decided={candidates.filter(
        (candidate) => candidate.status === "approved" || candidate.status === "rejected",
      )}
      latestRun={latestRun}
    />
  );
}

function numeric(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
