"use server";

import { redirect } from "next/navigation";
import { isLocalPasswordLoginEnabled } from "../../lib/supabase/local-password-login";
import { createClient } from "../../lib/supabase/server";

export async function signInWithPassword(
  _previousError: string | null,
  formData: FormData,
): Promise<string | null> {
  if (!isLocalPasswordLoginEnabled()) {
    return "Password sign-in is unavailable.";
  }

  const email = formData.get("email");
  const password = formData.get("password");
  if (
    typeof email !== "string" ||
    email.trim().length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
    typeof password !== "string" ||
    !password ||
    password.length > 4096
  ) {
    return "Enter a valid email address and password.";
  }

  const failureMessage =
    "Sign-in failed. Check your email and password and try again.";
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) return failureMessage;

    const { data, error: claimsError } = await supabase.auth.getClaims();
    if (claimsError || !data?.claims?.sub) {
      await supabase.auth.signOut({ scope: "local" });
      return failureMessage;
    }
  } catch {
    return failureMessage;
  }

  redirect("/");
}

export async function signOut() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) redirect("/");

  const { error: signOutError } = await supabase.auth.signOut({
    scope: "local",
  });
  if (signOutError) redirect("/?error=sign-out");

  redirect("/");
}
