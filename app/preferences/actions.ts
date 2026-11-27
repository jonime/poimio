"use server";

import { revalidatePath } from "next/cache";
import type {
  InterestSummaryServiceClient,
  InterestSummaryUserClient,
} from "../../lib/interest-summary.ts";
import {
  clearInterestSummaryForUser,
  summarizeInterestsForUser,
} from "../../lib/interest-summary.ts";
import type {
  PreferenceServiceClient,
  PreferenceUserClient,
  TunePreferencesResult,
} from "../../lib/preference-tuning.ts";
import {
  deletePreferenceForUser,
  flipPreferenceForUser,
  tunePreferencesForUser,
} from "../../lib/preference-tuning.ts";
import { createClient } from "../../lib/supabase/server.ts";
import { createServiceRoleClient } from "../../lib/supabase/service-role.ts";

function userClient(client: Awaited<ReturnType<typeof createClient>>): PreferenceUserClient {
  return client as unknown as PreferenceUserClient;
}

function revalidatePreferences(): void {
  revalidatePath("/");
  revalidatePath("/preferences/tune");
}

function interestSummaryUserClient(
  client: Awaited<ReturnType<typeof createClient>>,
): InterestSummaryUserClient {
  return client as unknown as InterestSummaryUserClient;
}

export async function summarizeInterests() {
  const result = await summarizeInterestsForUser({
    userClient: interestSummaryUserClient(await createClient()),
    createServiceClient: () => createServiceRoleClient() as unknown as InterestSummaryServiceClient,
    apiKey: process.env.OPENAI_API_KEY ?? "",
  });
  if (result.ok) revalidatePreferences();
  return result;
}

export async function clearInterestSummary() {
  const result = await clearInterestSummaryForUser({
    userClient: interestSummaryUserClient(await createClient()),
  });
  if (result.ok) revalidatePreferences();
  return result;
}

export async function tunePreferences(text: unknown): Promise<TunePreferencesResult> {
  const result = await tunePreferencesForUser({
    text,
    userClient: userClient(await createClient()),
    createServiceClient: () => createServiceRoleClient() as unknown as PreferenceServiceClient,
    apiKey: process.env.OPENAI_API_KEY ?? "",
  });
  if (result.ok) revalidatePreferences();
  return result;
}

export async function flipPreference(
  preferenceId: unknown,
  direction: unknown,
): Promise<Awaited<ReturnType<typeof flipPreferenceForUser>>> {
  const result = await flipPreferenceForUser({
    userClient: userClient(await createClient()),
    preferenceId,
    direction,
  });
  if (result.ok) revalidatePreferences();
  return result;
}

export async function deletePreference(
  preferenceId: unknown,
): Promise<Awaited<ReturnType<typeof deletePreferenceForUser>>> {
  const result = await deletePreferenceForUser({
    userClient: userClient(await createClient()),
    preferenceId,
  });
  if (result.ok) revalidatePreferences();
  return result;
}
