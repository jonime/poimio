import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/server";
import { type HiddenSourceListItem, HiddenSources } from "../hidden-sources";

export const instant = true;

interface HiddenSourceRow {
  source_id: string;
  created_at: string;
  sources: { name: string } | { name: string }[] | null;
}

export default function HiddenSourcesPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col px-4 py-6">
      <Suspense
        fallback={
          <div className="flex flex-col gap-4" aria-busy="true">
            <p role="status" className="sr-only">
              Loading hidden sources...
            </p>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        }
      >
        <HiddenSourcesContent />
      </Suspense>
    </main>
  );
}

async function HiddenSourcesContent() {
  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  if (claimsError || !claimsData?.claims?.sub) redirect("/login");

  const result = await supabase
    .from("hidden_sources")
    .select("source_id,created_at,sources(name)")
    .order("created_at", { ascending: false });

  const items = ((result.data ?? []) as HiddenSourceRow[]).flatMap((row) => {
    const source = Array.isArray(row.sources) ? row.sources[0] : row.sources;
    if (!source) return [];
    const item: HiddenSourceListItem = {
      sourceId: row.source_id,
      sourceName: source.name,
      createdAt: row.created_at,
    };
    return [item];
  });

  return <HiddenSources items={items} loadFailed={Boolean(result.error)} />;
}
