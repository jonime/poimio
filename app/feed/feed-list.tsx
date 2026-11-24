"use client";

import {
  CheckIcon,
  CircleAlertIcon,
  EllipsisVerticalIcon,
  InboxIcon,
  SparklesIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { ContentCard } from "@/components/content-card";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CardFooter } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { explanationForFeedItem, type FeedItem } from "../../lib/feed-ui";
import {
  type FeedbackKind,
  FeedbackMutationQueue,
  type FeedbackQueueSnapshot,
  type FeedbackState,
} from "../../lib/feedback-queue";
import { beginSwipe, finishSwipe, moveSwipe, type SwipeGesture } from "../../lib/swipe-gesture";
import { clearFeedback, hideSource, setFeedback, showSource } from "../feedback/actions";
import { loadMoreFeed } from "./actions";
import { RefreshFeedButton } from "./refresh-feed-button";

const pageSize = 30;
const maximumItems = 1000;

function FeedCard({
  hiddenBySource,
  item,
  onHideSource,
  onUndo,
  renderedAt,
  sourcePending,
}: {
  hiddenBySource: boolean;
  item: FeedItem;
  onHideSource: (item: FeedItem) => Promise<boolean>;
  onUndo: (restore: () => void) => void;
  renderedAt: string;
  sourcePending: boolean;
}) {
  const [snapshot, setSnapshot] = useState<FeedbackQueueSnapshot>({
    confirmed: null,
    displayed: null,
    saving: false,
    error: null,
  });
  const [gesture, setGesture] = useState<SwipeGesture | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const queueRef = useRef<FeedbackMutationQueue | null>(null);
  const gestureRef = useRef<SwipeGesture | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const suppressMenuFinalFocusRef = useRef(false);
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
  function chooseAction(kind: FeedbackKind, via: "button" | "swipe" = "button") {
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
    const target = event.target;
    if (
      menuOpen ||
      (target instanceof Element && target.closest('[data-slot="dropdown-menu-trigger"]')) ||
      event.pointerType !== "touch" ||
      !event.isPrimary
    ) {
      return;
    }
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
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Pointer handlers and the timeout mutate this ref.
    if (!suppressClick.current) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClick.current = false;
  }

  const collapsed =
    snapshot.displayed?.kind === "not_interested" || snapshot.displayed?.kind === "seen";

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
    <div className="relative overflow-hidden rounded-xl" hidden={collapsed || hiddenBySource}>
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
        <ContentCard
          item={item}
          renderedAt={renderedAt}
          footer={
            <CardFooter className="relative z-10 gap-1" role="group" aria-label="Rate this item">
              {feedbackActions.map(({ kind, label, icon: Icon }) => {
                const pressed = snapshot.displayed?.kind === kind;
                return (
                  <Button
                    key={kind}
                    variant={pressed ? (kind === "like" ? "success" : "secondary") : "ghost"}
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
              <DropdownMenu
                open={menuOpen}
                onOpenChange={(open) => {
                  if (open) {
                    gestureRef.current = null;
                    suppressMenuFinalFocusRef.current = false;
                    setGesture(null);
                  }
                  setMenuOpen(open);
                }}
              >
                <DropdownMenuTrigger
                  render={
                    <Button
                      ref={menuTriggerRef}
                      className="ml-auto"
                      variant="ghost"
                      size="icon-sm"
                      type="button"
                      aria-label="More actions"
                    />
                  }
                >
                  <EllipsisVerticalIcon aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  finalFocus={() => !suppressMenuFinalFocusRef.current}
                >
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      disabled={sourcePending}
                      onClick={() => {
                        suppressMenuFinalFocusRef.current = true;
                        void onHideSource(item).then((hidden) => {
                          if (!hidden) menuTriggerRef.current?.focus();
                        });
                      }}
                    >
                      {sourcePending && <Spinner data-icon="inline-start" />}
                      Hide {item.source_name}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </CardFooter>
          }
        >
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <SparklesIcon className="size-3.5 shrink-0" aria-hidden="true" />
            {explanationForFeedItem(item)}
          </p>
          {snapshot.error && (
            <p className="text-sm text-destructive" role="alert">
              {snapshot.error}
            </p>
          )}
        </ContentCard>
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
  const [hiddenSourceIds, setHiddenSourceIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingSourceIds, setPendingSourceIds] = useState<ReadonlySet<string>>(new Set());
  const sentinelRef = useRef<HTMLDivElement>(null);
  const requestInFlight = useRef(false);
  const pendingSourceIdsRef = useRef(new Set<string>());
  const focusAfterHideRef = useRef<string | null>(null);
  const undoToastId = useRef<string | null>(null);

  function setSourcePending(sourceId: string, pending: boolean) {
    const next = new Set(pendingSourceIdsRef.current);
    if (pending) next.add(sourceId);
    else next.delete(sourceId);
    pendingSourceIdsRef.current = next;
    setPendingSourceIds(next);
  }

  function showSourceError(title: string, description?: string) {
    toast.add({ type: "error", title, description, timeout: 5000 });
  }

  async function undoHiddenSource(sourceId: string) {
    if (pendingSourceIdsRef.current.has(sourceId)) return;
    setSourcePending(sourceId, true);
    try {
      const result = await showSource(sourceId);
      if (!result.ok) {
        showSourceError("Could not show the source", "Show it again from the preferences page.");
        return;
      }
      setHiddenSourceIds((current) => {
        const next = new Set(current);
        next.delete(sourceId);
        return next;
      });
    } catch {
      showSourceError("Could not show the source", "Show it again from the preferences page.");
    } finally {
      setSourcePending(sourceId, false);
    }
  }

  async function hideItemSource(item: FeedItem): Promise<boolean> {
    if (pendingSourceIdsRef.current.has(item.source_id)) return false;
    setSourcePending(item.source_id, true);
    try {
      const result = await hideSource(item.id);
      if (!result.ok) {
        showSourceError("Could not hide this source");
        return false;
      }
      const sourceId = result.sourceId;
      const sourceName = result.sourceName ?? item.source_name;
      setHiddenSourceIds((current) => new Set(current).add(sourceId));
      focusAfterHideRef.current = item.id;
      const toastId = toast.add({
        type: "success",
        title: `Hidden ${sourceName}`,
        timeout: 5000,
        actionProps: {
          children: "Undo",
          onClick: () => {
            toast.close(toastId);
            void undoHiddenSource(sourceId);
          },
        },
      });
      return true;
    } catch {
      showSourceError("Could not hide this source");
      return false;
    } finally {
      setSourcePending(item.source_id, false);
    }
  }

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
    const hiddenItemId = focusAfterHideRef.current;
    const hiddenItem = items.find((item) => item.id === hiddenItemId);
    if (!hiddenItem || !hiddenSourceIds.has(hiddenItem.source_id)) return;
    const currentIndex = items.indexOf(hiddenItem);
    const articles = [...document.querySelectorAll<HTMLElement>("article[data-feed-item-id]")];
    const nextVisibleControl = items.slice(currentIndex + 1).flatMap((item) => {
      const article = articles.find(
        (candidate) => candidate.dataset.feedItemId === item.id && !candidate.closest("[hidden]"),
      );
      const control = article?.querySelector<HTMLElement>("button:not([disabled]), a[href]");
      return control ? [control] : [];
    })[0];
    (nextVisibleControl ?? document.getElementById("feed-heading"))?.focus();
    focusAfterHideRef.current = null;
  }, [hiddenSourceIds, items]);

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
          const uniqueItems = nextItems.filter((item) => !knownIds.has(item.id));
          return [...currentItems, ...uniqueItems].slice(0, maximumItems);
        });
        setHasMore(
          nextItems.length === requestedLimit && items.length + nextItems.length < maximumItems,
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
            <EmptyDescription>New articles and videos arrive every hour.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {items.map((item) => (
            <FeedCard
              hiddenBySource={hiddenSourceIds.has(item.source_id)}
              item={item}
              key={item.id}
              onHideSource={hideItemSource}
              onUndo={showUndoToast}
              renderedAt={renderedAt}
              sourcePending={pendingSourceIds.has(item.source_id)}
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
