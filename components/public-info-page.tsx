import { type ReactNode, Suspense } from "react";
import { AppHeader } from "@/components/app-header";
import { displayNameFromClaims } from "@/lib/app-access";
import { createClient } from "@/lib/supabase/server";

async function PublicInfoHeader() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (error || typeof claims?.sub !== "string" || !claims.sub) {
    return <AppHeader guest />;
  }

  return <AppHeader displayName={displayNameFromClaims(claims) ?? null} />;
}

export function PublicInfoPage({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <Suspense fallback={<AppHeader guest />}>
        <PublicInfoHeader />
      </Suspense>
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-3 py-8 sm:px-4 sm:py-12">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold">{title}</h1>
          {subtitle}
        </header>

        <article className="flex flex-col gap-8 text-sm leading-7 [&_h2]:text-lg [&_h2]:font-semibold [&_section]:flex [&_section]:flex-col [&_section]:gap-3 [&_a]:underline [&_a]:underline-offset-4 [&_a]:break-words [&_ul]:list-disc [&_ul]:pl-5">
          {children}
        </article>
      </main>
    </>
  );
}
