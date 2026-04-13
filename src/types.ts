export const TOOLS = [
  "recall",
  "recall_get",
  "recall_sessions",
  "recall_context",
  "recall_messages",
] as const;

export type SearchResult = {
  sessionID: string;
  sessionTitle: string;
  directory: string;
  messageID: string;
  role: "user" | "assistant";
  time: number;
  partID: string;
  partType: string;
  pruned: boolean;
  snippet: string;
  toolName?: string;
};

export type SearchOutput = {
  ok: true;
  results: SearchResult[];
  scanned: number;
  total: number;
  truncated: boolean;
};

export type MessageOutput = {
  ok: true;
  message: {
    id: string;
    role: "user" | "assistant";
    time: number;
    agent?: string;
    model?: string;
  };
  parts: PartOutput[];
  context: {
    sessionTitle?: string;
    directory?: string;
  };
};

export type PartOutput = {
  id: string;
  type: string;
  pruned: boolean;
  content?: string;
  toolName?: string;
  title?: string;
  input?: unknown;
  output?: string;
  error?: string;
};

export type MessageItem = {
  message: {
    id: string;
    role: "user" | "assistant";
    time: number;
    agent?: string;
    model?: string;
  };
  parts: PartOutput[];
  center?: boolean;
};

export type ContextOutput = {
  ok: true;
  messages: MessageItem[];
  context: {
    sessionTitle?: string;
    directory?: string;
  };
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
};

export type MessagesOutput = {
  ok: true;
  messages: MessageItem[];
  context: {
    sessionTitle?: string;
    directory?: string;
  };
  pagination: {
    offset: number;
    returned: number;
    total: number;
    hasMore: boolean;
  };
};

export type SessionItem = {
  id: string;
  title: string;
  directory: string;
  project?: { name?: string; worktree: string };
  time: { created: number; updated: number };
  archived: boolean;
};

export type SessionsOutput = {
  ok: true;
  sessions: SessionItem[];
  returned: number;
  scope: string;
};

export type ErrorOutput = {
  ok: false;
  error: string;
};

export function errmsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "data" in e) {
    const data = (e as any).data;
    if (data?.message) return data.message;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
