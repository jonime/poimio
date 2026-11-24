import { Buffer } from "node:buffer";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function completedResponseText(payload: unknown): string | null {
  if (!isRecord(payload) || payload.status !== "completed" || payload.error != null) {
    return null;
  }
  if (!Array.isArray(payload.output)) return null;
  const parts: string[] = [];
  for (const output of payload.output) {
    if (!isRecord(output)) return null;
    if (output.type === "reasoning") continue;
    if (
      output.type !== "message" ||
      output.status !== "completed" ||
      !Array.isArray(output.content)
    ) {
      return null;
    }
    for (const content of output.content) {
      if (
        !isRecord(content) ||
        content.type !== "output_text" ||
        typeof content.text !== "string"
      ) {
        return null;
      }
      parts.push(content.text);
    }
  }
  return parts.join("");
}

export async function readLimitedJson(response: Response, maxBytes: number): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > maxBytes) {
    await response.body?.cancel();
    throw new Error("response too large");
  }
  if (!response.body) throw new Error("missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
