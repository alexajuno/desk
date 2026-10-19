// desk's session host: it holds the Claude Code sessions desk's panel talks to, each one Claude Code run through the
// Agent SDK (one `claude` process per session, fed messages as they come and read as data), so that desk can draw a
// session as a chat. It runs on its own, apart from desk's server: desk restarts on every Try, and a turn running inside
// it would be cut off. desk starts it (hosted.ts) in a systemd scope of its own, which desk.service's restart leaves alone,
// and talks to it over a unix socket. Run: node apps/server/src/host.ts --socket <path>.
//
// The session's transcript (~/.claude/projects/<folder>/<id>.jsonl) stays the record, written by Claude Code as always:
// desk reads the finished messages there. What only the host knows it sends over each session's event stream: the words
// as they stream, whether a turn runs, and the questions waiting on the user.
//
//     {"type": "hello", "working": true, "since": <ms>, "partial": [<block>, ...], "asks": [...], "tasks": [...], "status": …}
//                                                                                             first, on connect
//     {"type": "stream", "msg": "msg_…", "index": 0, "kind": "text", "text": "…"}            a piece of a block
//     {"type": "message", "entry": <the SDK's assistant or user message>}                    a block done
//     {"type": "working", "working": false, "since": <ms>}                                    a turn began or ended
//     {"type": "asks", "asks": [<ask>, ...]}                                                  the questions changed
//     {"type": "tasks", "tasks": [<task>, ...]}                                               what runs now changed
//     {"type": "status", "status": <status> | null}                                           a retry, a compaction, a limit
//     {"type": "closed", "error": "…"}                                                        the process ended
//
// An <ask> is {id, tool, input}: a tool call Claude Code wants the user's yes to, or AskUserQuestion's questions.
// A <task> is something Claude Code runs beside the conversation: a subagent, a background command, a watch (Task).
// A <status> is what holds the turn up, which the panel's working line says: {kind: "retry" | "compacting" | "limit", …}.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { query, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";

const SOCKET = process.argv[process.argv.indexOf("--socket") + 1];
if (!SOCKET || process.argv.indexOf("--socket") < 0) throw new Error("usage: node host.ts --socket <path>");
// desk compares this with its own copy of the file, and restarts the host while nothing works when they differ.
const VERSION = createHash("sha1").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex").slice(0, 12);
// The user's own Claude Code, the one their terminal runs, rather than the copy the SDK's package carries.
const CLAUDE = execFileSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim();
const IDLE_CLOSE = 20 * 60_000; // ms an idle session with nobody watching keeps its process; it resumes on its next message
// The longest Claude may ask a background command to run: a day. Claude Code counts an SDK session as unattended and
// stops its background commands after 30 minutes, or the timeout Claude asks for up to 2 hours, unless this raises the
// ceiling; it leaves the 30-minute default and the foreground timeouts as they are
// (https://code.claude.com/docs/en/tools-reference#time-limit-for-background-commands).
const LONGEST_COMMAND = String(24 * 3600_000);

interface Ask {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  answer: (result: PermissionResult) => void;
}

interface Block {
  msg: string;
  index: number;
  kind: string; // text, thinking or tool_use
  text: string;
  name?: string; // a tool's
}

// Something Claude Code runs beside the conversation, as its task_* events tell: a subagent (local_agent), a background
// command (local_bash), a watch or a workflow.
interface Task {
  id: string;
  tool?: string; // the tool call that started it, whose step the conversation shows
  kind: string;
  description: string;
  agent?: string; // a subagent's type
  background: boolean; // false for a subagent the turn waits on
  since: number;
  doing?: string; // its latest step, as "Running Count entries"
  steps?: number; // a subagent's tool calls so far
}

type Status = { kind: "retry"; error: string; attempt: number; of: number; until: number } | { kind: "compacting" } | { kind: "limit"; resets?: number };

interface Session {
  id: string;
  cwd: string;
  title: string;
  q: Query;
  inbox: SDKUserMessage[]; // messages not yet read by Claude Code
  wake: (() => void) | null;
  working: boolean;
  since: number; // when it last started or finished a turn
  asks: Map<string, Ask>;
  tasks: Map<string, Task>; // what runs now, by task id
  status: Status | null;
  partial: Map<string, Block>; // the blocks streaming now, by message and index
  watchers: Set<WebSocket>;
  closed: boolean;
  ended: Promise<void>; // once its process has exited
  streaming: string; // the id of the reply streaming now, which its blocks' events leave out
}

