import { cacheLife } from "next/cache";
import { ContentCard } from "@/components/content-card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { readGuestFeed } from "@/lib/guest-feed";
import { createAnonymousClient } from "@/lib/supabase/anonymous";

async function cachedGuestFeed() {
  "use cache: remote";
  cacheLife({ stale: 300, revalidate: 1800, expire: 86400 });
  const renderedAt = new Date().toISOString();
  const start = performance.now();
  try {
    const items = await readGuestFeed(createAnonymousClient(), renderedAt);
    return { items, renderedAt };
  } finally {
    if (process.env.VERCEL === "1") {
      console.info("guest_preview_read_ms", Math.round(performance.now() - start));
    }
  }
}

export async function GuestPreview() {
  let feed: Awaited<ReturnType<typeof cachedGuestFeed>> | undefined;
  const start = performance.now();
  try {
    feed = await cachedGuestFeed();
  } catch {
    // Keep auth usable and provider/internal details out of the public page.
  } finally {
    if (process.env.VERCEL === "1") {
      console.info("guest_preview_load_ms", Math.round(performance.now() - start));
    }
  }
  if (!feed?.items.length)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Preview temporarily unavailable.</EmptyTitle>
          <EmptyDescription>Sign in to open your feed.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return (
    <div className="flex flex-col gap-4">
      {feed.items.map((item) => (
        <article key={item.id} data-guest-item-id={item.id}>
          <ContentCard item={item} renderedAt={feed.renderedAt} />
        </article>
      ))}
    </div>
  );
}
