import { describe, expect, it } from "vitest";
import type { Part } from "@opencode-ai/sdk/v2";
import {
  CLEARED_TOOL_OUTPUT,
  decodeRow,
  identityOf,
  projectMessage,
  projectSession,
  resolveIdentity,
  sessionContext,
  type SessionContext,
  type UserIdentity,
  type V2MessageRow,
  type V2SessionRow,
} from "../src/history/v2-project.js";
import { formatMsg, pruned, searchableFields, isSelfToolPart } from "../src/extract.js";
import { distillFields } from "../src/distill.js";
import { classifyAuthorship } from "../src/authorship.js";

const SESSION: V2SessionRow = {
  id: "ses_1",
  project_id: "prj_1",
  parent_id: null,
  slug: "brave-fox",
  directory: "/work/app",
  title: "Session title",
  version: "2.0.18",
  agent: "build",
  model: JSON.stringify({ id: "m-default", providerID: "p-default" }),
  time_created: 1_000,
  time_updated: 2_000,
  time_idle: 5_000,
  time_archived: null,
  project_name: null,
  project_worktree: "/work/app/",
};

const CTX: SessionContext = sessionContext(SESSION);
const WHO: UserIdentity = { agent: "plan", model: { id: "m-user", providerID: "p-user" } };

let seq = 0;
function row(type: string, data: unknown, id = `msg_${++seq}`): V2MessageRow {
  return {
    id,
    session_id: "ses_1",
    type,
    seq,
    time_created: 10_000 + seq,
    time_updated: 20_000 + seq,
    data: typeof data === "string" ? data : JSON.stringify(data),
  };
}

function project(type: string, data: unknown, id?: string) {
  const decoded = decodeRow(row(type, data, id));
  if (!decoded.ok) throw new Error(decoded.reason);
  return projectMessage(decoded, CTX, WHO);
}

function tool(name: string, state: unknown, time: unknown = { created: 1, completed: 2 }) {
  return { type: "tool", id: "call_shared", name, state, time };
}

describe("projectSession", () => {
  it("maps columns and normalizes recency and project name", () => {
    const s = projectSession(SESSION);
    expect(s).toMatchObject({
      id: "ses_1",
      slug: "brave-fox",
      projectID: "prj_1",
      directory: "/work/app",
      title: "Session title",
      agent: "build",
      model: { id: "m-default", providerID: "p-default" },
      time: { created: 1_000, updated: 5_000 },
      project: { id: "prj_1", name: "app", worktree: "/work/app/" },
    });
    expect("parentID" in s).toBe(false);
    expect("archived" in s.time).toBe(false);
  });

  it("keeps time_updated when idle is NULL or older, and carries parent/archived", () => {
    const s = projectSession({
      ...SESSION,
      time_idle: null,
      parent_id: "ses_0",
      title: null,
      model: "not json",
      time_archived: 9,
      project_name: "named",
    });
    expect(s.time).toEqual({ created: 1_000, updated: 2_000, archived: 9 });
    expect(s.parentID).toBe("ses_0");
    expect(s.title).toBe("");
    expect(s.model).toBeUndefined();
    expect(s.project?.name).toBe("named");
    expect(projectSession({ ...SESSION, time_idle: 1_500 }).time.updated).toBe(2_000);
  });
});

