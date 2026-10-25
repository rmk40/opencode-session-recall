// Run with Bun: bun scripts/test-v1-host.mjs /path/to/opencode-v1
// Uses V1's real loader and in-process HTTP API, never its managed service.
/* global Bun, AbortController */
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath, URL } from "node:url";

if (!process.argv[2]) throw new Error("Pass the path to an OpenCode V1 source checkout");
const host = path.resolve(process.argv[2], "packages/opencode");
const originalDirectory = process.cwd();
const pluginDirectory = fileURLToPath(new URL("..", import.meta.url));
const scratch = await mkdtemp(
  path.join(
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp/opencode") : tmpdir(),
    "recall-v1-",
  ),
);
for (const [variable, subdir] of Object.entries({
  XDG_DATA_HOME: "data",
  XDG_CACHE_HOME: "cache",
  XDG_CONFIG_HOME: "config",
  XDG_STATE_HOME: "state",
  OPENCODE_TEST_HOME: "home",
  OPENCODE_TEST_MANAGED_CONFIG_DIR: "managed",
})) {
  process.env[variable] = path.join(scratch, subdir);
  await mkdir(process.env[variable], { recursive: true });
}
process.env.OPENCODE_DB = ":memory:";
process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ plugin: [] });
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "true";
process.env.OPENCODE_MODELS_PATH = path.join(host, "test/tool/fixtures/models-api.json");
for (const key of [
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
])
  delete process.env[key];
process.chdir(scratch);
const fromHost = (file) => import(pathToFileURL(path.join(host, file)).href);
const { createPluginEntry, readV1Plugin } = await fromHost("src/plugin/shared.ts");
const entry = await createPluginEntry(pluginDirectory, pluginDirectory, "server");
assert.ok(entry.entry, "V1 directory loader must find the built entrypoint");
const definition = readV1Plugin(await import(entry.entry), pluginDirectory, "server");
assert.equal(definition.id, "opencode-session-recall");
const { Server } = await fromHost("src/server/server.ts");
const { HttpApiApp } = await fromHost("src/server/routes/instance/httpapi/server.ts");
const { AppRuntime } = await fromHost("src/effect/app-runtime.ts");
const { createOpencodeClient } = await import("@opencode-ai/sdk");
const client = createOpencodeClient({
  baseUrl: "http://recall-v1.test",
  directory: scratch,
  fetch: (request) => Server.Default().app.fetch(request),
});
const active = [];
try {
  const created = await client.session.create({ body: { title: "V1 real host recall needle" } });
  assert.equal(created.error, undefined, JSON.stringify(created.error));
  assert.ok(created.data?.id);
  for (const mode of ["ephemeral", "persistent"]) {
    const hooks = await definition.server(
      {
        client,
        directory: scratch,
        worktree: scratch,
        project: {},
        serverUrl: new URL("http://recall-v1.test"),
      },
      {
        mode,
        coldPass: false,
        storePath: path.join(scratch, "recall.db"),
      },
    );
    active.push(hooks);
    assert.equal(Object.keys(hooks.tool).length, 5);
    const context = {
      sessionID: created.data.id,
      messageID: "msg_probe",
      agent: "build",
      directory: scratch,
      worktree: scratch,
      abort: new AbortController().signal,
      metadata() {},
      async ask() {},
    };
    const sessions = JSON.parse(
      await hooks.tool.recall_sessions.execute({ scope: "project", limit: 10 }, context),
    );
    assert.equal(sessions.ok, true, JSON.stringify(sessions));
    assert.ok(sessions.sessions.some((session) => session.id === created.data.id));
    const messages = JSON.parse(
      await hooks.tool.recall_messages.execute({ sessionID: created.data.id, limit: 2 }, context),
    );
    assert.equal(messages.ok, true, JSON.stringify(messages));
    await hooks.dispose();
    console.log(`V1 loader + real API passed (${mode}): five tools, sessions, messages, cleanup`);
  }
} finally {
  await Promise.all(active.map((hooks) => hooks.dispose?.()));
  await client.instance.dispose();
  await HttpApiApp.webHandler().dispose();
  await AppRuntime.dispose();
  Bun.gc(true);
  process.chdir(originalDirectory);
  await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
