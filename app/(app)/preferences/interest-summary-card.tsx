"use client";

import { CircleAlertIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
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
import { Spinner } from "@/components/ui/spinner";
import {
  INTEREST_SUMMARY_DAILY_LIMIT,
  INTEREST_SUMMARY_LIMIT_MESSAGE,
  type InterestSummary,
} from "@/lib/interest-summary-contract";
import { clearInterestSummary, summarizeInterests } from "../../preferences/actions";

function generatedLabel(generatedAt: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(generatedAt));
}

export function InterestSummaryCard({
  initialSummary,
  remaining,
  positiveSignalCount,
}: {
  initialSummary: InterestSummary | null;
  remaining: number | null;
  positiveSignalCount: number;
}) {
  const [summary, setSummary] = useState(initialSummary);
  const [requestRemaining, setRequestRemaining] = useState(remaining);
  const [pending, setPending] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enoughSignals = positiveSignalCount >= 3;
  const limitReached = requestRemaining === 0;
  const summarizeDisabled = pending || clearing || !enoughSignals || limitReached;

  async function summarize() {
    if (summarizeDisabled) return;
    setPending(true);
    setError(null);
    const result = await summarizeInterests();
    setPending(false);
    if (result.remaining !== null) setRequestRemaining(result.remaining);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSummary({
      summary: result.summary,
      topics: result.topics,
      likeCount: result.likeCount,
      generatedAt: result.generatedAt,
    });
  }

  async function clear() {
    if (!summary || pending || clearing) return;
    setClearing(true);
    setError(null);
    const result = await clearInterestSummary();
    setClearing(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSummary(null);
  }

  return (
    <Card aria-busy={pending || clearing}>
      <CardHeader>
        <CardTitle>Your interests</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <div className="flex items-start gap-2 text-sm text-destructive" role="alert">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>{error}</p>
          </div>
        )}
        {summary ? (
          <div className="flex flex-col gap-3">
            <p>{summary.summary}</p>
            {summary.topics.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {summary.topics.map((topic) => (
                  <Badge key={topic} variant="secondary">
                    {topic}
                  </Badge>
                ))}
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              Based on {summary.likeCount} likes,{" "}
              <time dateTime={summary.generatedAt}>{generatedLabel(summary.generatedAt)}</time>
            </p>
          </div>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SparklesIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No interest summary yet</EmptyTitle>
              <EmptyDescription>
                Create a short profile from your recent likes, dislikes, and feed preferences.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {!enoughSignals && (
          <p className="text-sm text-muted-foreground">
            Like at least 3 items or add at least 3 positive preferences before creating a summary.
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {requestRemaining === null
            ? "The remaining request count is unavailable."
            : `${requestRemaining} of ${INTEREST_SUMMARY_DAILY_LIMIT} requests left.`}
        </p>
        {limitReached && (
          <p className="text-sm text-destructive" role="alert">
            {INTEREST_SUMMARY_LIMIT_MESSAGE}
          </p>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button type="button" disabled={summarizeDisabled} onClick={() => void summarize()}>
          {pending && <Spinner data-icon="inline-start" />}
          {pending ? "Summarizing..." : "Summarize my interests"}
        </Button>
        {summary && (
          <Button
            type="button"
            variant="outline"
            disabled={pending || clearing}
            onClick={() => void clear()}
          >
            {clearing && <Spinner data-icon="inline-start" />}
            {clearing ? "Clearing..." : "Clear"}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
