"use server";

import { revalidatePath } from "next/cache";
import { getSourceDiscoveryAdminUserId } from "@/lib/source-discovery-access";
import { type CatalogScanResult, scanInactiveCatalog } from "@/lib/source-discovery-scan";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

export type CatalogScanActionResult =
  | { ok: true; result: CatalogScanResult }
  | { ok: false; error: "not_found" | "scan_failed" };

export type CandidateDecisionStatus =
  | "approved"
  | "rejected"
  | "unchanged"
  | "already_decided"
  | "already_known"
  | "stale"
  | "not_found";

export type CandidateDecisionActionResult =
  | { ok: true; status: CandidateDecisionStatus }
  | { ok: false; error: "not_found" | "invalid_request" | "decision_failed" };

export async function scanCatalog(): Promise<CatalogScanActionResult> {
  const userClient = await createClient();
  const adminUserId = await getSourceDiscoveryAdminUserId(userClient);
  if (!adminUserId) return { ok: false, error: "not_found" };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("source_discovery_scan_failed: missing OPENAI_API_KEY");
    return { ok: false, error: "scan_failed" };
  }

  try {
    const result = await scanInactiveCatalog(createServiceRoleClient(), apiKey, adminUserId);
    revalidatePath("/admin/sources");
    return { ok: true, result };
  } catch (error) {
    console.error("source_discovery_scan_failed", error);
    return { ok: false, error: "scan_failed" };
  }
}

export async function decideCandidate(
  candidateId: unknown,
  decision: unknown,
): Promise<CandidateDecisionActionResult> {
  if (
    typeof candidateId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidateId,
    ) ||
    (decision !== "approve" && decision !== "reject")
  ) {
    return { ok: false, error: "invalid_request" };
  }

  const userClient = await createClient();
  const adminUserId = await getSourceDiscoveryAdminUserId(userClient);
  if (!adminUserId) return { ok: false, error: "not_found" };

  const { data, error } = await createServiceRoleClient().rpc("decide_source_candidate", {
    p_candidate_id: candidateId,
    p_decision: decision,
  });
  if (error) {
    console.error("source_discovery_decision_failed", error);
    return { ok: false, error: "decision_failed" };
  }

  if (
    data !== "approved" &&
    data !== "rejected" &&
    data !== "unchanged" &&
    data !== "already_decided" &&
    data !== "already_known" &&
    data !== "stale" &&
    data !== "not_found"
  ) {
    console.error("source_discovery_decision_failed: unexpected database result");
    return { ok: false, error: "decision_failed" };
  }

  revalidatePath("/admin/sources");
  if (data === "approved") {
    revalidatePath("/");
    revalidatePath("/preferences/sources");
  }
  return { ok: true, status: data };
}