const sessions = new Map<string, Session>();

export interface StartOptions {
  id?: string;
  resume?: boolean;
  cwd: string;
  title?: string;
  append?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "auto" | "dontAsk";
  disallowedTools?: string[];
  additionalDirectories?: string[];
  agent?: string; // one of the user's agents (~/.claude/agents), as `claude --agent` runs it: its prompt, tools and model
  settings?: Record<string, unknown>;
  message?: Content;
}

type Content = string | Record<string, unknown>[];

function send(s: Session, event: Record<string, unknown>) {
  const text = JSON.stringify(event);
  for (const ws of s.watchers) ws.send(text);
}

const asksOf = (s: Session) => [...s.asks.values()].map(({ id, tool, input }) => ({ id, tool, input }));
const tasksOf = (s: Session) => [...s.tasks.values()];

function setStatus(s: Session, status: Status | null) {
  if (!status && !s.status) return;
  s.status = status;
  send(s, { type: "status", status });
}

function setWorking(s: Session, working: boolean) {
  if (s.working === working) return;
  s.working = working;
  s.since = Date.now();
  send(s, { type: "working", working, since: s.since });
}

// The messages Claude Code reads, one at a time, as the user sends them; it reads the next while a turn runs and folds
// it in, as Enter does in its terminal.
async function* inbox(s: Session): AsyncGenerator<SDKUserMessage> {
  while (!s.closed) {
    const next = s.inbox.shift();
    if (next) {
      setWorking(s, true);
      yield next;
      continue;
    }
    await new Promise<void>((r) => (s.wake = r));
    s.wake = null;
  }
}

// The uuid, when the panel gave one, is how the message is taken back while it waits (withdraw).
function userMessage(content: Content, uuid?: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: content as never }, parent_tool_use_id: null, session_id: "", origin: { kind: "human" }, ...(uuid ? { uuid } : {}) } as SDKUserMessage;
}

function start(o: StartOptions): Session {
  const id = o.id ?? randomUUID();
  const s: Session = { id, cwd: o.cwd, title: o.title ?? "", q: null as unknown as Query, inbox: [], wake: null, working: false, since: Date.now(),
    asks: new Map(), tasks: new Map(), status: null, partial: new Map(), watchers: new Set(), closed: false, ended: Promise.resolve(), streaming: "" };
  // The first message waits in the inbox before the SDK first reads it, which it does as query() starts.
  if (o.message) s.inbox.push(userMessage(o.message));
  s.q = query({
    prompt: inbox(s),
    options: {
      cwd: o.cwd,
      ...(o.resume ? { resume: id } : { sessionId: id }),
      ...(o.title && !o.resume ? { title: o.title } : {}),
      systemPrompt: { type: "preset", preset: "claude_code", ...(o.append ? { append: o.append } : {}) },
      tools: { type: "preset", preset: "claude_code" },
      ...(o.model ? { model: o.model } : {}),
      ...(o.effort ? { effort: o.effort } : {}),
      ...(o.permissionMode ? { permissionMode: o.permissionMode } : {}),
      ...(o.disallowedTools?.length ? { disallowedTools: o.disallowedTools } : {}),
      ...(o.additionalDirectories?.length ? { additionalDirectories: o.additionalDirectories } : {}),
      ...(o.agent ? { agent: o.agent } : {}),
      ...(o.settings ? { settings: o.settings } : {}),
      includePartialMessages: true,
      pathToClaudeCodeExecutable: CLAUDE,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "desk", BASH_MAX_TIMEOUT_MS: LONGEST_COMMAND },
      // A tool call Claude Code wants a yes for, and every AskUserQuestion, waits here for the user's answer in the panel.
      canUseTool: (tool, input, { signal, toolUseID }) => new Promise<PermissionResult>((resolve) => {
        const askId = toolUseID ?? randomUUID();
        const done = (result: PermissionResult) => {
          if (!s.asks.delete(askId)) return;
          send(s, { type: "asks", asks: asksOf(s) });
          resolve(result);
        };
        s.asks.set(askId, { id: askId, tool, input, answer: done });
        send(s, { type: "asks", asks: asksOf(s) });
        signal.addEventListener("abort", () => done({ behavior: "deny", message: "The user stopped the turn." }));
      }),
    },
  });
  sessions.set(id, s);
  s.ended = read(s);
  return s;
}

