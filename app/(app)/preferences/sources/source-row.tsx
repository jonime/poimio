"use client";

import { useId, useRef, useState } from "react";
import { setSourceVisible } from "@/app/feedback/actions";
import { Badge } from "@/components/ui/badge";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";

interface Source {
  id: string;
  name: string;
  language: string;
  kind: string;
  description: string | null;
}

export function SourceRow({ source, visible }: { source: Source; visible: boolean }) {
  const switchId = useId();
  const errorId = useId();
  const saving = useRef<boolean>(false);
  const [checked, setChecked] = useState(visible);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function changeVisibility(next: boolean) {
    if (saving.current) return;
    saving.current = true;
    setPending(true);
    setFailed(false);
    setChecked(next);

    try {
      const result = await setSourceVisible(source.id, next);
      if (result.ok) return;
    } catch {
      // A thrown action error also means the optimistic change must be reverted.
    } finally {
      saving.current = false;
      setPending(false);
    }
    setChecked(checked);
    setFailed(true);
  }

  return (
    <Field orientation="horizontal" data-disabled={pending}>
      <FieldContent className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <FieldLabel htmlFor={switchId} className="min-w-0 wrap-anywhere">
            {source.name}
          </FieldLabel>
          <Badge variant="secondary">{source.language}</Badge>
          {source.kind === "youtube" && <Badge variant="outline">Videos</Badge>}
        </div>
        {source.description && <FieldDescription>{source.description}</FieldDescription>}
        {failed && (
          <FieldError id={errorId}>Could not save this change. Please try again.</FieldError>
        )}
      </FieldContent>
      <Switch
        id={switchId}
        nativeButton
        render={<button type="button" />}
        aria-describedby={failed ? errorId : undefined}
        checked={checked}
        disabled={pending}
        onCheckedChange={changeVisibility}
      />
    </Field>
  );
}
