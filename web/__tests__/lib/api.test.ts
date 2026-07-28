import { describe, it, expect } from "vitest";
import { sendMessage } from "@/lib/api";
import type { ChatEvent, Message } from "@/lib/types";

const userMessage: Message = {
  id: "1",
  role: "user",
  content: "What is ISR?",
};

const collect = async (gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> => {
  const out: ChatEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
};

describe("sendMessage", () => {
  it("yields all events from the /api/chat SSE stream", async () => {
    const ac = new AbortController();
    const events = await collect(sendMessage([userMessage], ac.signal));

    expect(events).toHaveLength(4);
    expect(events[0]).toEqual({ type: "token", text: "Hello" });
    expect(events[1]).toEqual({ type: "token", text: " world" });
    expect(events[2]?.type).toBe("sources");
    expect(events[3]?.type).toBe("done");
  });

  it("stops yielding when signal is aborted", async () => {
    const ac = new AbortController();
    const gen = sendMessage([userMessage], ac.signal);

    const first = await gen.next();
    expect(first.value).toEqual({ type: "token", text: "Hello" });

    ac.abort();
    const second = await gen.next();
    expect(second.done).toBe(true);
  });
});
