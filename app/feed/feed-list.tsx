"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Image from "next/image";
import {
  CheckIcon,
  CircleAlertIcon,
  InboxIcon,
  SparklesIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { clearFeedback, setFeedback } from "../feedback/actions";
import { loadMoreFeed } from "./actions";
import { RefreshFeedButton } from "./refresh-feed-button";
import {
  FeedbackMutationQueue,
  type FeedbackKind,
  type FeedbackQueueSnapshot,
  type FeedbackState,
} from "../../lib/feedback-queue";
import {
  explanationForFeedItem,
  formatRelativeTime,
  safeHttpUrl,
  type FeedItem,
} from "../../lib/feed-ui";
import {
  beginSwipe,
  finishSwipe,
  moveSwipe,
  type SwipeGesture,
} from "../../lib/swipe-gesture";

const pageSize = 30;
const maximumItems = 1000;

function FeedCard({
  item,
  onUndo,
  renderedAt,
}: {
  item: FeedItem;
  onUndo: (restore: () => void) => void;
  renderedAt: string;
}) {
  const [snapshot, setSnapshot] = useState<FeedbackQueueSnapshot>({
    confirmed: null,
    displayed: null,
    saving: false,
    error: null,
  });
  const [gesture, setGesture] = useState<SwipeGesture | null>(null);
  const queueRef = useRef<FeedbackMutationQueue | null>(null);
  const gestureRef = useRef<SwipeGesture | null>(null);
  const suppressClick = useRef(false);
  if (queueRef.current === null) {
    queueRef.current = new FeedbackMutationQueue(
      null,
      async (state: FeedbackState) => {
        if (state) {
          await setFeedback(item.id, state.kind, state.via);
        } else {
          await clearFeedback(item.id);
        }
      },
      setSnapshot,
    );
  }
  function chooseAction(
    kind: FeedbackKind,
    via: "button" | "swipe" = "button",
  ) {
    const queue = queueRef.current;
    if (!queue) return;
    const previous = queue.snapshot.displayed;
    const next = previous?.kind === kind ? null : { kind, via };
    queue.enqueue(next);
    if (via === "swipe" || (next !== null && kind !== "like")) {
      onUndo(() => queue.enqueue(previous));
    }
  }

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    const nextGesture = beginSwipe(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect().width,
    );
    gestureRef.current = nextGesture;
    setGesture(nextGesture);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const currentGesture = gestureRef.current;
    if (!currentGesture) return;
    const nextGesture = moveSwipe(currentGesture, event.clientX, event.clientY);
    gestureRef.current = nextGesture;
    setGesture(nextGesture);
    if (nextGesture.lock === "horizontal") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  function onPointerUp() {
    const currentGesture = gestureRef.current;
    if (!currentGesture) return;
    const result = finishSwipe(currentGesture);
    gestureRef.current = null;
    setGesture(null);
    if (result.action) {
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      chooseAction(result.action, "swipe");
    }
  }

  function onPointerCancel() {
    gestureRef.current = null;
    setGesture(null);
  }

  function onClickCapture(event: ReactMouseEvent<HTMLElement>) {
    if (!suppressClick.current) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClick.current = false;
  }

  const collapsed =
    snapshot.displayed?.kind === "not_interested" ||
    snapshot.displayed?.kind === "seen";

  const itemUrl = safeHttpUrl(item.url);
  const thumbnailUrl = safeHttpUrl(item.thumbnail_url);
  const swipeDelta = gesture?.lock === "horizontal" ? gesture.deltaX : 0;
  const revealOpacity = gesture
    ? Math.min(1, Math.abs(swipeDelta) / (gesture.width * 0.4 || 1))
    : 0;
  const cardStyle: CSSProperties = {
    transform: swipeDelta ? `translateX(${swipeDelta}px)` : undefined,
    transition: gesture ? "none" : undefined,
  };
  const feedbackActions = [
    { kind: "like", label: "Like", icon: ThumbsUpIcon },
    { kind: "not_interested", label: "Not interested", icon: ThumbsDownIcon },
    { kind: "seen", label: "Seen", icon: CheckIcon },
  ] as const;

  return (
    <div className="relative overflow-hidden rounded-xl" hidden={collapsed}>
      {swipeDelta !== 0 && (
        <div
          className={cn(
            "absolute inset-0 flex items-center gap-2 px-6 font-medium",
            swipeDelta > 0
              ? "justify-start bg-primary/10 text-primary"
              : "justify-end bg-destructive/10 text-destructive",
          )}
          style={{ opacity: revealOpacity }}
          aria-hidden="true"
        >
          {swipeDelta > 0 ? (
            <>
              <ThumbsUpIcon className="size-5" /> Like
            </>
          ) : (
            <>
              Not interested <ThumbsDownIcon className="size-5" />
            </>
          )}
        </div>
      )}
      <article
        className="relative touch-pan-y transition-transform duration-200"
        data-feed-item-id={item.id}
        aria-busy={snapshot.saving}
        style={cardStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClickCapture={onClickCapture}
      >
        <Card
          className={cn(
            "relative",
            itemUrl &&
              "transition-shadow hover:shadow-md has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring",
          )}
        >
          {thumbnailUrl && (
            <Image
              className="aspect-video w-full object-cover"
              src={thumbnailUrl}
              width={1200}
              height={675}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              unoptimized
            />
          )}
          <CardHeader>
            <CardDescription className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{item.source_name}</Badge>
              <time dateTime={item.published_at}>
                {formatRelativeTime(item.published_at, new Date(renderedAt))}
              </time>
            </CardDescription>
            <CardTitle className="text-lg">
              <h2 className="break-words">
                {itemUrl ? (
                  <a
                    className="underline-offset-4 outline-none group-hover/card:underline after:absolute after:inset-0 after:content-['']"
                    href={itemUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {item.title}
                  </a>
                ) : (
                  item.title
                )}
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {item.summary && (
              <p className="line-clamp-3 break-words text-muted-foreground">
                {item.summary}
              </p>
            )}
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <SparklesIcon className="size-3.5 shrink-0" aria-hidden="true" />
              {explanationForFeedItem(item)}
            </p>
            {snapshot.error && (
              <p className="text-sm text-destructive" role="alert">
                {snapshot.error}
              </p>
            )}
          </CardContent>
          <CardFooter
            className="relative z-10 gap-1"
            role="group"
            aria-label="Rate this item"
          >
            {feedbackActions.map(({ kind, label, icon: Icon }) => {
              const pressed = snapshot.displayed?.kind === kind;
              return (
                <Button
                  key={kind}
                  variant={
                    pressed ? (kind === "like" ? "success" : "secondary") : "ghost"
                  }
                  size="sm"
                  type="button"
                  aria-label={label}
                  aria-pressed={pressed}
                  onClick={() => chooseAction(kind)}
                >
                  <Icon data-icon="inline-start" aria-hidden="true" />
                  {pressed && kind === "like" ? "Liked" : label}
                </Button>
              );
            })}
          </CardFooter>
        </Card>
      </article>
    </div>
  );
}

export default function FeedList({
  initialItems,
  renderedAt,
}: {
  initialItems: FeedItem[];
  renderedAt: string;
}) {
  const [items, setItems] = useState(initialItems);
  const [hasMore, setHasMore] = useState(initialItems.length === pageSize);
  const [loading, setLoading] = useState(false);
  const [requestMore, setRequestMore] = useState(false);
  const [error, setError] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const requestInFlight = useRef(false);
  const undoToastId = useRef<string | null>(null);

  function showUndoToast(restore: () => void) {
    if (undoToastId.current) toast.close(undoToastId.current);
    const id = toast.add({
      title: "Feedback updated",
      timeout: 5000,
      actionProps: {
        children: "Undo",
        onClick: () => {
          restore();
          toast.close(id);
        },
      },
    });
    undoToastId.current = id;
  }

  useEffect(() => {
    if (!hasMore || items.length >= maximumItems) return;
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setRequestMore(true);
    });
    const sentinel = sentinelRef.current;
    if (sentinel) observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, items.length]);

  useEffect(() => {
    if (!requestMore || !hasMore || loading || requestInFlight.current) return;

    const requestedLimit = Math.min(pageSize, maximumItems - items.length);
    requestInFlight.current = true;
    setRequestMore(false);
    setLoading(true);
    setError(false);

    void loadMoreFeed(items.map((item) => item.id))
      .then((nextItems) => {
        setItems((currentItems) => {
          const knownIds = new Set(currentItems.map((item) => item.id));
          const uniqueItems = nextItems.filter(
            (item) => !knownIds.has(item.id),
          );
          return [...currentItems, ...uniqueItems].slice(0, maximumItems);
        });
        setHasMore(
          nextItems.length === requestedLimit &&
            items.length + nextItems.length < maximumItems,
        );
      })
      .catch(() => setError(true))
      .finally(() => {
        requestInFlight.current = false;
        setLoading(false);
      });
  }, [hasMore, items, loading, requestMore]);

  const atMaximum = items.length >= maximumItems;
  const caughtUp = !hasMore && !atMaximum;

  return (
    <>
      {items.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon />
            </EmptyMedia>
            <EmptyTitle>No new items right now.</EmptyTitle>
            <EmptyDescription>
              New articles and videos arrive every hour.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {items.map((item) => (
            <FeedCard
              item={item}
              renderedAt={renderedAt}
              key={item.id}
              onUndo={showUndoToast}
            />
          ))}
        </div>
      )}
      {error && (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>Could not load more items. Please try again.</AlertTitle>
        </Alert>
      )}
      {hasMore && !atMaximum ? (
        <div className="flex flex-col items-center gap-3 py-4">
          <div className="h-px w-full" ref={sentinelRef} aria-hidden="true" />
          <Button
            variant="outline"
            type="button"
            disabled={loading}
            onClick={() => setRequestMore(true)}
          >
            {loading && <Spinner data-icon="inline-start" />}
            {loading ? "Loading..." : "Load more"}
          </Button>
        </div>
      ) : (
        <div
          className="flex flex-col items-center gap-3 py-6 text-sm text-muted-foreground"
          role="status"
        >
          <p>
            {atMaximum
              ? "Refresh to see more items."
              : caughtUp
                ? "You're all caught up."
                : "No new items right now."}
          </p>
          <RefreshFeedButton />
        </div>
      )}
    </>
  );
}
