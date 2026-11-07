import { type ReactNode, Suspense } from "react";
import { AppHeader } from "@/components/app-header";
import { displayNameFromClaims } from "@/lib/app-access";
import { createClient } from "@/lib/supabase/server";
import { GuestHeader } from "./guest-header";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Suspense fallback={null}>
        <SessionHeader />
      </Suspense>
      {children}
    </>
  );
}

async function SessionHeader() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || typeof claims?.sub !== "string" || !claims.sub) {
    return (
      <GuestHeader>
        <AppHeader guest />
      </GuestHeader>
    );
  }

  return <AppHeader displayName={displayNameFromClaims(claims) ?? null} />;
}
