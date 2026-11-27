import Image from "next/image";
import Link from "next/link";
import { AppNav } from "@/components/app-nav";
import { UserMenu } from "@/components/user-menu";

export function AppHeader({
  displayName,
  guest = false,
  isAdmin = false,
}: {
  displayName?: string | null;
  guest?: boolean;
  isAdmin?: boolean;
}) {
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
        <AppNav guest={guest} />
        {!guest && (
          <div className="ml-auto flex min-w-0 items-center">
            <UserMenu displayName={displayName} isAdmin={isAdmin} />
          </div>
        )}
      </div>
    </header>
  );
}
