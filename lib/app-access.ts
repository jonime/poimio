export function getAppAccessRedirect(isVerifiedUser: boolean): "/" | null {
  if (!isVerifiedUser) return "/";
  return null;
}

export function displayNameFromClaims(claims: unknown): string | undefined {
  if (typeof claims !== "object" || claims === null) return undefined;
  const record = claims as Record<string, unknown>;
  const metadata = typeof record.user_metadata === "object" && record.user_metadata !== null
    ? record.user_metadata as Record<string, unknown> : {};
  return [metadata.full_name, metadata.name, metadata.display_name, record.name]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
}
