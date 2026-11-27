import { CircleAlertIcon } from "lucide-react";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import type { HistoryFeedItem } from "@/lib/feed-ui";
import { createClient } from "@/lib/supabase/server";
import HistoryList from "./history-list";

export const instant = true;

export default function HistoryPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <h1 id="history-heading" className="text-2xl font-semibold tracking-tight">
        History
      </h1>
      <Suspense
        fallback={
          <div className="flex flex-col gap-4" aria-busy="true">
            <p role="status" className="sr-only">
              Loading history...
            </p>
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        }
      >
        <HistoryContent />
      </Suspense>
    </main>
  );
}

async function HistoryContent() {
  const supabase = await createClient();
  const { data: claims, error: claimsError } = await supabase.auth.getClaims();
  if (claimsError || typeof claims?.claims?.sub !== "string") redirect("/login");

  const { data, error } = await supabase.rpc("get_history", { p_limit: 21 });
  if (error) {
    return (
      <Alert variant="destructive">
        <CircleAlertIcon aria-hidden="true" />
        <AlertTitle>History could not be loaded. Please try again.</AlertTitle>
      </Alert>
    );
  }
  const rows = (data ?? []) as HistoryFeedItem[];
  return (
    <HistoryList
      initialItems={rows.slice(0, 20)}
      initialHasMore={rows.length > 20}
      renderedAt={new Date().toISOString()}
    />
  );
}
