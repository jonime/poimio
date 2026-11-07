import { LogOutIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { signOut } from "@/app/auth/actions";
import { AppNav } from "@/components/app-nav";
import { Button } from "@/components/ui/button";

export function AppHeader({
  displayName,
  guest = false,
}: {
  displayName?: string | null;
  guest?: boolean;
}) {
  const firstName = displayName?.trim().split(/\s+/)[0];

  return (
    <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-2xl items-center gap-2 px-3 sm:gap-4 sm:px-4">
        <Link
          href="/"
          aria-label="Poimio home"
          className="flex shrink-0 items-center gap-2 font-medium"
        >
          <Image src="/icon.png" alt="" width={1254} height={1254} className="size-7" />
          <span className="hidden sm:inline">Poimio</span>
        </Link>
        {guest ? (
          <nav aria-label="Main navigation">
            <Button variant="ghost" nativeButton={false} render={<Link href="/" />}>
              Home
            </Button>
          </nav>
        ) : (
          <>
            <AppNav />
            <div className="ml-auto flex min-w-0 items-center gap-2">
              {firstName && (
                <span className="hidden truncate text-sm text-muted-foreground md:inline">
                  {firstName}
                </span>
              )}
              <form action={signOut}>
                <Button variant="ghost" type="submit">
                  <LogOutIcon
                    className="hidden sm:block"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                  Sign out
                </Button>
              </form>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
