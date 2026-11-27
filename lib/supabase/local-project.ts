export function isLocalSupabaseProjectUrl(value: string): boolean {
  return value === "http://localhost:55321" || value === "http://127.0.0.1:55321";
}