// Read what Claude Code says until its process ends.
async function read(s: Session) {
  let error = "";
  try {
    for await (const m of s.q) take(s, m);
  } catch (e) {
    error = (e as Error).message;
    console.error(`desk host: ${s.id}: ${error}`);
  } finally {
    s.closed = true;
    s.wake?.();
    for (const ask of s.asks.values()) ask.answer({ behavior: "deny", message: "The session ended." });
    if (sessions.get(s.id) === s) sessions.delete(s.id);
    send(s, { type: "closed", error });
    for (const ws of s.watchers) ws.close();
  }
}

// What Claude Code runs beside the conversation, kept from its task events (tried on 19 Oct: a background command and
// a background subagent each sent task_started, background_tasks_changed, then task_updated and task_notification as
// they ended; the subagent sent task_progress at each of its tool calls). Housekeeping tasks Claude Code marks ambient
// stay out, and so do those a subagent started: the panel shows what the conversation started.
function track(s: Session, e: Record<string, any>) {
  const before = JSON.stringify(tasksOf(s));
  if (e.subtype === "task_started" && !e.ambient && !e.parent_task_id) {
    s.tasks.set(e.task_id, { id: e.task_id, tool: e.tool_use_id, kind: e.task_type ?? "", description: e.description, agent: e.subagent_type,
      background: Boolean(e.is_backgrounded), since: Date.now() });
  } else if (e.subtype === "task_progress") {
    const t = s.tasks.get(e.task_id);
    if (t) Object.assign(t, { doing: e.description, steps: e.usage?.tool_uses });
  } else if (e.subtype === "task_updated") {
    const t = s.tasks.get(e.task_id);
    if (["completed", "failed", "killed"].includes(e.patch?.status)) s.tasks.delete(e.task_id);
    else if (t && e.patch?.is_backgrounded !== undefined) t.background = e.patch.is_backgrounded;
  } else if (e.subtype === "task_notification") s.tasks.delete(e.task_id);
  else if (e.subtype === "background_tasks_changed") {
    // Every background task there is now: one the turn waited on and that moved to the background is in it too.
    const now = new Map((e.tasks as Record<string, any>[]).filter((t) => !t.ambient && !t.parent_task_id).map((t) => [t.task_id, t]));
    for (const t of s.tasks.values()) if (t.background && !now.has(t.id)) s.tasks.delete(t.id);
    for (const [id, t] of now) {
      const known = s.tasks.get(id);
      if (known) known.background = true;
      else s.tasks.set(id, { id, kind: t.task_type, description: t.description, agent: t.subagent_type, background: true, since: Date.now() });
    }
  } else return;
  if (JSON.stringify(tasksOf(s)) !== before) send(s, { type: "tasks", tasks: tasksOf(s) });
}

