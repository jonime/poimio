import { CircleAlertIcon } from "lucide-react";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { FieldGroup } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/server";
import { SourceRow } from "./source-row";

export const instant = true;

const sourceNameOrder = new Intl.Collator("en", { sensitivity: "accent" });

export default function SourcesPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Sources</h1>
        <p className="text-sm text-muted-foreground">
          Changes apply on the next feed load or refresh.
        </p>
      </header>
      <Suspense
        fallback={<Skeleton className="h-32 w-full" role="status" aria-label="Loading sources" />}
      >
        <SourcesContent />
      </Suspense>
    </main>
  );
}

async function SourcesContent() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (error || !userId) redirect("/login");

  const [sources, hidden] = await Promise.all([
    supabase.from("sources").select("id,name,language,kind,description").eq("is_active", true),
    supabase.from("hidden_sources").select("source_id").eq("user_id", userId),
  ]);

  if (sources.error || hidden.error) {
    return (
      <Alert role="alert" variant="destructive">
        <CircleAlertIcon aria-hidden="true" />
        <AlertTitle>Sources could not be loaded. Please try again.</AlertTitle>
      </Alert>
    );
  }

  if (sources.data.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No active sources</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  const hiddenIds = new Set(hidden.data.map((row) => row.source_id));
  const sortedSources = sources.data.toSorted(
    (a, b) => sourceNameOrder.compare(a.name, b.name) || a.id.localeCompare(b.id),
  );

  return (
    <Card>
      <CardContent>
        <FieldGroup>
          {sortedSources.map((source) => (
            <SourceRow key={source.id} source={source} visible={!hiddenIds.has(source.id)} />
          ))}
        </FieldGroup>
      </CardContent>
    </Card>
  );
}
