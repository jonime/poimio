import { CircleAlertIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { displayNameFromClaims } from "@/lib/app-access";
import type { FeedItem } from "@/lib/feed-ui";
import { isLocalPasswordLoginEnabled } from "@/lib/supabase/local-password-login";
import { createClient } from "@/lib/supabase/server";
import FeedList from "./feed/feed-list";
import { GuestPreview } from "./feed/guest-preview";
import { RefreshFeedButton } from "./feed/refresh-feed-button";
import { LocalSignInDialog } from "./login/local-sign-in-dialog";
import { SignInButton } from "./login/sign-in-button";

export const instant = false;

function CallbackError() {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>Sign-in could not be completed. Please try again.</AlertTitle>
    </Alert>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  // createClient enters the request-time boundary; identity and personal feed
  // data never enter the shared public preview cache.
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const params = await searchParams;
  const isVerifiedUser = !error && typeof data?.claims?.sub === "string" && !!data.claims.sub;

  if (!isVerifiedUser) {
    const preview = await GuestPreview();
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-8 sm:py-12">
        <div className="flex flex-col items-center gap-5 text-center">
          <Image
            src="/full.png"
            alt="Poimio"
            width={2172}
            height={724}
            priority
            className="h-auto w-44"
          />
          <p className="text-2xl font-semibold tracking-tight sm:text-3xl">
            The web, picked for you.
          </p>
          <div className="w-full max-w-72">
            <SignInButton />
          </div>
        </div>
        {params.error === "callback" && <CallbackError />}
        <section className="flex flex-col gap-4" aria-labelledby="preview-heading">
          <div className="flex flex-col gap-2">
            <h1 id="preview-heading" className="text-2xl font-semibold tracking-tight">
              Latest picks
            </h1>
            <p className="text-sm text-muted-foreground">
              A preview from our sources. Sign in to get recommendations based on your interests.
            </p>
          </div>
          {preview}
        </section>
        <div className="flex flex-col items-center gap-4 pb-4 text-center">
          <p className="text-sm text-muted-foreground">Make your next picks personal.</p>
          <div className="w-full max-w-72">
            <SignInButton />
          </div>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link href="/privacy" className="underline underline-offset-4">
              Privacy policy
            </Link>
            <a href="https://github.com/jonime/poimio" className="underline underline-offset-4">
              GitHub
            </a>
          </div>
        </div>
        {isLocalPasswordLoginEnabled() && <LocalSignInDialog />}
      </main>
    );
  }

  const { data: feedData, error: feedError } = await supabase.rpc("get_feed", { p_limit: 30 });
  const renderedAt = new Date().toISOString();
  return (
    <>
      <AppHeader displayName={displayNameFromClaims(data?.claims) ?? null} />
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6">
        {params.error === "callback" && <CallbackError />}
        {params.error === "sign-out" && (
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>Sign-out failed. Please try again.</AlertTitle>
          </Alert>
        )}
        <section className="flex flex-col gap-4" aria-labelledby="feed-heading">
          <div className="flex items-center justify-between gap-4">
            <h1 id="feed-heading" className="text-2xl font-semibold tracking-tight">
              Your feed
            </h1>
            <RefreshFeedButton />
          </div>
          {feedError ? (
            <Alert variant="destructive">
              <CircleAlertIcon aria-hidden="true" />
              <AlertTitle>The feed could not be loaded. Please try again.</AlertTitle>
            </Alert>
          ) : (
            <FeedList
              key={renderedAt}
              initialItems={(feedData ?? []) as FeedItem[]}
              renderedAt={renderedAt}
            />
          )}
        </section>
      </main>
    </>
  );
}
