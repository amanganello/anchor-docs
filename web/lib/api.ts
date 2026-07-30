import { parseSSEStream } from "./stream";
import type { ChatEvent, Message } from "./types";

export async function* sendMessage(
  messages: Message[],
  signal: AbortSignal
): AsyncGenerator<ChatEvent> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (!res.ok || !res.body) {
    yield {
      type: "error",
      message: `HTTP ${res.status}: ${res.statusText}`,
    };
    return;
  }

  try {
    for await (const event of parseSSEStream(res.body)) {
      if (signal.aborted) return;
      yield event;
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") return;
    yield { type: "error", message: String(err) };
  }
}
