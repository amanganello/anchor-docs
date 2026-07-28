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
            const event = JSON.parse(raw) as ChatEvent;
            yield event;
          } catch {
            // malformed line — skip
          }
        }
      }
    }

    // flush remaining buffer
    if (buffer.startsWith("data: ")) {
      try {
        const event = JSON.parse(buffer.slice(6)) as ChatEvent;
        yield event;
      } catch {
        // ignore
      }
    }
  } finally {
    reader.releaseLock();
  }
}
