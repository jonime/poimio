import { redirect } from "next/navigation";

export const instant = false;

/** Compatibility for old links; sign-in now lives on the home page. */
export default async function Login({ searchParams }: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const params = await searchParams;
  redirect(params.error === "callback" ? "/?error=callback" : "/");
}
