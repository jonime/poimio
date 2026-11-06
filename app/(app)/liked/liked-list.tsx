"use client";

import { CircleAlertIcon, HeartIcon, HeartOffIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useId, useState } from "react";
import { clearFeedback } from "@/app/feedback/actions";
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
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { formatRelativeTime, type LikedFeedItem, safeHttpUrl } from "@/lib/feed-ui";
import { cn } from "@/lib/utils";

export default function LikedList({
  items,
  renderedAt,
}: {
  items: LikedFeedItem[];
  renderedAt: string;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const searchId = useId();

  async function unlike(itemId: string) {
    if (pendingId) return;
    setPendingId(itemId);
    setError(false);
    try {
      await clearFeedback(itemId);
    } catch {
      setError(true);
    } finally {
      setPendingId(null);
    }
  }

  if (items.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HeartIcon />
          </EmptyMedia>
          <EmptyTitle>No liked items yet.</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" nativeButton={false} render={<Link href="/" />}>
            Browse your feed
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  const normalizedQuery = query.trim().toLowerCase();
  const matchingItems = normalizedQuery
    ? items.filter((item) =>
        [item.title, item.summary ?? "", item.source_name].some((field) =>
          field.toLowerCase().includes(normalizedQuery),
        ),
      )
    : items;

  return (
    <>
      {error && (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>Could not remove this like. Please try again.</AlertTitle>
        </Alert>
      )}
      <div className="flex flex-col items-start gap-2">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={searchId}>Search liked items</FieldLabel>
            <Input
              id={searchId}
              type="search"
              placeholder="Search titles, summaries, or sources"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </Field>
        </FieldGroup>
        <p role="status" className="text-sm text-muted-foreground">
          Showing {matchingItems.length} of {items.length} loaded liked items
        </p>
      </div>
      <div className="flex flex-col gap-4">
        {matchingItems.length === 0 && (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>No matching liked items.</EmptyTitle>
              <EmptyDescription>Try another search or clear it.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {matchingItems.map((item) => {
          const itemUrl = safeHttpUrl(item.url);
          const thumbnailUrl = safeHttpUrl(item.thumbnail_url);
          return (
            <Card
              key={item.id}
              role="article"
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
                  {item.summary_origin === "ai_generated" && (
                    <Badge variant="outline">AI summary</Badge>
                  )}
                  <time dateTime={item.liked_at}>
                    Liked {formatRelativeTime(item.liked_at, new Date(renderedAt))}
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
              {item.summary && (
                <CardContent>
                  <p className="line-clamp-3 break-words text-muted-foreground">{item.summary}</p>
                </CardContent>
              )}
              <CardFooter className="relative z-10">
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  aria-label={`Unlike ${item.title}`}
                  disabled={pendingId !== null}
                  onClick={() => void unlike(item.id)}
                >
                  {pendingId === item.id ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <HeartOffIcon data-icon="inline-start" aria-hidden="true" />
                  )}
                  Unlike
                </Button>
              </CardFooter>
            </Card>
          );
        })}
      </div>
    </>
  );
}
