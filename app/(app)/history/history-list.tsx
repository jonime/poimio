"use client";

import {
  CheckIcon,
  CircleAlertIcon,
  HistoryIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from "lucide-react";
import { useState } from "react";
import { clearFeedback, setFeedback } from "@/app/feedback/actions";
import { ContentCard } from "@/components/content-card";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardFooter } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import type { FeedbackKind, HistoryFeedItem } from "@/lib/feed-ui";
import { loadMoreHistory } from "./actions";

const feedbackActions = [
  { kind: "like", label: "Like", icon: ThumbsUpIcon },
  { kind: "not_interested", label: "Not interested", icon: ThumbsDownIcon },
  { kind: "seen", label: "Seen", icon: CheckIcon },
] as const;

function HistoryCard({
  item,
  renderedAt,
  feedbackKind,
  pending,
  onFeedback,
}: {
  item: HistoryFeedItem;
  renderedAt: string;
  feedbackKind: FeedbackKind | null;
  pending: boolean;
  onFeedback: (itemId: string, kind: FeedbackKind) => void;
}) {
  return (
    <article data-history-item-id={item.id}>
      <ContentCard
        item={item}
        renderedAt={renderedAt}
        footer={
          <CardFooter className="gap-1" role="group" aria-label="Rate this item">
            {feedbackActions.map(({ kind, label, icon: Icon }) => {
              const pressed = feedbackKind === kind;
              return (
                <Button
                  key={kind}
                  variant={pressed ? (kind === "like" ? "success" : "secondary") : "ghost"}
                  size="sm"
                  type="button"
                  aria-label={label}
                  aria-pressed={pressed}
                  disabled={pending}
                  onClick={() => onFeedback(item.id, kind)}
                >
                  <Icon data-icon="inline-start" aria-hidden="true" />
                  {pressed && kind === "like" ? "Liked" : label}
                </Button>
              );
            })}
          </CardFooter>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {item.opened && <Badge variant="secondary">Opened</Badge>}
          {item.seen && <Badge variant="outline">Seen</Badge>}
        </div>
      </ContentCard>
    </article>
  );
}

export default function HistoryList({
  initialItems,
  initialHasMore,
  renderedAt,
}: {
  initialItems: HistoryFeedItem[];
  initialHasMore: boolean;
  renderedAt: string;
}) {
  const [items, setItems] = useState(initialItems);
  const [feedback, setFeedbackState] = useState<Record<string, FeedbackKind | null>>(() =>
    Object.fromEntries(initialItems.map((item) => [item.id, item.feedback_kind])),
  );
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  async function updateFeedback(itemId: string, kind: FeedbackKind) {
    if (pendingIds.has(itemId)) return;
    const previous = feedback[itemId] ?? null;
    const next = previous === kind ? null : kind;
    setPendingIds((current) => new Set(current).add(itemId));
    setError(null);
    try {
      if (next === null) await clearFeedback(itemId);
      else await setFeedback(itemId, next, "button");
      setFeedbackState((current) => ({ ...current, [itemId]: next }));
    } catch {
      setError("Could not save feedback. Please try again.");
    } finally {
      setPendingIds((current) => {
        const updated = new Set(current);
        updated.delete(itemId);
        return updated;
      });
    }
  }

  async function loadMore() {
    if (loading) return;
    const cursor = items.at(-1);
    if (!cursor) return;
    setLoading(true);
    setError(null);
    try {
      const nextPage = await loadMoreHistory(cursor.event_at, cursor.id);
      const knownIds = new Set(items.map((item) => item.id));
      const additions = nextPage.items.filter((item) => !knownIds.has(item.id));
      setItems((current) => [...current, ...additions]);
      setFeedbackState((current) => ({
        ...current,
        ...Object.fromEntries(additions.map((item) => [item.id, item.feedback_kind])),
      }));
      setHasMore(nextPage.hasMore);
    } catch {
      setError("Could not load more history. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (items.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HistoryIcon />
          </EmptyMedia>
          <EmptyTitle>No history yet.</EmptyTitle>
          <EmptyDescription>Items you open or mark as seen will appear here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      {error && (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      )}
      <div className="flex flex-col gap-4">
        {items.map((item) => (
          <HistoryCard
            key={item.id}
            item={item}
            renderedAt={renderedAt}
            feedbackKind={feedback[item.id] ?? null}
            pending={pendingIds.has(item.id)}
            onFeedback={(itemId, kind) => void updateFeedback(itemId, kind)}
          />
        ))}
      </div>
      {hasMore && (
        <div className="flex justify-center py-4">
          <Button
            variant="outline"
            type="button"
            disabled={loading}
            onClick={() => void loadMore()}
          >
            {loading && <Spinner data-icon="inline-start" />}
            {loading ? "Loading..." : "Load more"}
          </Button>
        </div>
      )}
    </>
  );
}
