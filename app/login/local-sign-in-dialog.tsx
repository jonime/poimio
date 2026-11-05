"use client";

import { KeyRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { PasswordSignInForm } from "./password-sign-in-form";

export function LocalSignInDialog() {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="fixed right-3 bottom-3 text-muted-foreground"
          />
        }
      >
        <KeyRoundIcon data-icon="inline-start" aria-hidden="true" />
        Local sign-in
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Local sign-in</DialogTitle>
          <DialogDescription>Email and password for local Supabase test users.</DialogDescription>
        </DialogHeader>
        <PasswordSignInForm />
      </DialogContent>
    </Dialog>
  );
}
