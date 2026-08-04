import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatInput } from "@/components/ChatInput";

describe("ChatInput", () => {
  it("renders the textarea and Send button when not streaming", () => {
    render(
      <ChatInput onSubmit={vi.fn()} onStop={vi.fn()} isStreaming={false} />
    );
    expect(
      screen.getByRole("textbox", { name: "Message input" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stop generation" })
    ).not.toBeInTheDocument();
  });

  it("renders the Stop button and hides Send when streaming", () => {
    render(
      <ChatInput onSubmit={vi.fn()} onStop={vi.fn()} isStreaming={true} />
    );
    expect(
      screen.getByRole("button", { name: "Stop generation" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Send" })
    ).not.toBeInTheDocument();
  });

  it("calls onSubmit with the typed value and clears the input", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ChatInput onSubmit={onSubmit} onStop={vi.fn()} isStreaming={false} />
    );

    const textarea = screen.getByRole("textbox", { name: "Message input" });
    await user.type(textarea, "Hello there");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).toHaveBeenCalledWith("Hello there");
    expect(textarea).toHaveValue("");
  });

  it("submits on Enter key (without Shift)", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ChatInput onSubmit={onSubmit} onStop={vi.fn()} isStreaming={false} />
    );

    const textarea = screen.getByRole("textbox", { name: "Message input" });
    await user.type(textarea, "Hi{Enter}");

    expect(onSubmit).toHaveBeenCalledWith("Hi");
  });

  it("does not submit on Shift+Enter", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ChatInput onSubmit={onSubmit} onStop={vi.fn()} isStreaming={false} />
    );

    const textarea = screen.getByRole("textbox", { name: "Message input" });
    await user.type(textarea, "line one{Shift>}{Enter}{/Shift}line two");

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit empty input", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ChatInput onSubmit={onSubmit} onStop={vi.fn()} isStreaming={false} />
    );

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onStop when Stop button is clicked", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(
      <ChatInput onSubmit={vi.fn()} onStop={onStop} isStreaming={true} />
    );

    await user.click(screen.getByRole("button", { name: "Stop generation" }));
    expect(onStop).toHaveBeenCalledOnce();
  });
});
