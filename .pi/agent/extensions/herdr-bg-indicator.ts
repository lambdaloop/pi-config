// Companion to herdr-agent-state.ts (which herdr manages and overwrites).
// Keep custom Herdr hooks in files beside it, like this one.
//
// Publishes one orange filled circle as a pane-metadata token while this Pi
// session is idle *and* background tasks are still running, so the Herdr
// sidebar can say "the model stopped, but background work continues" without
// stealing the native state dot.
//
// Scope: pi-background-tasks tasks for this Pi process only. The provider's
// registry is in-memory (registry.allTasks()) and its runtime dir is keyed by
// session + pid, so a nested child Pi has its own tasks and its own pane.
// Subagents, monitors, and loops are NOT tracked here.
//
// Display requires a Pi row that includes the token, e.g. in config.toml:
//   [ui.sidebar.agents.rows_by_agent]
//   pi = [["state_icon", { token = "$bg", fg = "#ffa500" }, "workspace", "tab"], ["agent"]]
//
// Debug: set HERDR_BG_DEBUG=1 to append a trace to /tmp/herdr-bg-indicator.log
// Tests: ~/.pi/agent/tests/herdr-bg-indicator/run.mjs

// @ts-nocheck

import net from "node:net";
import { appendFileSync } from "node:fs";

const HERDR_ENV = process.env.HERDR_ENV;
const socketPath = process.env.HERDR_SOCKET_PATH;
const paneId = process.env.HERDR_PANE_ID;
const socketEndpoint =
  process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;

const SOURCE = "herdr:pi-bg";
const APPLIES_TO_SOURCE = "herdr:pi";
const TOKEN_NAME = "bg";
const TOKEN_GLYPH = "●";

// Metadata is display-only and TTL-bounded so a crashed or exited Pi cannot
// leave a stale circle behind; renewal keeps it alive while tasks run.
const META_TTL_MS = 20000;
const RENEW_INTERVAL_MS = 6000;

const SOCKET_TIMEOUT_MS = 1500;
const STATUS_TIMEOUT_MS = 2500;
// The provider rejects requests until its own session_start runs; retry briefly
// instead of awaiting inside our session_start, which could delay it.
const STARTUP_ATTEMPTS = 4;
const STARTUP_BACKOFF_MS = 250;
const DEBUG = process.env.HERDR_BG_DEBUG === "1";
const DEBUG_LOG = "/tmp/herdr-bg-indicator.log";

const BG_REQUEST_CHANNEL = "pi-background-tasks:request:v1";
const BG_RESPONSE_CHANNEL = "pi-background-tasks:response:v1";
const BG_TERMINAL_CHANNEL = "pi-background-tasks:terminal:v1";
const BG_REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";
const BG_TERMINAL_SCHEMA = "pi-background-tasks.extension-terminal.v1";

function trace(message) {
  if (!DEBUG) return;
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Tracing must never break the session.
  }
}

function enabled() {
  return HERDR_ENV === "1" && !!socketPath && !!paneId;
}

let reportSeq = Date.now() * 1000;

function nextSeq() {
  reportSeq += 1;
  return reportSeq;
}

/**
 * One JSON-RPC request over the Herdr socket.
 * Resolves true only for a complete reply line with no error field.
 */
