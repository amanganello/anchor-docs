import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageBubble } from "@/components/MessageBubble";
import type { Message } from "@/lib/types";

describe("MessageBubble", () => {
  it("renders user message content", () => {
    const msg: Message = { id: "1", role: "user", content: "Hello" };
    render(<MessageBubble message={msg} />);
    expect(screen.getByTestId("bubble-user")).toHaveTextContent("Hello");
  });

  it("renders assistant message content", () => {
    const msg: Message = { id: "2", role: "assistant", content: "World" };
    render(<MessageBubble message={msg} />);
    expect(screen.getByTestId("bubble-assistant")).toHaveTextContent("World");
  });

  it("shows streaming indicator when status is streaming", () => {
    const msg: Message = {
      id: "3",
      role: "assistant",
      content: "Thinking",
      status: "streaming",
    };
    render(<MessageBubble message={msg} />);
    expect(
      screen.getByLabelText("Streaming indicator")
    ).toBeInTheDocument();
  });

  it("does not show streaming indicator when status is complete", () => {
    const msg: Message = {
      id: "4",
      role: "assistant",
      content: "Done",
      status: "complete",
    };
    render(<MessageBubble message={msg} />);
    expect(
      screen.queryByLabelText("Streaming indicator")
    ).not.toBeInTheDocument();
  });
});
