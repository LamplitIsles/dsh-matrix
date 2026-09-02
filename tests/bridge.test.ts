import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { MatrixBridge, bridgeRpcHandler, finalAssistantTextForTurn, type BridgeAgent, type BridgeDependencies } from "../src/bridge.js";
import { RPC_ENDPOINT } from "../src/constants.js";

class FakeClient extends EventEmitter {
  readonly sent: Array<{ roomId: string; content: Record<string, unknown> }> = [];
  stopped = false;
  startClient() {}
  async stopClient() { this.stopped = true; }
  async sendMessage(roomId: string, content: Record<string, unknown>) { this.sent.push({ roomId, content }); }
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
  const content = { msgtype: "m.text", body, "m.mentions": { user_ids: ["@bot:example"] }, ...extra };
  return {
    getType: () => "m.room.message",
    getRoomId: () => "!allowed:example",
    getSender: () => "@human:example",
    getId: () => id,
    getContent: () => content
  };
}

describe("MatrixBridge", () => {
  it("locks a live agent and relays only its final assistant text", async () => {
    const client = new FakeClient();
    const agent: BridgeAgent = {
      id: "session" as never,
      followup(message) {
        bridge.onInboxClaimed({ agent, message, turn: 7 });
        bridge.onSessionEvent({ id: "session" }, { type: "assistant/message", data: { turn: 7, step: 1, message: { role: "assistant", content: [{ type: "tool", value: "hidden" }], source: { kind: "model", provider: "p", model: "m" } } } });
        bridge.onSessionEvent({ id: "session" }, { type: "assistant/message", data: { turn: 7, step: 2, message: { role: "assistant", content: [{ type: "text", text: "final answer" }], source: { kind: "model", provider: "p", model: "m" } } } });
        bridge.onSessionEvent({ id: "session" }, { type: "turn/end", data: { turn: 7, reason: { kind: "completed" } } });
      },
      whenIdle: async () => undefined
    };
    const deps = baseDeps(client, agent);
    const bridge = new MatrixBridge(deps);
    await bridge.start();
    client.emit("sync", "PREPARED");
    client.emit("Room.timeline", matrixEvent("$one", "@bot:example hello"), {}, false, false, { timeline: "live" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.sent).toEqual([{ roomId: "!allowed:example", content: { msgtype: "m.text", body: "final answer" } }]);
    expect(bridge.agent).toBe(agent);
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
