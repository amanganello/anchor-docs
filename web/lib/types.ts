export type ChatRole = "user" | "assistant";

export interface Source {
  title: string;
  url: string;
  heading: string;
}

export interface Message {
  id: string;
  role: ChatRole;
  content: string;
  sources?: Source[];
  isStreaming?: boolean;
}

export interface TokenEvent {
  type: "token";
  text: string;
}

export interface SourcesEvent {
  type: "sources";
  items: Source[];
}

export interface ToolCallEvent {
  type: "tool_call";
  name: string;
  args: Record<string, unknown>;
}

export interface DoneEvent {
  type: "done";
  usage: {
    input_tokens: number;
    output_tokens: number;
    latency_ms: number;
  };
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export type ChatEvent =
  | TokenEvent
  | SourcesEvent
  | ToolCallEvent
  | DoneEvent
  | ErrorEvent;
