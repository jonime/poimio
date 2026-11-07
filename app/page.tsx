import { CircleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { AppHeader } from "@/components/app-header";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { displayNameFromClaims } from "@/lib/app-access";
import type { FeedItem } from "@/lib/feed-ui";
import { homeDescription, homeTitle, productTerm, siteUrl } from "@/lib/public-home";
import { operatorName, privacyEmail } from "@/lib/public-operator";
import { isLocalPasswordLoginEnabled } from "@/lib/supabase/local-password-login";
import { createClient } from "@/lib/supabase/server";
import FeedList from "./feed/feed-list";
import { GuestPreview } from "./feed/guest-preview";
import { RefreshFeedButton } from "./feed/refresh-feed-button";
import { LocalSignInDialog } from "./login/local-sign-in-dialog";
import { SignInButton } from "./login/sign-in-button";

export const instant = true;

export const metadata: Metadata = {
  title: homeTitle,
  description: homeDescription,
  alternates: { canonical: siteUrl },
  openGraph: {
    type: "website",
    url: siteUrl,
    title: homeTitle,
    description: homeDescription,
    siteName: "Poimio",
    images: [
      {
        url: `${siteUrl}full.png`,
        type: "image/png",
        width: 2172,
        height: 724,
        alt: "Poimio wordmark",
      },
    ],
  },
};

const application = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Poimio",
  url: siteUrl,
  description: homeDescription,
  keywords: productTerm,
  applicationCategory: "LifestyleApplication",
  operatingSystem: "Web",
  sameAs: "https://github.com/jonime/poimio",
  publisher: {
    "@type": "Person",
    name: operatorName,
    url: `${siteUrl}about`,
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "privacy",
      email: privacyEmail,
      url: `${siteUrl}contact`,
    },
  },
};

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
  const authStart = performance.now();
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const authDuration = Math.round(performance.now() - authStart);
  const params = await searchParams;
  const isVerifiedUser = !error && typeof data?.claims?.sub === "string" && !!data.claims.sub;

  if (!isVerifiedUser) {
    if (process.env.VERCEL === "1") {
      console.info("guest_home_auth_ms", authDuration);
    }
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-8 sm:py-12">
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Static JSON-LD escapes markup before serialization into HTML.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(application).replace(/</g, "\\u003c") }}
        />
        <div className="flex flex-col items-center gap-5 text-center">
          <Image
            src="/full.png"
            alt="Poimio"
            width={2172}
            height={724}
            priority
            className="h-auto w-44"
          />
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Poimio, your {productTerm}
          </h1>
          <div className="w-full max-w-72">
            <SignInButton />
          </div>
        </div>
        {params.error === "callback" && <CallbackError />}
        <Suspense fallback={null}>
          <section className="flex flex-col gap-4" aria-labelledby="preview-heading">
            <div className="flex flex-col gap-2">
              <h2 id="preview-heading" className="text-2xl font-semibold tracking-tight">
                Latest picks
              </h2>
              <p className="text-sm text-muted-foreground">
                A preview from our sources. Sign in to get recommendations based on your interests.
              </p>
            </div>
            <GuestPreview />
          </section>
          <div className="flex flex-col items-center gap-4 pb-4 text-center">
            <p className="text-sm text-muted-foreground">Make your next picks personal.</p>
            <div className="w-full max-w-72">
              <SignInButton />
            </div>
            <div className="flex flex-wrap items-center justify-center gap-4 text-sm text-muted-foreground">
              <Link href="/about" className="underline underline-offset-4">
                About
              </Link>
              <Link href="/contact" className="underline underline-offset-4">
                Contact
              </Link>
              <Link href="/privacy" className="underline underline-offset-4">
                Privacy policy
              </Link>
              <a href="https://github.com/jonime/poimio" className="underline underline-offset-4">
                GitHub
              </a>
            </div>
          </div>
        </Suspense>
        {isLocalPasswordLoginEnabled() && <LocalSignInDialog />}
      </main>
    );
  }

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
          <Suspense
            fallback={
              <div className="flex flex-col gap-4" aria-busy="true">
                <p role="status" className="sr-only">
                  Loading your feed...
                </p>
                <Skeleton className="h-48 w-full" />
                <Skeleton className="h-48 w-full" />
              </div>
            }
          >
            <PersonalFeed supabase={supabase} />
          </Suspense>
        </section>
      </main>
    </>
  );
}

async function PersonalFeed({ supabase }: { supabase: Awaited<ReturnType<typeof createClient>> }) {
  const { data: feedData, error: feedError } = await supabase.rpc("get_feed", { p_limit: 30 });
  const renderedAt = new Date().toISOString();

  return feedError ? (
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
  );
}
