import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { displayNameFromClaims, getAppAccessRedirect } from "@/lib/app-access";
import { createClient } from "@/lib/supabase/server";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const isVerifiedUser = !error && typeof data?.claims?.sub === "string";

  const redirectTo = getAppAccessRedirect(isVerifiedUser);
  if (redirectTo) redirect(redirectTo);

  return (
    <>
      <AppHeader displayName={displayNameFromClaims(data?.claims)} />
      {children}
    </>
  );
}
