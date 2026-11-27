"use client";

import { CircleAlertIcon, ScanSearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import type { CatalogScanResult } from "@/lib/source-discovery-scan";
import type { CandidateDecisionStatus } from "./actions";
import { decideCandidate, scanCatalog } from "./actions";

export interface CandidateRow {
  id: string;
  origin: "catalog" | "web_search";
  name: string;
  feed_url: string;
  site_url: string | null;
  kind: "rss" | "youtube";
  language: "fi" | "en";
  status: "pending" | "failed" | "approved" | "rejected";
  failure: string | null;
  item_count: number | null;
  items_per_day: number | string | null;
  relevance: "high" | "medium" | "low" | "not_scored";
  relevance_basis: "all_users" | "admin" | null;
  mean_match_share: number | string | null;
  duplicate_share: number | string | null;
  sample_titles: string[];
  scanned_at: string | null;
  decided_at: string | null;
}

export interface DiscoveryRunRow {
  id: string;
  kind: "catalog" | "web_search";
  started_at: string;
  finished_at: string | null;
  status: "running" | "completed" | "partial" | "failed";
  failures: unknown;
}

interface AdminSourcesReviewProps {
  pending: CandidateRow[];
  failed: CandidateRow[];
  decided: CandidateRow[];
  latestRun: DiscoveryRunRow | null;
}

const decisionMessages: Record<CandidateDecisionStatus, string> = {
  approved: "Source approved.",
  rejected: "Candidate rejected.",
  unchanged: "That decision was already recorded.",
  already_decided: "This candidate has already been decided.",
  already_known: "This feed URL is already a source. The candidate remains pending.",
  stale: "The catalog source changed. The candidate remains pending.",
  not_found: "Candidate not found.",
};

export function AdminSourcesReview({
  pending,
  failed,
  decided,
  latestRun,
}: AdminSourcesReviewProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busyAction, setBusyAction] = useState<"scan" | "decision" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function runCatalogScan() {
    setMessage(null);
    setError(null);
    setBusyAction("scan");
    startTransition(async () => {
      try {
        const result = await scanCatalog();
        if (!result.ok) {
          setError("The catalog scan could not be started. Please try again.");
        } else {
          setMessage(scanMessage(result.result));
        }
      } catch {
        setError("The catalog scan could not be started. Please try again.");
      } finally {
        setBusyAction(null);
        router.refresh();
      }
    });
  }

  function makeDecision(candidateId: string, decision: "approve" | "reject") {
    setMessage(null);
    setError(null);
    setBusyAction("decision");
    startTransition(async () => {
      try {
        const result = await decideCandidate(candidateId, decision);
        if (!result.ok) {
          setError("The decision could not be saved. Please try again.");
        } else {
          setMessage(decisionMessages[result.status]);
        }
      } catch {
        setError("The decision could not be saved. Please try again.");
      } finally {
        setBusyAction(null);
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Source discovery</h1>
          <p className="text-sm text-muted-foreground">
            Review inactive catalog sources before they enter the shared feed.
          </p>
        </div>
        <Button onClick={runCatalogScan} disabled={isPending}>
          <ScanSearchIcon data-icon="inline-start" aria-hidden="true" />
          {busyAction === "scan" ? "Scanning…" : "Scan catalog"}
        </Button>
      </header>

      {latestRun && (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Last run: {formatDate(latestRun.started_at)} · {latestRun.status}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      )}

      <CandidateTable
        title="Pending candidates"
        candidates={pending}
        emptyTitle="No pending candidates"
        emptyDescription="Scan the catalog to find sources to review."
        onDecision={makeDecision}
        disabled={isPending}
      />

      {failed.length > 0 && (
        <CandidateTable
          title="Failed candidates"
          candidates={failed}
          emptyTitle=""
          emptyDescription=""
          onDecision={makeDecision}
          disabled
          showActions={false}
          showFailure
        />
      )}

      {decided.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            Approved and rejected ({decided.length})
          </summary>
          <div className="pt-3">
            <CandidateTable
              title="Approved and rejected candidates"
              candidates={decided}
              emptyTitle=""
              emptyDescription=""
              onDecision={makeDecision}
              disabled
              showActions={false}
            />
          </div>
        </details>
      )}
    </div>
  );
}

function CandidateTable({
  title,
  candidates,
  emptyTitle,
  emptyDescription,
  onDecision,
  disabled,
  showActions = true,
  showFailure = false,
}: {
  title: string;
  candidates: CandidateRow[];
  emptyTitle: string;
  emptyDescription: string;
  onDecision: (candidateId: string, decision: "approve" | "reject") => void;
  disabled: boolean;
  showActions?: boolean;
  showFailure?: boolean;
}) {
  if (candidates.length === 0) {
    return (
      <Empty className="rounded-lg border">
        <EmptyHeader>
          <EmptyTitle>{emptyTitle}</EmptyTitle>
          <EmptyDescription>{emptyDescription}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <div className="flex flex-col gap-3">
        {candidates.map((candidate) => {
          const metrics = [
            {
              label: "Relevance",
              value: (
                <div className="flex flex-col items-start gap-1">
                  <Badge variant={relevanceVariant(candidate.relevance)}>
                    {candidate.relevance}
                  </Badge>
                  {candidate.relevance_basis === "admin" && (
                    <span className="text-xs text-muted-foreground">based on your likes</span>
                  )}
                </div>
              ),
            },
            { label: "Match", value: formatShare(candidate.mean_match_share) },
            { label: "Duplicate", value: formatShare(candidate.duplicate_share) },
            { label: "Items/day", value: formatNumber(candidate.items_per_day) },
            ...(showFailure ? [{ label: "Failure", value: candidate.failure ?? "unknown" }] : []),
          ];

          return (
            <Card key={candidate.id} role="group" aria-label={candidate.name} className="gap-4">
              <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 flex-col gap-2">
                  <CardTitle className="break-words [overflow-wrap:anywhere]">
                    {candidate.name}
                  </CardTitle>
                  <SafeSiteLink siteUrl={candidate.site_url} />
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="outline">{candidate.origin}</Badge>
                    <Badge variant="secondary">{candidate.language}</Badge>
                    {candidate.status !== "pending" && (
                      <Badge variant="outline">{candidate.status}</Badge>
                    )}
                  </div>
                </div>
                {showActions && (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => onDecision(candidate.id, "approve")}
                      disabled={disabled}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onDecision(candidate.id, "reject")}
                      disabled={disabled}
                    >
                      Reject
                    </Button>
                  </div>
                )}
              </CardHeader>
              <CardContent className="flex min-w-0 flex-col gap-4">
                <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                  {metrics.map((metric) => (
                    <div key={metric.label} className="min-w-0">
                      <dt className="text-xs text-muted-foreground">{metric.label}</dt>
                      <dd className="mt-1 break-words text-sm">{metric.value}</dd>
                    </div>
                  ))}
                </dl>
                <div className="min-w-0">
                  <h3 className="mb-1 text-xs font-medium text-muted-foreground">Recent titles</h3>
                  <ul className="flex list-disc flex-col gap-1 pl-4">
                    {candidate.sample_titles.map((sampleTitle, index) => (
                      <li
                        key={`${index}:${sampleTitle}`}
                        className="break-words [overflow-wrap:anywhere]"
                      >
                        {sampleTitle}
                      </li>
                    ))}
                  </ul>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function SafeSiteLink({ siteUrl }: { siteUrl: string | null }) {
  if (!siteUrl) return null;
  try {
    const url = new URL(siteUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return null;
    }
    return (
      <a href={url.href} target="_blank" rel="noreferrer" className="break-all text-sm underline">
        {siteUrl}
      </a>
    );
  } catch {
    return null;
  }
}

function relevanceVariant(relevance: CandidateRow["relevance"]) {
  if (relevance === "high") return "default";
  if (relevance === "low") return "destructive";
  return "secondary";
}

function formatShare(value: number | string | null): string {
  if (value === null) return "—";
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number * 100)}%` : "—";
}

function formatNumber(value: number | string | null): string {
  if (value === null) return "—";
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "—";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}

function scanMessage(result: CatalogScanResult): string {
  if (result.status === "scan_running") return "A source discovery scan is already running.";
  if (result.status === "partial") {
    return `Scan partially completed: ${result.processed} processed, ${result.failed} failed.`;
  }
  return `Scan completed: ${result.processed} processed, ${result.failed} failed.`;
}
