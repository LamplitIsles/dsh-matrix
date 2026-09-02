import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { MatrixBridge, bridgeRpcHandler, finalAssistantTextForTurn, type BridgeAgent, type BridgeDependencies } from "../src/bridge.js";
import { renderMatrixContextPrompt, type MatrixEventLike, type MatrixRoomLike } from "../src/matrix-protocol.js";
import { MAX_PROVENANCE_CHARS, MAX_PROMPT_CHARS, RPC_ENDPOINT } from "../src/constants.js";
import { MATRIX_LIST_ROOM_MEMBERS, MATRIX_SEND_ROOM_MESSAGE } from "../src/matrix-tools.js";

class FakeClient extends EventEmitter {
  readonly sent: Array<{ roomId: string; content: Record<string, unknown> }> = [];
  stopped = false;
  startClient() {}
  async stopClient() { this.stopped = true; }
  async sendMessage(roomId: string, content: Record<string, unknown>) { this.sent.push({ roomId, content }); }
  getRoom(): MatrixRoomLike | undefined { return undefined; }
  async fetchRoomEvent(_roomId: string, _eventId: string, _signal?: AbortSignal): Promise<MatrixEventLike> { throw new Error("not found"); }
}

function baseDeps(client: FakeClient, agent?: BridgeAgent, now = 1_000): BridgeDependencies {
  return {
    getSettings: () => ({ homeserverUrl: "https://matrix.example", userId: "@bot:example", roomId: "!allowed:example", workspaceId: "workspace", respondToAll: false }),
    resolveCredential: async () => ({ value: "secret-token" }),
    workspaceRegistry: { get: () => ({ id: "workspace", sessionIds: ["session"] }), archivedSessionIds: new Set() },
    inspectSession: async () => ({ meta: { id: "session", agentPreset: "default" }, events: [{ type: "user/message", time: 1, data: { source: { kind: "user" } } }] }),
    agents: { get: () => agent, resume: async () => ({ agent: agent!, dispose: async () => undefined }) },
    matrixClientFactory: async () => client,
    now: () => now,
    turnTimeoutMs: 1_000
  };
}

function matrixEvent(id: string, body: string, extra: Record<string, unknown> = {}) {
  const content = (extra.content as Record<string, unknown> | undefined) ?? { msgtype: "m.text", body, "m.mentions": { user_ids: ["@bot:example"] } };
  const sender = typeof extra.sender === "string" ? extra.sender : "@human:example";
  return {
    getType: () => "m.room.message",
    getRoomId: () => "!allowed:example",
    getSender: () => sender,
    getId: () => id,
    getContent: () => content
  };
}

