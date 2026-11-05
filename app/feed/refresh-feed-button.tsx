"use client";

import { RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export function RefreshFeedButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    // GET form keeps refresh working without JavaScript.
    <form
      action="/"
      method="get"
      onSubmit={(event) => {
        event.preventDefault();
        window.scrollTo({ top: 0 });
        startTransition(() => router.refresh());
      }}
    >
      <Button variant="outline" type="submit" disabled={pending}>
        {pending ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
        )}
        Refresh feed
      </Button>
    </form>
  );
}
