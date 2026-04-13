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
