"use client";

import { useCallback, useRef, useState } from "react";
import type { Message, Source, ChatEvent } from "@/lib/types";
import { sendMessage } from "@/lib/api";
import { ChatInput } from "./ChatInput";
import { MessageList } from "./MessageList";

export function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  function appendToken(id: string, text: string) {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id ? { ...m, content: m.content + text } : m
      )
    );
  }

  function setSources(id: string, sources: Source[]) {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, sources } : m))
    );
  }

  function finalise(id: string, errorMsg?: string) {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id
          ? {
              ...m,
              isStreaming: false,
              content: errorMsg ? `Error: ${errorMsg}` : m.content,
            }
          : m
      )
    );
    setIsStreaming(false);
  }

  const handleSubmit = useCallback(
    async (value: string) => {
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: value,
      };
      const assistantId = crypto.randomUUID();
      const assistantMsg: Message = {
        id: assistantId,
        role: "assistant",
        content: "",
        isStreaming: true,
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);

      const ac = new AbortController();
      abortRef.current = ac;

      function handleEvent(id: string, event: ChatEvent) {
        switch (event.type) {
          case "token":
            appendToken(id, event.text);
            break;
          case "sources":
            setSources(id, event.items);
            break;
          case "tool_call":
            console.log("tool_call", event.name, event.args);
            break;
          case "done":
            // cleanup is owned by finally; nothing to do here
            break;
          case "error":
            // set error content; cleanup is owned by finally
            setMessages((prev) =>
              prev.map((m) =>
                m.id === id ? { ...m, content: `Error: ${event.message}` } : m
              )
            );
            break;
        }
      }

      try {
        for await (const event of sendMessage(
          [...messages, userMsg],
          ac.signal
        )) {
          if (ac.signal.aborted) break;
          handleEvent(assistantId, event);
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: `Error: ${String(err)}` }
                : m
            )
          );
        }
      } finally {
        // Single cleanup owner: only finalise if this request is still active.
        // If a newer Submit has run, abortRef.current !== ac, so we skip.
        if (abortRef.current === ac) {
          finalise(assistantId);
        }
      }
    },
    [messages]
  );

  function handleStop() {
    abortRef.current?.abort();
  }

  return (
    <div className="mx-auto flex h-screen w-full max-w-2xl flex-col px-4 py-6">
      <h1 className="mb-4 text-lg font-semibold text-gray-800">Anchor Docs</h1>
      <MessageList messages={messages} />
      <ChatInput
        onSubmit={handleSubmit}
        onStop={handleStop}
        isStreaming={isStreaming}
      />
    </div>
  );
}