function take(s: Session, m: SDKMessage) {
  // A turn Claude starts on its own, such as when a task it left running in the background finishes, works too.
  if ((m.type === "stream_event" || m.type === "assistant") && !m.parent_tool_use_id) {
    setWorking(s, true);
    if (s.status?.kind !== "compacting") setStatus(s, null); // the reply came: no longer retrying or held by a limit
  }
  if (m.type === "system") {
    const e = m as Record<string, any>;
    if (e.subtype === "api_retry") setStatus(s, { kind: "retry", error: e.error, attempt: e.attempt, of: e.max_retries, until: Date.now() + e.retry_delay_ms });
    else if (e.subtype === "status") {
      if (e.status === "compacting") setStatus(s, { kind: "compacting" });
      else if (s.status?.kind === "compacting") setStatus(s, null);
    }
    else track(s, e);
    return;
  }
  if (m.type === "rate_limit_event" && m.rate_limit_info.status === "rejected") setStatus(s, { kind: "limit", resets: m.rate_limit_info.resetsAt });
  if (m.type === "stream_event") {
    if (m.parent_tool_use_id) return; // a subagent's: the panel shows only its Agent step
    const e = m.event as { type: string; index?: number; message?: { id: string }; content_block?: { type: string; name?: string }; delta?: Record<string, string> };
    if (e.type === "message_start") s.streaming = e.message!.id;
    else if (e.type === "content_block_start") {
      const b: Block = { msg: s.streaming, index: e.index!, kind: e.content_block!.type, text: "", name: e.content_block!.name };
      s.partial.set(`${b.msg}:${b.index}`, b);
      send(s, { type: "stream", msg: b.msg, index: b.index, kind: b.kind, name: b.name, text: "" });
    } else if (e.type === "content_block_delta") {
      const b = s.partial.get(`${s.streaming}:${e.index}`);
      const piece = e.delta?.text ?? e.delta?.thinking ?? e.delta?.partial_json ?? "";
      if (!b || !piece) return;
      b.text += piece;
      send(s, { type: "stream", msg: b.msg, index: b.index, kind: b.kind, name: b.name, text: piece });
    }
    return;
  }
  if ((m.type === "assistant" || m.type === "user") && !m.parent_tool_use_id) {
    if (m.type === "assistant") {
      // Claude Code records each block of a reply as one message, in order: this block is done streaming, and so are
      // the reply's blocks before it.
      const kind = (m.message.content as { type: string }[])[0]?.type;
      const done = [...s.partial.values()].find((b) => b.msg === m.message.id && b.kind === kind);
      if (done) for (const [key, b] of s.partial) if (b.msg === done.msg && b.index <= done.index) s.partial.delete(key);
    }
    send(s, { type: "message", entry: m });
  } else if (m.type === "result") {
    s.partial.clear();
    setStatus(s, null);
    // A subagent the turn waited on ends with it; one the user stopped may send no event of its own to say so.
    const was = s.tasks.size;
    for (const t of s.tasks.values()) if (!t.background) s.tasks.delete(t.id);
    if (s.tasks.size !== was) send(s, { type: "tasks", tasks: tasksOf(s) });
    if (!s.inbox.length) setWorking(s, false);
  }
}

// Close a session's process; its transcript stays, and its next message resumes it.
function close(s: Session) {
  s.closed = true;
  s.wake?.();
  try {
    s.q.close();
  } catch {
    // already ended
  }
}

setInterval(() => {
  // One with a task still running keeps its process, which the task would end with.
  for (const s of sessions.values()) if (!s.working && !s.watchers.size && !s.asks.size && !s.tasks.size && Date.now() - s.since > IDLE_CLOSE) close(s);
}, 60_000);

const row = (s: Session) => ({ id: s.id, cwd: s.cwd, title: s.title, working: s.working, since: s.since, asks: s.asks.size, watchers: s.watchers.size });

function find(id: string): Session {
  const s = sessions.get(id);
  if (!s || s.closed) throw Object.assign(new Error("No such session in the host"), { statusCode: 404 });
  return s;
}

const app = Fastify();
await app.register(websocket);

app.get("/version", async () => ({ version: VERSION, pid: process.pid }));
app.get("/sessions", async () => [...sessions.values()].filter((s) => !s.closed).map(row));

app.post<{ Body: StartOptions }>("/sessions", async (req) => {
  const o = req.body;
  const before = o.id ? sessions.get(o.id) : undefined;
  // One closing, as when desk moves a chat to another folder, is started again once its process has exited.
  if (before?.closed) await Promise.race([before.ended, new Promise((r) => setTimeout(r, 15_000))]);
  if (o.id && sessions.has(o.id)) throw Object.assign(new Error("The host already holds this session"), { statusCode: 409 });
  if (!o.cwd || !existsSync(o.cwd)) throw Object.assign(new Error(`No folder ${o.cwd}`), { statusCode: 400 });
  return row(start(o));
});

app.post<{ Params: { id: string }; Body: { content: Content; uuid?: string; priority?: "now" | "next" | "later" } }>("/sessions/:id/send", async (req) => {
  const s = find(req.params.id);
  s.inbox.push(userMessage(req.body.content, req.body.uuid));
  s.wake?.();
  return row(s);
});

