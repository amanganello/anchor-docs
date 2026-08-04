"use client";

import { useRef, type FormEvent, type KeyboardEvent } from "react";

interface ChatInputProps {
  onSubmit: (value: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

export function ChatInput({
  onSubmit,
  onStop,
  isStreaming,
  disabled = false,
}: ChatInputProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  function handleSubmit(e?: FormEvent) {
    e?.preventDefault();
    const value = ref.current?.value.trim() ?? "";
    if (!value) return;
    onSubmit(value);
    if (ref.current) ref.current.value = "";
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex gap-2 items-end border-t border-gray-200 pt-3"
    >
      <textarea
        ref={ref}
        aria-label="Message input"
        rows={3}
        className="flex-1 resize-none rounded border border-gray-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        placeholder="Ask about Next.js…"
        onKeyDown={handleKeyDown}
        disabled={disabled || isStreaming}
      />
      {isStreaming ? (
        <button
          type="button"
          aria-label="Stop generation"
          onClick={onStop}
          className="rounded bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600"
        >
          Stop
        </button>
      ) : (
        <button
          type="submit"
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          disabled={disabled}
        >
          Send
        </button>
      )}
    </form>
  );
}
