"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function GuestHeader({ children }: { children: ReactNode }) {
  // The public homepage has its own branding above the sign-in controls.
  return usePathname() === "/" ? null : children;
}
