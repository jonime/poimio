"use client";

import type { ComponentProps, ReactNode } from "react";

export function TrackedItemLink({
  itemId,
  onOpenItem,
  children,
  href,
  ...props
}: Omit<ComponentProps<"a">, "href"> & {
  href: string;
  itemId: string;
  onOpenItem: (itemId: string) => void;
  children: ReactNode;
}) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        if (event.button === 0) onOpenItem(itemId);
      }}
      onAuxClick={(event) => {
        if (event.button === 1) onOpenItem(itemId);
      }}
    >
      {children}
    </a>
  );
}