describe("MatrixBridge", () => {
  it("registers fixed-room tools only in the locked Agent scope and disposes them", async () => {
    const client = new FakeClient();
    const registered: Array<{ name: string }> = [];
    const disposed: string[] = [];
    const agent: BridgeAgent = {
      id: "session" as never,
      ctx: {
        tools: {
          register: (definition: ToolDefinition) => {
            registered.push(definition);
            return () => { disposed.push(definition.name); };
          }
        }
      } as never,
      followup: () => undefined,
      whenIdle: async () => undefined
    };
    const bridge = new MatrixBridge(baseDeps(client, agent));
    await bridge.start();
    expect(registered.map((tool) => tool.name)).toEqual([MATRIX_LIST_ROOM_MEMBERS, MATRIX_SEND_ROOM_MESSAGE]);
    const send = registered.find((tool) => tool.name === MATRIX_SEND_ROOM_MESSAGE) as any;
    const list = registered.find((tool) => tool.name === MATRIX_LIST_ROOM_MEMBERS) as any;
    await expect(send.execute({ body: "before sync" }, { signal: new AbortController().signal })).rejects.toThrow("not ready");
    await expect(list.execute({}, { signal: new AbortController().signal })).rejects.toThrow("not ready");
    client.emit("sync", "PREPARED");
    await send.execute({ body: "hello from Web" }, { signal: new AbortController().signal });
    expect(client.sent).toEqual([{ roomId: "!allowed:example", content: { msgtype: "m.text", body: "hello from Web" } }]);
    client.emit("sync", "ERROR");
    expect(bridge.readiness.state).toBe("failed");
    await expect(send.execute({ body: "after sync error" }, { signal: new AbortController().signal })).rejects.toThrow("not ready");
    await expect(list.execute({}, { signal: new AbortController().signal })).rejects.toThrow("not ready");
    expect(client.sent).toHaveLength(1);
    // The bot-authored tool event is explicitly ignored by Matrix capture, so
    // a Web/CLI turn cannot accidentally become a Matrix-triggered turn.
    client.emit("Room.timeline", matrixEvent("$tool-message", "hello from Web", { sender: "@bot:example", content: { msgtype: "m.text", body: "hello from Web" } }), {}, false, false, { timeline: "live" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridge.pendingCount).toBe(0);
    await bridge.stop();
    expect(disposed).toEqual([MATRIX_SEND_ROOM_MESSAGE, MATRIX_LIST_ROOM_MEMBERS]);
  });

  it("locks a live agent and relays only its final assistant text", async () => {
    const client = new FakeClient();
    let idleCalls = 0;
    const agent: BridgeAgent = {
      id: "session" as never,
      followup(message) {
        bridge.onInboxClaimed({ agent, message, turn: 7 });
        bridge.onSessionEvent({ id: "session" }, { type: "assistant/message", data: { turn: 7, step: 1, message: { role: "assistant", content: [{ type: "tool", value: "hidden" }], source: { kind: "model", provider: "p", model: "m" } } } });
        bridge.onSessionEvent({ id: "session" }, { type: "assistant/message", data: { turn: 7, step: 2, message: { role: "assistant", content: [{ type: "text", text: "final answer" }], source: { kind: "model", provider: "p", model: "m" } } } });
        bridge.onSessionEvent({ id: "session" }, { type: "turn/end", data: { turn: 7, reason: { kind: "completed" } } });
      },
      whenIdle: async () => { idleCalls += 1; }
    };
    const deps = baseDeps(client, agent);
    const bridge = new MatrixBridge(deps);
    await bridge.start();
    client.emit("sync", "PREPARED");
    client.emit("Room.timeline", matrixEvent("$one", "@bot:example hello"), {}, false, false, { timeline: "live" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.sent).toEqual([{ roomId: "!allowed:example", content: {
      msgtype: "m.text",
      body: "final answer",
      "m.relates_to": { "m.in_reply_to": { event_id: "$one" } }
    } }]);
    expect(bridge.agent).toBe(agent);
    expect(idleCalls).toBe(1);
    await bridge.stop();
    expect(client.stopped).toBe(true);
  });

  it("serializes admitted events and rate-limits unbound notices", async () => {
    const client = new FakeClient();
    const deps = baseDeps(client, undefined, 10);
    deps.unboundNoticeIntervalMs = 100;
    const bridge = new MatrixBridge(deps);
    await bridge.start();
    client.emit("sync", "PREPARED");
    client.emit("Room.timeline", matrixEvent("$one", "@bot:example first"), {}, false, false, { timeline: "live" });
    client.emit("Room.timeline", matrixEvent("$two", "@bot:example second"), {}, false, false, { timeline: "live" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.sent).toHaveLength(1);
    expect(bridge.readiness.state).toBe("unbound");
    await bridge.stop();
  });

  it("buffers ordinary room text and drains it into an attributed deterministic prompt", async () => {
    const client = new FakeClient();
    client.getRoom = () => ({
      getMember: (userId: string) => userId === "@bot:example"
        ? { userId, name: "汐" }
        : { userId, name: "Alice" }
    });
    const prompts: UserMessage[] = [];
    let turn = 20;
    const agent: BridgeAgent = {
      id: "session" as never,
      followup(message) {
        prompts.push(message);
        const current = turn++;
        bridge.onInboxClaimed({ agent, message, turn: current });
        bridge.onSessionEvent({ id: "session" }, { type: "assistant/message", data: { turn: current, message: { role: "assistant", content: [{ type: "text", text: "answer" }] } } });
        bridge.onSessionEvent({ id: "session" }, { type: "turn/end", data: { turn: current, reason: { kind: "completed" } } });
      },
      whenIdle: async () => undefined
    };
    const bridge = new MatrixBridge(baseDeps(client, agent));
    await bridge.start();
    client.emit("sync", "PREPARED");
    client.emit("Room.timeline", matrixEvent("$ordinary", "ordinary context", { content: { msgtype: "m.text", body: "ordinary context" } }), {}, false, false, { timeline: "live" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompts).toHaveLength(0);
    expect(bridge.contextBuffer).toMatchObject([{ eventId: "$ordinary", sender: "@human:example", displayName: "Alice", text: "ordinary context" }]);

    client.emit("Room.timeline", matrixEvent("$trigger", "@bot:example answer this"), {}, false, false, { timeline: "live" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompts).toHaveLength(1);
    const prompt = String(prompts[0]?.content[0]?.type === "text" ? prompts[0]?.content[0]?.text : "");
    expect(prompt).toContain("untrusted Matrix room data");
    expect(prompt).toContain('event_id="$ordinary" sender="@human:example"');
    expect(prompt).toContain('display_name="Alice"');
    expect(prompt).toContain("Speaker: Alice (@human:example)");
    expect(prompt).toContain('event_id="$trigger" sender="@human:example" trigger=true');
    expect(prompt).toContain("NO_REPLY");
    expect(prompts[0]?.source).toEqual({ kind: "user" });
    expect(bridge.contextBuffer).toHaveLength(0);
    expect(client.sent[0]?.content["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$trigger" } });
    await bridge.stop();
  });

  it("serializes delayed reply verification and keeps FIFO text bounded", async () => {
    const client = new FakeClient();
    let release!: (event: MatrixEventLike) => void;
    const delayed = new Promise<MatrixEventLike>((resolve) => { release = resolve; });
    client.getRoom = () => undefined;
    client.fetchRoomEvent = async () => delayed;
    const prompts: UserMessage[] = [];
    const agent: BridgeAgent = {
      id: "session" as never,
      followup(message) {
        prompts.push(message);
        bridge.onInboxClaimed({ agent, message, turn: 30 });
        bridge.onSessionEvent({ id: "session" }, { type: "assistant/message", data: { turn: 30, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } } });
        bridge.onSessionEvent({ id: "session" }, { type: "turn/end", data: { turn: 30, reason: { kind: "completed" } } });
      },
      whenIdle: async () => undefined
    };
    const bridge = new MatrixBridge(baseDeps(client, agent));
    await bridge.start();
    client.emit("sync", "PREPARED");
    client.emit("Room.timeline", matrixEvent("$first", "first", { content: { msgtype: "m.text", body: "first", "m.relates_to": { "m.in_reply_to": { event_id: "$human" } } } }), {}, false, false, { timeline: "live" });
    client.emit("Room.timeline", matrixEvent("$second", "@bot:example second"), {}, false, false, { timeline: "live" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompts).toHaveLength(0);
    release({
      event: { type: "m.room.message", room_id: "!allowed:example", sender: "@other:example", event_id: "$human", content: { msgtype: "m.text", body: "human target" } },
      getType: () => "m.room.message",
      getRoomId: () => "!allowed:example",
      getSender: () => "@other:example",
      getId: () => "$human",
      getContent: () => ({ msgtype: "m.text", body: "human target" })
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompts).toHaveLength(1);
    const prompt = String(prompts[0]?.content[0]?.type === "text" ? prompts[0]?.content[0]?.text : "");
    expect(prompt.indexOf('event_id="$first"')).toBeLessThan(prompt.indexOf('event_id="$second"'));
    await bridge.stop();

    const longClient = new FakeClient();
    const longPrompts: UserMessage[] = [];
    const longAgent: BridgeAgent = {
      id: "session" as never,
      followup(message) {
        longPrompts.push(message);
        bridgeLong.onInboxClaimed({ agent: longAgent, message, turn: 31 });
        bridgeLong.onSessionEvent({ id: "session" }, { type: "assistant/message", data: { turn: 31, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } } });
        bridgeLong.onSessionEvent({ id: "session" }, { type: "turn/end", data: { turn: 31, reason: { kind: "completed" } } });
      },
      whenIdle: async () => undefined
    };
    const bridgeLong = new MatrixBridge(baseDeps(longClient, longAgent));
    await bridgeLong.start();
    longClient.emit("sync", "PREPARED");
    longClient.emit("Room.timeline", matrixEvent("$old", "a".repeat(10_000), { content: { msgtype: "m.text", body: "a".repeat(10_000) } }), {}, false, false, { timeline: "live" });
    longClient.emit("Room.timeline", matrixEvent("$new", "b".repeat(10_000), { content: { msgtype: "m.text", body: "b".repeat(10_000) } }), {}, false, false, { timeline: "live" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridgeLong.bufferedContextCharacters).toBe(10_000);
    expect(bridgeLong.contextBuffer.map((record) => record.eventId)).toEqual(["$new"]);
    longClient.emit("Room.timeline", matrixEvent("$trigger", "@bot:example now"), {}, false, false, { timeline: "live" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const longPrompt = String(longPrompts[0]?.content[0]?.type === "text" ? longPrompts[0]?.content[0]?.text : "");
    expect(longPrompt).not.toContain('event_id="$old"');
    expect(longPrompt).toContain('event_id="$new"');
    expect(longPrompt).toContain('event_id="$trigger"');
    await bridgeLong.stop();
  });

  it("bounds the rendered context contribution when identities are adversarially long", async () => {
    const client = new FakeClient();
    const prompts: UserMessage[] = [];
    const agent: BridgeAgent = {
      id: "session" as never,
      followup(message) {
        prompts.push(message);
        bridge.onInboxClaimed({ agent, message, turn: 32 });
        bridge.onSessionEvent({ id: "session" }, { type: "assistant/message", data: { turn: 32, message: { role: "assistant", content: [{ type: "text", text: "bounded" }] } } });
        bridge.onSessionEvent({ id: "session" }, { type: "turn/end", data: { turn: 32, reason: { kind: "completed" } } });
      },
      whenIdle: async () => undefined
    };
    const bridge = new MatrixBridge(baseDeps(client, agent));
    await bridge.start();
    client.emit("sync", "PREPARED");
    for (let index = 0; index < 40; index += 1) {
      const eventId = `$context-${String(index).padStart(2, "0")}-${"x".repeat(600)}`;
      client.emit("Room.timeline", matrixEvent(eventId, `context ${index}`, { content: { msgtype: "m.text", body: `context ${index}` } }), {}, false, false, { timeline: "live" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(bridge.contextBuffer.length).toBeLessThan(40);
    const triggerId = `$trigger-${"y".repeat(600)}`;
    client.emit("Room.timeline", matrixEvent(triggerId, "@bot:example summarize", { content: { msgtype: "m.text", body: "@bot:example summarize", "m.mentions": { user_ids: ["@bot:example"] } } }), {}, false, false, { timeline: "live" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const prompt = String(prompts[0]?.content[0]?.type === "text" ? prompts[0]?.content[0]?.text : "");
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(prompt).toContain(`event_id="${triggerId.slice(0, MAX_PROVENANCE_CHARS)}"`);
    expect(prompt).toContain('trigger=true');
    expect(renderMatrixContextPrompt(bridge.contextBuffer, "")).toContain("room context");
    expect(bridge.contextBuffer).toHaveLength(0);
    await bridge.stop();
  });

  it("gates delayed reply classification after stop without waiting forever", async () => {
    const client = new FakeClient();
    let release!: (event: MatrixEventLike) => void;
    const delayed = new Promise<MatrixEventLike>((resolve) => { release = resolve; });
    let aborted = false;
    client.getRoom = () => undefined;
    client.fetchRoomEvent = async (_roomId, _eventId, signal) => {
      signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
      return delayed;
    };
    const prompts: UserMessage[] = [];
    const agent: BridgeAgent = {
      id: "session" as never,
      followup: (message) => { prompts.push(message); },
      whenIdle: async () => undefined
    };
    const bridge = new MatrixBridge(baseDeps(client, agent));
    await bridge.start();
    client.emit("sync", "PREPARED");
    client.emit("Room.timeline", matrixEvent("$delayed-stop", "reply", { content: { msgtype: "m.text", body: "reply", "m.relates_to": { "m.in_reply_to": { event_id: "$not-yet" } } } }), {}, false, false, { timeline: "live" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await bridge.stop();
    expect(aborted).toBe(true);
    expect(bridge.readiness.state).toBe("disabled");
    expect(bridge.contextBuffer).toHaveLength(0);
    release(matrixEvent("$not-yet", "old bot message", { sender: "@bot:example", content: { msgtype: "m.text", body: "old bot message" } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompts).toHaveLength(0);
    expect(client.sent).toHaveLength(0);
  });

  it("suppresses an exact NO_REPLY and anchors each later answer to its trigger", async () => {
    const client = new FakeClient();
    const agentTurns = ["  NO_REPLY  ", "visible"];
    let turn = 40;
    const agent: BridgeAgent = {
      id: "session" as never,
      followup(message) {
        const current = turn++;
        bridge.onInboxClaimed({ agent, message, turn: current });
        bridge.onSessionEvent({ id: "session" }, { type: "assistant/message", data: { turn: current, message: { role: "assistant", content: [{ type: "text", text: agentTurns.shift() ?? "" }] } } });
        bridge.onSessionEvent({ id: "session" }, { type: "turn/end", data: { turn: current, reason: { kind: "completed" } } });
      },
      whenIdle: async () => undefined
    };
    const bridge = new MatrixBridge(baseDeps(client, agent));
    await bridge.start();
    client.emit("sync", "PREPARED");
    client.emit("Room.timeline", matrixEvent("$quiet", "@bot:example no answer"), {}, false, false, { timeline: "live" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.sent).toHaveLength(0);
    client.emit("Room.timeline", matrixEvent("$loud", "@bot:example answer now"), {}, false, false, { timeline: "live" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.content).toMatchObject({ body: "visible", "m.relates_to": { "m.in_reply_to": { event_id: "$loud" } } });
    await bridge.stop();
  });

  it("resumes a persisted active conversation with its recorded preset and owns disposal", async () => {
    const client = new FakeClient();
    const resumed: BridgeAgent = { id: "session" as never, followup: () => undefined, whenIdle: async () => undefined };
    let setupPreset = "";
    let disposed = false;
    const deps = baseDeps(client, undefined);
    deps.agents = {
      get: () => undefined,
      resume: async (options) => {
        await options.setup?.({});
        return { agent: resumed, dispose: async () => { disposed = true; } };
      }
    };
    deps.agentPresets = { mount: async (_context, presetId) => { setupPreset = presetId; } };
    const bridge = new MatrixBridge(deps);
    await bridge.start();
    expect(setupPreset).toBe("default");
    await bridge.stop();
    expect(disposed).toBe(true);
  });

  it("accepts the workspace registry's ordered archived-session array", async () => {
    const client = new FakeClient();
    const deps = baseDeps(client, undefined);
    deps.workspaceRegistry.archivedSessionIds = ["session"];
    const bridge = new MatrixBridge(deps);
    await bridge.start();
    client.emit("sync", "PREPARED");
    expect(bridge.readiness.state).toBe("unbound");
    expect(bridge.ownedAgentHandle).toBeUndefined();
    await bridge.stop();
  });

  it("filters persisted assistant output to a completed exact turn", () => {
    const events = [
      { type: "assistant/message", data: { turn: 2, message: { role: "assistant", content: [{ type: "text", text: "other" }] } } },
      { type: "assistant/message", data: { turn: 3, message: { role: "assistant", content: [{ type: "text", text: "ours" }] } } },
      { type: "turn/end", data: { turn: 3, reason: { kind: "completed" } } }
    ];
    expect(finalAssistantTextForTurn(events, 3)).toBe("ours");
    expect(finalAssistantTextForTurn([...events, { type: "assistant/message", data: { turn: 3, interrupted: true, message: { role: "assistant", content: [{ type: "text", text: "partial" }] } } }], 3)).toBeUndefined();
  });

  it("serves readiness through the relative channel endpoint", async () => {
    const bridge = new MatrixBridge(baseDeps(new FakeClient(), undefined));
    const handler = bridgeRpcHandler(bridge);
    await expect(handler(RPC_ENDPOINT, {}, new AbortController().signal)).resolves.toMatchObject({ ok: true, value: { state: "disabled" } });
    await expect(handler("dsh-matrix/readiness", {}, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});
