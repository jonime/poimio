"use client";

import {
  ChevronDownIcon,
  LogOutIcon,
  RssIcon,
  SlidersHorizontalIcon,
  UserRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { useRef } from "react";
import { signOut } from "@/app/auth/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function UserMenu({ displayName }: { displayName: string | null | undefined }) {
  const firstName = displayName?.trim().split(/\s+/)[0];
  const signOutFormRef = useRef<HTMLFormElement | null>(null);

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          render={<Button variant="ghost" aria-label="User menu" title={firstName ?? "Account"} />}
        >
          <UserRoundIcon data-icon="inline-start" aria-hidden="true" />
          {firstName && <span className="hidden sm:inline">{firstName}</span>}
          <ChevronDownIcon className="hidden sm:block" data-icon="inline-end" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuLinkItem render={<Link href="/preferences/tune" />} closeOnClick>
              <SlidersHorizontalIcon data-icon="inline-start" aria-hidden="true" />
              Tune feed
            </DropdownMenuLinkItem>
            <DropdownMenuLinkItem render={<Link href="/preferences/sources" />} closeOnClick>
              <RssIcon data-icon="inline-start" aria-hidden="true" />
              Sources
            </DropdownMenuLinkItem>
            <DropdownMenuItem onClick={() => signOutFormRef.current?.requestSubmit()}>
              <LogOutIcon data-icon="inline-start" aria-hidden="true" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <form ref={signOutFormRef} action={signOut} className="hidden" />
    </>
  );
}
