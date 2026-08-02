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
          finalise(assistantId, String(err));
          return;
        }
      }

      finalise(assistantId);
    },
    [messages]
  );

  function handleEvent(assistantId: string, event: ChatEvent) {
    switch (event.type) {
      case "token":
        appendToken(assistantId, event.text);
        break;
      case "sources":
        setSources(assistantId, event.items);
        break;
      case "tool_call":
        console.log("tool_call", event.name, event.args);
        break;
      case "done":
        finalise(assistantId);
        break;
      case "error":
        finalise(assistantId, event.message);
        break;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    setIsStreaming(false);
    setMessages((prev) =>
      prev.map((m) =>
        m.isStreaming ? { ...m, isStreaming: false } : m
      )
    );
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
