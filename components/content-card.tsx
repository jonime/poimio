import Image from "next/image";
import type { ReactNode } from "react";
import { TrackedItemLink } from "@/components/tracked-item-link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRelativeTime, safeHttpUrl } from "@/lib/feed-ui";
import { cn } from "@/lib/utils";

interface ContentCardItem {
  id: string;
  url: string;
  title: string;
  summary: string | null;
  summary_origin: "feed" | "page_metadata" | "ai_generated" | null;
  type: "article" | "video";
  language: "fi" | "en";
  thumbnail_url: string | null;
  published_at: string;
  source_name: string;
}

/** Static card presentation shared by the server preview and interactive feed. */
export function ContentCard({
  item,
  renderedAt,
  children,
  footer,
  onOpenItem,
}: {
  item: ContentCardItem;
  renderedAt: string;
  children?: ReactNode;
  footer?: ReactNode;
  onOpenItem?: (itemId: string) => void;
}) {
  const itemUrl = safeHttpUrl(item.url);
  const thumbnailUrl = safeHttpUrl(item.thumbnail_url);
  return (
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
          {item.summary_origin === "ai_generated" && <Badge variant="outline">AI summary</Badge>}
          <time dateTime={item.published_at}>
            {formatRelativeTime(item.published_at, new Date(renderedAt))}
          </time>
        </CardDescription>
        <CardTitle className="text-lg">
          <h2 className="break-words">
            {itemUrl && onOpenItem ? (
              <TrackedItemLink
                itemId={item.id}
                onOpenItem={onOpenItem}
                className="underline-offset-4 outline-none group-hover/card:underline after:absolute after:inset-0 after:content-['']"
                href={itemUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {item.title}
              </TrackedItemLink>
            ) : itemUrl ? (
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
          <p className="line-clamp-3 break-words text-muted-foreground">{item.summary}</p>
        )}
        {children}
      </CardContent>
      {footer}
    </Card>
  );
}
