"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLinkItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
            render={<Link href={item.href} aria-current={current ? "page" : undefined} />}
          >
            {item.label}
          </Button>
        );
      })}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger render={<Button variant="ghost" />}>More</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuLinkItem render={<Link href="/about" />} closeOnClick>
              About
            </DropdownMenuLinkItem>
            <DropdownMenuLinkItem render={<Link href="/contact" />} closeOnClick>
              Contact
            </DropdownMenuLinkItem>
            <DropdownMenuLinkItem render={<Link href="/privacy" />} closeOnClick>
              Privacy policy
            </DropdownMenuLinkItem>
            <DropdownMenuLinkItem href="https://github.com/jonime/poimio" closeOnClick>
              GitHub
            </DropdownMenuLinkItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );
}