describe("projectMessage", () => {
  it("user: text, file and agent parts with synthesized identity", () => {
    const msg = project(
      "user",
      {
        text: "please fix it",
        files: [{ mime: "image/png", name: "shot.png", data: "AAAA" }, { mime: "text/plain" }],
        agents: [{ name: "explore" }],
        time: { created: 1 },
      },
      "msg_u",
    )!;
    expect(msg.info).toMatchObject({
      id: "msg_u",
      role: "user",
      agent: "plan",
      model: { providerID: "p-user", modelID: "m-user" },
    });
    expect(msg.parts.map((p) => [p.id, p.type])).toEqual([
      ["msg_u:t", "text"],
      ["msg_u:f0", "file"],
      ["msg_u:f1", "file"],
      ["msg_u:a0", "agent"],
    ]);
    expect(msg.parts[1]).toMatchObject({ filename: "shot.png", url: "" });
    expect(msg.parts[2]).toMatchObject({ filename: "text/plain" });
    // formatMsg dereferences info.model.modelID.
    expect(formatMsg(msg).message).toMatchObject({ role: "user", agent: "plan", model: "m-user" });
  });

  it("user: attached skills become completed skill tool parts after the text", () => {
    const msg = project(
      "user",
      {
        text: "use the skill",
        skills: [
          { id: "sk_1", name: "tuistory", text: "skill body" },
          { id: "sk_2", name: "bare" },
        ],
      },
      "msg_s",
    )!;
    expect(msg.parts.map((p) => [p.id, p.type])).toEqual([
      ["msg_s:t", "text"],
      ["msg_s:s0", "tool"],
      ["msg_s:s1", "tool"],
    ]);
    expect(msg.parts[1]).toMatchObject({
      tool: "skill",
      state: { status: "completed", input: { id: "sk_1", name: "tuistory" }, output: "skill body" },
    });
    expect(msg.parts[2]).toMatchObject({ state: { output: "" } });
  });

  it("user: an empty text emits no text part", () => {
    expect(project("user", { text: "", time: { created: 1 } })!.parts).toEqual([]);
  });

  it("synthetic: a flagged text part", () => {
    const msg = project("synthetic", { text: "<recall-auto> x" }, "msg_s")!;
    expect(msg.info.role).toBe("user");
    expect(msg.parts).toEqual([
      {
        id: "msg_s:0",
        sessionID: "ses_1",
        messageID: "msg_s",
        type: "text",
        text: "<recall-auto> x",
        synthetic: true,
      },
    ]);
    // The recall-auto sentinel stays unsearchable.
    expect(searchableFields(msg.parts[0]!)).toEqual([]);
  });

  it("skill: a completed skill tool part with id and name", () => {
    const msg = project("skill", { skill: "sk_1", name: "tuistory", text: "body" }, "msg_k")!;
    expect(msg.info.role).toBe("user");
    expect(msg.parts[0]).toMatchObject({
      id: "msg_k:0",
      type: "tool",
      tool: "skill",
      state: { status: "completed", input: { id: "sk_1", name: "tuistory" }, output: "body" },
    });
  });

  it("shell: completed only when exited with code 0", () => {
    const ok = project("shell", {
      command: "ls",
      status: "exited",
      exit: 0,
      output: { output: "a b" },
    })!;
    expect(ok.parts[0]).toMatchObject({
      tool: "shell",
      state: { status: "completed", input: { command: "ls" }, output: "a b" },
    });
    const failed = project("shell", {
      command: "x",
      status: "exited",
      exit: 2,
      output: { output: "" },
    })!;
    expect(failed.parts[0]).toMatchObject({
      state: { status: "error", error: "shell exited (exit 2)" },
    });
    const killed = project("shell", {
      command: "x",
      status: "killed",
      output: { output: "partial" },
    })!;
    expect(killed.parts[0]).toMatchObject({ state: { status: "error", error: "partial" } });
    const running = project("shell", { command: "x", status: "running" })!;
    expect(running.parts[0]).toMatchObject({ state: { status: "running" } });
  });

  it("assistant: one part per content item with positional ids", () => {
    const msg = project(
      "assistant",
      {
        agent: "build",
        model: { id: "m-a", providerID: "p-a" },
        content: [
          { type: "reasoning", text: "think" },
          { type: "text", text: "answer" },
          { type: "future-kind", x: 1 },
          tool("read", { status: "streaming", input: '{"pa' }),
          tool("bash", { status: "running", input: { command: "go" }, metadata: {} }),
        ],
        time: { created: 1, completed: 9 },
        cost: 0.5,
        finish: "stop",
      },
      "msg_a",
    )!;
    expect(msg.info).toMatchObject({
      role: "assistant",
      agent: "build",
      modelID: "m-a",
      providerID: "p-a",
      cost: 0.5,
      finish: "stop",
      time: { completed: 9 },
      path: { cwd: "/work/app" },
    });
    expect(msg.parts.map((p) => p.id)).toEqual(["msg_a:0", "msg_a:1", "msg_a:3", "msg_a:4"]);
    expect(msg.parts[2]).toMatchObject({ state: { status: "pending", input: {} } });
    expect(msg.parts[3]).toMatchObject({ state: { status: "running", input: { command: "go" } } });
    expect(msg.parts.every((p) => !p.id.includes("#"))).toBe(true);
  });

  it("assistant tool completed: text joined, files dropped, only toolCalls kept", () => {
    const msg = project("assistant", {
      content: [
        tool("execute", {
          status: "completed",
          input: { code: "x" },
          content: [
            { type: "text", text: "one" },
            { type: "file", uri: "data:image/png;base64,AAAA", mime: "image/png" },
            { type: "text", text: "two" },
          ],
          metadata: { toolCalls: [{ tool: "srv.recall", status: "completed" }], other: 1 },
        }),
      ],
    })!;
    const part = msg.parts[0]!;
    expect(part).toMatchObject({
      tool: "execute",
      state: {
        status: "completed",
        output: "one\ntwo",
        title: "",
        metadata: { toolCalls: [{ tool: "srv.recall", status: "completed" }] },
        time: { start: 1, end: 2 },
      },
    });
    expect(JSON.stringify(part)).not.toContain("other");
    expect(pruned(part)).toBe(false);
    expect(isSelfToolPart(part)).toBe(true);
  });

  it("assistant tool running: keeps only toolCalls from metadata", () => {
    const msg = project("assistant", {
      content: [
        tool("execute", {
          status: "running",
          input: { code: "x" },
          metadata: { toolCalls: [{ tool: "srv.recall", status: "running" }], other: 1 },
        }),
      ],
    })!;
    const part = msg.parts[0]!;
    expect(part).toMatchObject({
      state: {
        status: "running",
        metadata: { toolCalls: [{ tool: "srv.recall", status: "running" }] },
      },
    });
    expect(JSON.stringify(part)).not.toContain("other");
    expect(isSelfToolPart(part)).toBe(true);
  });

  it("assistant tool cleared marker: pruned, empty output, out of every index", () => {
    const msg = project("assistant", {
      content: [
        tool("bash", {
          status: "completed",
          input: { command: "npm test" },
          content: [{ type: "text", text: CLEARED_TOOL_OUTPUT }],
        }),
      ],
    })!;
    const part = msg.parts[0]!;
    expect(pruned(part)).toBe(true);
    expect(part).toMatchObject({ state: { output: "", time: { compacted: 2 } } });
    expect(JSON.stringify(searchableFields(part))).not.toContain(CLEARED_TOOL_OUTPUT);
    // The input stays indexed.
    expect(distillFields(part).some((f) => f.text === "npm test")).toBe(true);
  });

  it("assistant tool error: flattened to error.message", () => {
    const msg = project("assistant", {
      content: [
        tool("bash", {
          status: "error",
          input: { command: "x" },
          error: { type: "unknown", message: "boom: failed" },
        }),
        tool("bash", { status: "error", input: {}, error: { type: "only-type" } }),
      ],
    })!;
    expect(msg.parts[0]).toMatchObject({ state: { status: "error", error: "boom: failed" } });
    expect(msg.parts[1]).toMatchObject({ state: { error: "only-type" } });
  });

  it("compaction: completed only, marker plus summary text", () => {
    const done = project(
      "compaction",
      { status: "completed", reason: "auto", summary: "the summary", recent: "tail" },
      "msg_c",
    )!;
    expect(done.info.role).toBe("assistant");
    expect(done.parts.map((p) => [p.id, p.type])).toEqual([
      ["msg_c:c", "compaction"],
      ["msg_c:s", "text"],
    ]);
    expect(done.parts[0]).toMatchObject({ auto: true });
    expect(JSON.stringify(done)).not.toContain("tail");
    expect(
      project("compaction", { status: "running", reason: "manual", summary: "" }),
    ).toBeUndefined();
    expect(project("compaction", { status: "failed", reason: "manual" })).toBeUndefined();
  });

  it("non-content types project to nothing", () => {
    for (const type of [
      "system",
      "idle",
      "agent-switched",
      "model-switched",
      "location-switched",
      "new",
    ]) {
      expect(project(type, { text: "x", time: { created: 1 } }), type).toBeUndefined();
    }
  });

  it("decodeRow reports bad JSON and non-objects", () => {
    expect(decodeRow(row("user", "{nope")).ok).toBe(false);
    expect(decodeRow(row("user", "[1]")).ok).toBe(false);
    const decoded = decodeRow(
      row("user", { id: "spoof", type: "assistant", text: "t" }, "msg_real"),
    );
    if (!decoded.ok) throw new Error("expected ok");
    // Columns win over data keys.
    expect(projectMessage(decoded, CTX, WHO)!.info).toMatchObject({ id: "msg_real", role: "user" });
  });
});

