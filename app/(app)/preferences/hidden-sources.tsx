"use client";

import { CircleAlertIcon, EyeOffIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { showSource } from "../../feedback/actions";

export interface HiddenSourceListItem {
  sourceId: string;
  sourceName: string;
  createdAt: string;
}

function formatHiddenDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(date);
}

export function HiddenSources({
  items,
  loadFailed = false,
}: {
  items: HiddenSourceListItem[];
  loadFailed?: boolean;
}) {
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const pendingRef = useRef(new Set<string>());
  const visible = items.filter((item) => !removed.has(item.sourceId));

  async function showAgain(item: HiddenSourceListItem) {
    if (pendingRef.current.has(item.sourceId)) return;
    pendingRef.current = new Set(pendingRef.current).add(item.sourceId);
    setPending(pendingRef.current);
    setErrors((current) => {
      const next = { ...current };
      delete next[item.sourceId];
      return next;
    });
    try {
      const result = await showSource(item.sourceId);
      if (!result.ok) {
        setErrors((current) => ({
          ...current,
          [item.sourceId]:
            result.error === "not_found"
              ? "That source is no longer hidden."
              : "The source could not be shown. Please try again.",
        }));
        return;
      }
      setRemoved((current) => new Set(current).add(item.sourceId));
    } catch {
      setErrors((current) => ({
        ...current,
        [item.sourceId]: "The source could not be shown. Please try again.",
      }));
    } finally {
      const next = new Set(pendingRef.current);
      next.delete(item.sourceId);
      pendingRef.current = next;
      setPending(next);
    }
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="hidden-sources-heading">
      <div className="flex flex-col gap-1">
        <h1 id="hidden-sources-heading" className="text-2xl font-semibold tracking-tight">
          Hidden sources
        </h1>
        <p className="text-sm text-muted-foreground">
          Items from these sources stay out of your feed.
        </p>
      </div>
      {loadFailed ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>Hidden sources could not be loaded. Please try again.</AlertTitle>
        </Alert>
      ) : visible.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <EyeOffIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No hidden sources</EmptyTitle>
            <EmptyDescription>Sources you hide from the feed will appear here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col gap-3">
          {visible.map((item) => {
            const isPending = pending.has(item.sourceId);
            const error = errors[item.sourceId];
            return (
              <li key={item.sourceId}>
                <Card>
                  <CardHeader>
                    <CardTitle className="break-words text-base">{item.sourceName}</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-muted-foreground">
                      Hidden {formatHiddenDate(item.createdAt)}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isPending}
                      aria-label={`Show ${item.sourceName} again`}
                      onClick={() => void showAgain(item)}
                    >
                      {isPending && <Spinner data-icon="inline-start" />}
                      {isPending ? "Showing..." : "Show again"}
                    </Button>
                  </CardContent>
                  {error && (
                    <CardFooter>
                      <Alert variant="destructive">
                        <AlertTitle>{error}</AlertTitle>
                      </Alert>
                    </CardFooter>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
