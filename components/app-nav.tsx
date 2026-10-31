"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";

const navItems = [
  { href: "/", label: "Feed" },
  { href: "/liked", label: "Liked" },
] as const;

export function AppNav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1" aria-label="Main navigation">
      {navItems.map((item) => {
        const current = item.href === pathname;
        return (
          <Button
            key={item.href}
            variant={current ? "default" : "ghost"}
            nativeButton={false}
            render={
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
              />
            }
          >
            {item.label}
          </Button>
        );
      })}
    </nav>
  );
}