function sendHerdr(method, params) {
  if (!enabled()) return Promise.resolve(false);

  return new Promise((resolve) => {
    let done = false;
    let buffer = "";
    const socket = net.createConnection(socketEndpoint);

    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };

    const timer = setTimeout(() => finish(false), SOCKET_TIMEOUT_MS);
    timer.unref?.();

    socket.on("error", () => finish(false));
    socket.on("end", () => finish(false));
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ id: `${SOURCE}:${Date.now()}`, method, params })}\n`),
    );
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const reply = JSON.parse(buffer.slice(0, newline));
        if (reply && reply.error) trace(`herdr error: ${JSON.stringify(reply.error)}`);
        finish(!!reply && !reply.error);
      } catch {
        finish(false);
      }
    });
  });
}

export default function (pi) {
  if (!enabled()) return;

  const events = pi.events;

  let generation = 0;
  let active = false;
  let agentIdle = false;
  /** Task ids known to be running; terminal frames evict them. */
  const runningIds = new Set();
  /**
   * Task ids already observed terminal. Task ids are unique, so a finished task
   * can never legitimately become running again; this guards against a status
   * snapshot taken before a terminal publication re-adding it.
   */
  const finishedIds = new Set();
  const FINISHED_CAP = 500;
  /** null = unknown, so the first sync always writes a truthful value. */
  let published = null;
  let renewTimer;
  let queue = Promise.resolve();
  /** requestId -> { resolve, timer } for in-flight status requests. */
  let pendingStatus = new Map();
  let unsubscribers = [];
  let startupTimers = new Set();

  function envelope(on) {
    return {
      pane_id: paneId,
      source: SOURCE,
      applies_to_source: APPLIES_TO_SOURCE,
      agent: "pi",
      tokens: { [TOKEN_NAME]: on ? TOKEN_GLYPH : null },
      ...(on ? { ttl_ms: META_TTL_MS } : {}),
      seq: nextSeq(),
    };
  }

  function write(on) {
    return sendHerdr("pane.report_metadata", envelope(on));
  }

  function desired() {
    return active && agentIdle && runningIds.size > 0;
  }

  function startRenewal() {
    if (renewTimer) return;
    renewTimer = setInterval(() => void renew(), RENEW_INTERVAL_MS);
    renewTimer.unref?.();
  }

  function stopRenewal() {
    if (!renewTimer) return;
    clearInterval(renewTimer);
    renewTimer = undefined;
  }

  /**
   * Serialize every metadata write on one chain and recompute the wanted value
   * inside the queued step, so a queued clear can never land before an
   * in-flight publish of the opposite value.
   */
  function sync(reason) {
    const gen = generation;
    queue = queue
      .then(async () => {
        if (gen !== generation) return;
        const want = desired();
        if (want === published) return;

        const ok = await write(want);
        if (gen !== generation) return;
        if (!ok) {
          trace(`write failed (${reason})`);
          // The server-side value is now unknown, so the next sync writes truth.
          published = null;
          return;
        }
        published = want;
        trace(`${want ? "published" : "cleared"} (${reason}) running=${runningIds.size}`);
        if (want) startRenewal();
        else stopRenewal();
      })
      .catch((error) => trace(`sync error (${reason}): ${error?.message}`));
    return queue;
  }

  function renew() {
    const gen = generation;
    queue = queue
      .then(async () => {
        if (gen !== generation || published !== true) return;
        // Recompute inside the queued step: the agent may have started a turn,
        // or the session may be tearing down, since this renewal was scheduled.
        if (!desired()) {
          stopRenewal();
          return;
        }
        const ok = await write(true);
        if (!ok) trace("renew failed; TTL lapses unless a later renew succeeds");
      })
      .catch((error) => trace(`renew error: ${error?.message}`));
    return queue;
  }

  function settlePending(requestId, frame) {
    const pending = pendingStatus.get(requestId);
    if (!pending) return false;
    pendingStatus.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(frame);
    return true;
  }

  function onResponse(frame) {
    const requestId = frame?.request_id;
    if (typeof requestId !== "string") return;
    settlePending(requestId, frame);
  }

  function markFinished(id) {
    finishedIds.add(id);
    if (finishedIds.size > FINISHED_CAP) {
      // Insertion-ordered set: drop the oldest id once the guard grows too large.
      const oldest = finishedIds.values().next().value;
      finishedIds.delete(oldest);
    }
  }

  function onTerminal(frame) {
    if (frame?.schema_version !== BG_TERMINAL_SCHEMA) return;
    const id = frame?.task?.id;
    if (typeof id === "string") {
      markFinished(id);
      runningIds.delete(id);
      trace(`terminal ${id} (${frame?.task?.status}) running=${runningIds.size}`);
    }
    void sync("terminal");
  }

  function subscribe() {
    unsubscribers = [
      events.on(BG_RESPONSE_CHANNEL, onResponse),
      events.on(BG_TERMINAL_CHANNEL, onTerminal),
    ];
  }

  function unsubscribe() {
    for (const off of unsubscribers) {
      try {
        off?.();
      } catch {
        // Idempotent teardown: a throwing unsubscribe must not block the rest.
      }
    }
    unsubscribers = [];
  }

  function clearStartupTimers() {
    for (const timer of startupTimers) clearTimeout(timer);
    startupTimers = new Set();
  }

  /** Resolves undefined on timeout, provider error, or malformed reply. */
  function requestStatus() {
    const requestId = `${SOURCE}:status:${nextSeq()}`;
    const reply = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pendingStatus.delete(requestId)) resolve(undefined);
      }, STATUS_TIMEOUT_MS);
      timer.unref?.();
      pendingStatus.set(requestId, { resolve, timer });
    });

    try {
      events.emit(BG_REQUEST_CHANNEL, {
        schema_version: BG_REQUEST_SCHEMA,
        request_id: requestId,
        operation: "status",
        payload: {},
      });
    } catch (error) {
      settlePending(requestId, undefined);
      trace(`status emit failed: ${error?.message}`);
    }

    return reply;
  }

  /**
   * Reconcile the running set from the authoritative task registry.
   * Resolves true when a usable snapshot was applied.
   */
  async function refresh(reason) {
    if (!active) return false;
    const gen = generation;

    const response = await requestStatus();
    if (!active || gen !== generation) return false;

    if (!response || response.ok !== true || !Array.isArray(response.result?.tasks)) {
      const detail = !response ? "unavailable" : response.ok !== true ? `error: ${response.error}` : "malformed";
      trace(`status ${detail} (${reason})`);
      // Never retain or revive stale metadata when the provider cannot answer.
      runningIds.clear();
      await sync(`unavailable:${reason}`);
      return false;
    }

    runningIds.clear();
    for (const task of response.result.tasks) {
      if (task?.status !== "running" || typeof task.id !== "string") continue;
      if (finishedIds.has(task.id)) continue; // snapshot predates the terminal frame
      runningIds.add(task.id);
    }
    trace(`status (${reason}) running=${runningIds.size}`);
    await sync(`status:${reason}`);
    return true;
  }

  /** The provider may not be ready during our session_start, so retry briefly. */
  function scheduleStartupReconcile() {
    const gen = generation;

    const attempt = async (remaining) => {
      if (gen !== generation || !active) return;
      if (await refresh("startup")) return;
      if (gen !== generation || !active || remaining <= 1) {
        if (remaining <= 1) trace("startup reconcile gave up");
        return;
      }
      const timer = setTimeout(() => {
        startupTimers.delete(timer);
        void attempt(remaining - 1);
      }, STARTUP_BACKOFF_MS);
      timer.unref?.();
      startupTimers.add(timer);
    };

    const first = setTimeout(() => {
      startupTimers.delete(first);
      void attempt(STARTUP_ATTEMPTS);
    }, 0);
    first.unref?.();
    startupTimers.add(first);
  }

  /** Release all session-scoped resources without touching metadata. */
  function retireSession() {
    generation += 1;
    active = false;
    agentIdle = false;
    runningIds.clear();
    finishedIds.clear();
    clearStartupTimers();
    stopRenewal();
    unsubscribe();
    for (const [, pending] of pendingStatus) {
      clearTimeout(pending.timer);
      pending.resolve(undefined);
    }
    pendingStatus = new Map();
  }

  function beginSession(ctx) {
    // Retire any previous session first, so a repeated session_start cannot
    // leave duplicate listeners, timers, or in-flight requests behind.
    retireSession();

    active = true;
    // Always re-assert the value on the server: renewal was stopped above, so
    // trusting a stale `published` would let the TTL lapse with no rewrite.
    published = null;
    agentIdle = ctx?.isIdle?.() === true;
    subscribe();
    trace(`session_start idle=${agentIdle}`);
    scheduleStartupReconcile();
  }

  async function endSession(reason) {
    retireSession();
    await sync(reason);
    trace(`${reason} complete`);
  }

  pi.on("session_start", (event, ctx) => {
    // TUI only: RPC/JSON/print invocations have no Herdr pane to decorate.
    if (ctx?.mode !== "tui") return;
    beginSession(ctx);
  });

  pi.on("agent_start", () => {
    agentIdle = false;
    void sync("agent_start");
  });

  pi.on("agent_settled", async (event, ctx) => {
    if (ctx?.isIdle?.() !== true) return;
    agentIdle = true;
    await refresh("agent_settled");
  });

  pi.on("session_shutdown", async () => {
    await endSession("session_shutdown");
  });
}
