"use client";

import { SlidersHorizontalIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  MAX_ACTIVE_PREFERENCES,
  MAX_PREFERENCE_REQUEST_CHARS,
  PREFERENCE_DAILY_LIMIT,
  PREFERENCE_LIMIT_MESSAGE,
} from "@/lib/preference-tuning";
import { deletePreference, flipPreference, tunePreferences } from "../../preferences/actions";

export interface PreferenceListItem {
  id: string;
  label: string;
  direction: "more" | "less";
}

const capMessage = "You can have at most 20 preferences. Delete one to add more.";

function rowMessage(message: string): string {
  return message === "not found" ? "That preference is no longer available." : message;
}

export function PreferencesForm({
  items,
  remaining,
}: {
  items: PreferenceListItem[];
  remaining: number | null;
}) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState<PreferenceListItem[]>([]);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [directions, setDirections] = useState<Readonly<Record<string, "more" | "less">>>({});
  const [requestRemaining, setRequestRemaining] = useState(remaining);
  const [tunePending, setTunePending] = useState(false);
  const [tuneError, setTuneError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});

  const visible = [
    ...saved.filter((item) => !items.some((current) => current.id === item.id)),
    ...items,
  ]
    .filter((item) => !removed.has(item.id))
    .map((item) => {
      const direction = directions[item.id];
      return direction === undefined ? item : { ...item, direction };
    });
  const atCap = visible.length >= MAX_ACTIVE_PREFERENCES;
  const noRequestsLeft = requestRemaining === 0;
  const tuneDisabled =
    tunePending ||
    atCap ||
    noRequestsLeft ||
    text.trim().length === 0 ||
    text.length > MAX_PREFERENCE_REQUEST_CHARS;

  async function onTune(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (tuneDisabled) return;
    setTunePending(true);
    setTuneError(null);
    const result = await tunePreferences(text);
    setTunePending(false);
    if (result.remaining !== null) setRequestRemaining(result.remaining);
    if (!result.ok) {
      setTuneError(result.message);
      return;
    }
    setText("");
    setSaved((current) => [...result.preferences, ...current]);
  }

  async function onFlip(item: PreferenceListItem) {
    if (pendingId) return;
    const direction = item.direction === "more" ? "less" : "more";
    setPendingId(item.id);
    setRowErrors((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    const result = await flipPreference(item.id, direction);
    setPendingId(null);
    if (!result.ok) {
      setRowErrors((current) => ({ ...current, [item.id]: rowMessage(result.message) }));
      return;
    }
    setDirections((current) => ({ ...current, [item.id]: direction }));
  }

  async function onDelete(item: PreferenceListItem) {
    if (pendingId) return;
    setPendingId(item.id);
    setRowErrors((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    const result = await deletePreference(item.id);
    setPendingId(null);
    if (!result.ok) {
      setRowErrors((current) => ({ ...current, [item.id]: rowMessage(result.message) }));
      return;
    }
    setRemoved((current) => new Set(current).add(item.id));
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {requestRemaining === null
          ? "The remaining request count is unavailable."
          : `${requestRemaining} of ${PREFERENCE_DAILY_LIMIT} requests left.`}
      </p>
      {noRequestsLeft && (
        <Alert variant="destructive">
          <AlertTitle>{PREFERENCE_LIMIT_MESSAGE}</AlertTitle>
        </Alert>
      )}
      {atCap && (
        <Alert>
          <AlertTitle>{capMessage}</AlertTitle>
        </Alert>
      )}
      <form className="flex flex-col gap-4" onSubmit={onTune} aria-busy={tunePending}>
        <FieldGroup>
          <Field data-invalid={tuneError ? true : undefined}>
            <FieldLabel htmlFor="preference-request">Tune feed</FieldLabel>
            <Textarea
              id="preference-request"
              name="request"
              value={text}
              maxLength={MAX_PREFERENCE_REQUEST_CHARS}
              aria-invalid={tuneError ? true : undefined}
              disabled={tunePending || atCap || noRequestsLeft}
              placeholder="More science, less celebrity gossip"
              onChange={(event) => setText(event.target.value)}
            />
            <FieldDescription>
              {`${text.length} / ${MAX_PREFERENCE_REQUEST_CHARS}. Saved preferences apply the next time you load or refresh the feed.`}
            </FieldDescription>
            {tuneError && (
              <Alert variant="destructive">
                <AlertTitle>{tuneError}</AlertTitle>
              </Alert>
            )}
          </Field>
          <Field>
            <Button type="submit" disabled={tuneDisabled}>
              {tunePending && <Spinner data-icon="inline-start" />}
              {tunePending ? "Tuning feed..." : "Tune feed"}
            </Button>
          </Field>
        </FieldGroup>
      </form>
      {visible.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SlidersHorizontalIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No preferences yet</EmptyTitle>
            <EmptyDescription>
              Describe a subject you want more or less of. The feed uses it after the next refresh.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col gap-3">
          {visible.map((item) => {
            const pending = pendingId === item.id;
            const error = rowErrors[item.id];
            return (
              <li key={item.id}>
                <Card>
                  <CardHeader>
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                      <span className="break-words">{item.label}</span>
                      <Badge variant={item.direction === "more" ? "default" : "secondary"}>
                        {item.direction}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      aria-label={`Flip ${item.label} to ${item.direction === "more" ? "less" : "more"}`}
                      onClick={() => onFlip(item)}
                    >
                      {pending && <Spinner data-icon="inline-start" />}
                      {item.direction === "more" ? "Want less" : "Want more"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      aria-label={`Delete ${item.label}`}
                      onClick={() => onDelete(item)}
                    >
                      Delete
                    </Button>
                  </CardContent>
                  {error && (
                    <CardFooter>
                      <Alert variant="destructive">
                        <AlertTitle>{error}</AlertTitle>
                      </Alert>
                    </CardFooter>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
