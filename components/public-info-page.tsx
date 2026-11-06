import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

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
    <main className="min-h-svh bg-background px-6 py-10 sm:py-16">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-10">
        <header className="flex flex-col items-start gap-6">
          <Link href="/" aria-label="Poimio home">
            <Image
              src="/full.png"
              alt="Poimio"
              width={2172}
              height={724}
              priority
              className="h-auto w-40"
            />
          </Link>
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl font-semibold">{title}</h1>
            {subtitle}
          </div>
        </header>

        <article className="flex flex-col gap-8 text-sm leading-7 [&_h2]:text-lg [&_h2]:font-semibold [&_section]:flex [&_section]:flex-col [&_section]:gap-3 [&_a]:underline [&_a]:underline-offset-4 [&_a]:break-words [&_ul]:list-disc [&_ul]:pl-5">
          {children}
        </article>

        <footer>
          <Link href="/" className="text-sm underline underline-offset-4">
            Back to Poimio
          </Link>
        </footer>
      </div>
    </main>
  );
}
