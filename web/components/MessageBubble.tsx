import type { Message } from "@/lib/types";
import { SourceList } from "./SourceList";

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div
      data-testid={isUser ? "bubble-user" : "bubble-assistant"}
      className={`max-w-[80%] rounded-lg px-4 py-2 text-sm ${
        isUser
          ? "ml-auto bg-blue-600 text-white"
          : "mr-auto bg-gray-100 text-gray-900"
      }`}
    >
      <p className="whitespace-pre-wrap">
        {message.content}
        {message.isStreaming && (
          <span
            aria-label="Streaming indicator"
            className="ml-1 inline-block h-3 w-1 animate-pulse bg-current"
          />
        )}
      </p>
      {message.sources && message.sources.length > 0 && (
        <SourceList sources={message.sources} />
      )}
    </div>
  );
}
