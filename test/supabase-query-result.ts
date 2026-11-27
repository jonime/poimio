function jsonValueEnd(output: string, start: number): number | null {
  const opening = output[start];
  if (opening !== "{" && opening !== "[") return null;
  const stack = [opening];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < output.length; index += 1) {
    const character = output[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push(character);
      continue;
    }
    if (character !== "}" && character !== "]") continue;
    const expected = character === "}" ? "{" : "[";
    if (stack.pop() !== expected) return null;
    if (stack.length === 0) return index + 1;
  }
  return null;
}

export function parseSupabaseQueryResult(output: string): { rows: unknown[] } {
  for (let searchFrom = 0; searchFrom < output.length; searchFrom += 1) {
    const nextObject = output.indexOf("{", searchFrom);
    const nextArray = output.indexOf("[", searchFrom);
    const candidates = [nextObject, nextArray].filter((index) => index >= 0);
    const start = Math.min(...candidates);
    if (!Number.isFinite(start)) break;
    const end = jsonValueEnd(output, start);
    if (end === null) continue;
    try {
      const value: unknown = JSON.parse(output.slice(start, end));
      if (Array.isArray(value)) return { rows: value };
      if (
        typeof value === "object" &&
        value !== null &&
        "rows" in value &&
        Array.isArray(value.rows)
      ) {
        return { rows: value.rows };
      }
    } catch {
      // Continue past log status objects and incomplete values.
    }
    searchFrom = end - 1;
  }
  throw new Error("Supabase CLI returned no JSON query rows.");
}
