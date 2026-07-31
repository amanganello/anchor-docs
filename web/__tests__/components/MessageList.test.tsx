import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageList } from "@/components/MessageList";
import type { Message } from "@/lib/types";

describe("MessageList", () => {
  it("renders empty state without errors", () => {
    render(<MessageList messages={[]} />);
    expect(screen.getByTestId("message-list")).toBeInTheDocument();
  });

  it("renders a bubble for each message", () => {
    const messages: Message[] = [
      { id: "1", role: "user", content: "Hi" },
      { id: "2", role: "assistant", content: "Hello" },
    ];
    render(<MessageList messages={messages} />);
    expect(screen.getByTestId("bubble-user")).toBeInTheDocument();
    expect(screen.getByTestId("bubble-assistant")).toBeInTheDocument();
  });

  it("has role=log and aria-live=polite", () => {
    render(<MessageList messages={[]} />);
    const list = screen.getByRole("log");
    expect(list).toHaveAttribute("aria-live", "polite");
  });
});
