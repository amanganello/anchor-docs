import type { ChatEvent } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSource(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.url === "string" &&
    typeof value.heading === "string"
  );
}

export function isChatEvent(value: unknown): value is ChatEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;

  switch (value.type) {
    case "token":
      return typeof value.text === "string";
    case "sources":
      return Array.isArray(value.items) && value.items.every(isSource);
    case "tool_call":
      return (
        typeof value.name === "string" &&
        isRecord(value.args)
      );
    case "done":
      return (
        isRecord(value.usage) &&
        isNonNegativeNumber(value.usage.input_tokens) &&
        isNonNegativeNumber(value.usage.output_tokens) &&
        isNonNegativeNumber(value.usage.latency_ms)
      );
    case "error":
      return typeof value.message === "string";
    default:
      return false;
  }
}

function parseDataLine(line: string): ChatEvent | null {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith("data: ")) return null;

  try {
    const parsed: unknown = JSON.parse(trimmed.slice(6));
    return isChatEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<ChatEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reachedEnd = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEnd = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed === "" || trimmed.startsWith(":")) continue;

        const event = parseDataLine(trimmed);
        if (event) yield event;
      }
    }

    buffer += decoder.decode();
    const event = parseDataLine(buffer);
    if (event) yield event;
  } finally {
    if (!reachedEnd) {
      // Some fetch implementations do not settle cancellation promptly. Start
      // it without blocking generator cleanup, and contain any cleanup error.
      void reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}