describe("user identity resolution", () => {
  it("takes each field from the first candidate that has it, then the session", () => {
    const decodedSwitch = decodeRow(row("agent-switched", { agent: "review" }));
    const decodedAssistant = decodeRow(
      row("assistant", { agent: "build", model: { id: "m-x", providerID: "p-x" }, content: [] }),
    );
    if (!decodedSwitch.ok || !decodedAssistant.ok) throw new Error("decode");
    expect(resolveIdentity([identityOf(decodedSwitch), identityOf(decodedAssistant)], CTX)).toEqual(
      {
        agent: "review",
        model: { id: "m-x", providerID: "p-x" },
      },
    );
    expect(resolveIdentity([], CTX)).toEqual({
      agent: "build",
      model: { id: "m-default", providerID: "p-default" },
    });
    expect(resolveIdentity([], { ...CTX, agent: null, model: null })).toEqual({
      agent: "",
      model: { id: "", providerID: "" },
    });
  });
});

describe("authorship over projected parts", () => {
  function classify(part: Part, role: "user" | "assistant", parentID: string | null) {
    return classifyAuthorship({
      partType: part.type,
      role,
      synthetic: part.type === "text" ? part.synthetic : undefined,
      parentID,
    });
  }

  it("follows v2 message types", () => {
    const user = project("user", {
      text: "hi",
      files: [{ mime: "a/b" }],
      agents: [{ name: "x" }],
      skills: [{ id: "sk", name: "s", text: "skill body" }],
    })!;
    expect(user.parts.map((p) => classify(p, "user", null))).toEqual([
      "human",
      "injected",
      "injected",
      "injected",
    ]);
    expect(classify(user.parts[0]!, "user", "ses_parent")).toBe("delegated");
    expect(classify(project("synthetic", { text: "s" })!.parts[0]!, "user", null)).toBe("injected");
    expect(
      classify(project("skill", { skill: "a", name: "b", text: "c" })!.parts[0]!, "user", null),
    ).toBe("injected");
    expect(
      classify(
        project("shell", { command: "a", status: "exited", exit: 0 })!.parts[0]!,
        "user",
        null,
      ),
    ).toBe("injected");
    expect(
      classify(
        project("assistant", { content: [{ type: "text", text: "t" }] })!.parts[0]!,
        "assistant",
        null,
      ),
    ).toBe("model");
  });
});
