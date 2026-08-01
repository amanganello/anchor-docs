import type { ChatEvent } from "./types";

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<ChatEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed === "" || trimmed.startsWith(":")) continue;

        if (trimmed.startsWith("data: ")) {
          const raw = trimmed.slice(6);
          try {
            const parsed: unknown = JSON.parse(raw);
            if (
              parsed !== null &&
              typeof parsed === "object" &&
              "type" in parsed &&
              typeof (parsed as { type: unknown }).type === "string"
            ) {
              yield parsed as ChatEvent;
            }
          } catch {
            // malformed line — skip
          }
        }
      }
    }

    // flush remaining buffer
    if (buffer.startsWith("data: ")) {
      try {
        const parsed: unknown = JSON.parse(buffer.slice(6));
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          "type" in parsed &&
          typeof (parsed as { type: unknown }).type === "string"
        ) {
          yield parsed as ChatEvent;
        }
      } catch {
        // ignore
      }
    }
  } finally {
    reader.releaseLock();
  }
}