// Take back a message Claude has not read yet, as ↑ does to the queue in its terminal: from the inbox, or from Claude
// Code's own queue, where it waits for the turn's next step. False once Claude has read it.
app.post<{ Params: { id: string }; Body: { uuid: string } }>("/sessions/:id/withdraw", async (req) => {
  const s = find(req.params.id);
  const at = s.inbox.findIndex((m) => m.uuid === req.body.uuid);
  if (at >= 0) {
    s.inbox.splice(at, 1);
    return { withdrawn: true };
  }
  // The SDK's Query has it (the control request cancel_async_message, which sdk.d.ts documents) but types it not.
  const q = s.q as Query & { cancelAsyncMessage(uuid: string): Promise<boolean> };
  return { withdrawn: Boolean(await q.cancelAsyncMessage(req.body.uuid)) };
});

app.post<{ Params: { id: string } }>("/sessions/:id/interrupt", async (req) => {
  const s = find(req.params.id);
  s.inbox.length = 0; // Esc in the terminal drops what waits too
  await s.q.interrupt();
  return row(s);
});

app.post<{ Params: { id: string }; Body: { ask: string; result: PermissionResult } }>("/sessions/:id/answer", async (req) => {
  const s = find(req.params.id), ask = s.asks.get(req.body.ask);
  if (!ask) throw Object.assign(new Error("That question was already answered"), { statusCode: 409 });
  const r = req.body.result;
  ask.answer(r.behavior === "allow" ? { behavior: "allow", updatedInput: r.updatedInput ?? ask.input } : r);
  return row(s);
});

app.post<{ Params: { id: string } }>("/sessions/:id/close", async (req) => {
  close(find(req.params.id));
  return {};
});

// The model and effort for the session's next request, the turn running now included, as /model and /effort do.
app.post<{ Params: { id: string }; Body: { model?: string; effort?: StartOptions["effort"] } }>("/sessions/:id/settings", async (req) => {
  const s = find(req.params.id), { model, effort } = req.body;
  if (model) await s.q.setModel(model);
  if (effort) await s.q.applyFlagSettings({ effortLevel: effort });
  return row(s);
});

app.get<{ Params: { id: string } }>("/sessions/:id/commands", async (req) => {
  const s = find(req.params.id);
  return await s.q.supportedCommands();
});

// How full the session's context is, as /context counts it.
app.get<{ Params: { id: string } }>("/sessions/:id/context", async (req) => {
  const { totalTokens, maxTokens, percentage } = await find(req.params.id).q.getContextUsage();
  return { tokens: totalTokens, max: maxTokens, percent: percentage };
});

app.get<{ Params: { id: string } }>("/sessions/:id/events", { websocket: true }, (ws, req) => {
  const s = sessions.get(req.params.id);
  if (!s || s.closed) {
    ws.send(JSON.stringify({ type: "closed", error: "" }));
    ws.close();
    return;
  }
  s.watchers.add(ws);
  ws.send(JSON.stringify({ type: "hello", working: s.working, since: s.since, partial: [...s.partial.values()], asks: asksOf(s), tasks: tasksOf(s), status: s.status }));
  ws.on("close", () => {
    s.watchers.delete(ws);
    s.since = Math.max(s.since, Date.now() - IDLE_CLOSE / 2); // closing the panel leaves it a while before its process goes
  });
});

// desk asks the host to step down for a newer one, which it does only while nothing works or runs in the background,
// nor has for a while: a session that just finished may yet start a turn of its own, such as a wakeup it scheduled.
const QUIET = 10 * 60_000; // ms
app.post("/quit", async (_req, reply) => {
  if ([...sessions.values()].some((s) => s.working || s.asks.size || s.tasks.size || Date.now() - s.since < QUIET))
    return reply.code(409).send({ detail: "A session is working" });
  setTimeout(stop, 50);
  return {};
});

function stop() {
  for (const s of sessions.values()) close(s);
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

if (existsSync(SOCKET)) unlinkSync(SOCKET); // a host that died left it behind; hosted.ts checks no host answers first
await app.listen({ path: SOCKET });
console.log(`desk host ${VERSION} on ${SOCKET}`);
