import { redirect } from "next/navigation";
import { CircleAlertIcon } from "lucide-react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { createClient } from "@/lib/supabase/server";
import type { LikedFeedItem } from "@/lib/feed-ui";
import LikedList from "./liked-list";

export const instant = false;

interface RelatedContentItem {
  id: string;
  url: string;
  title: string;
  summary: string | null;
  summary_origin: "feed" | "page_metadata" | "ai_generated" | null;
  enrichment_status: "pending" | "completed" | "exhausted";
  type: "article" | "video";
  language: "fi" | "en";
  thumbnail_url: string | null;
  published_at: string;
  source: { name: string } | { name: string }[] | null;
}

interface RawLikedItem {
  updated_at: string;
  item: RelatedContentItem | RelatedContentItem[] | null;
}

export default async function LikedPage() {
  const supabase = await createClient();
  const { data: claimsData, error: claimsError } =
    await supabase.auth.getClaims();
  if (claimsError || !claimsData?.claims?.sub) redirect("/login");

  const { data, error } = await supabase
    .from("feedback")
    .select(
      "updated_at,item:content_items(id,url,title,summary,summary_origin,enrichment_status,type,language,thumbnail_url,published_at,source:sources(name))",
    )
    .eq("kind", "like")
    .order("updated_at", { ascending: false });
  const likedItems = ((data ?? []) as RawLikedItem[]).flatMap((row) => {
    const item = Array.isArray(row.item) ? row.item[0] : row.item;
    if (
      !item ||
      item.enrichment_status !== "completed" ||
      !item.summary?.trim() ||
      item.summary_origin === null
    ) {
      return [];
    }
    const source = Array.isArray(item.source) ? item.source[0] : item.source;
    const likedItem: LikedFeedItem = {
      id: item.id,
      url: item.url,
      title: item.title,
      summary: item.summary,
      summary_origin: item.summary_origin,
      type: item.type,
      language: item.language,
      thumbnail_url: item.thumbnail_url,
      published_at: item.published_at,
      source_name: source?.name ?? "Unknown source",
      liked_at: row.updated_at,
    };
    return [likedItem];
  });

  const renderedAt = new Date().toISOString();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <h1 id="liked-heading" className="text-2xl font-semibold tracking-tight">
        Liked items
      </h1>
      {error ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>
            Liked items could not be loaded. Please try again.
          </AlertTitle>
        </Alert>
      ) : (
        <LikedList initialItems={likedItems} renderedAt={renderedAt} />
      )}
    </main>
  );
}
