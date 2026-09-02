import { createUserMessage, type AssistantMessage, type UserMessage } from "@deepseek-ai/dsh-llm";
import { installModelSelection, type Agent, type AgentHandle, type ModelSelection } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import {
  CREDENTIAL_REF,
  DEFAULT_SETTINGS,
  DEDUPE_LIMIT,
  RPC_CHANNEL,
  RPC_ENDPOINT,
  UNBOUND_NOTICE_INTERVAL_MS,
  type MatrixSettings
} from "./constants.js";
import {
  admitMatrixEvent,
  EventDeduper,
  matrixEventId,
  matrixTextMessage,
  type AdmittedMatrixMessage,
  type MatrixClientLike,
  type MatrixEventLike,
  type MatrixProvenance,
  type MatrixTimelineData
} from "./matrix-protocol.js";
import {
  selectMostRecentEligibleSession,
  type SessionEventLike,
  type SessionInspectionLike,
  type WorkspaceLike
} from "./session-selection.js";
import { normalizeSettings, validateSettings } from "./settings.js";

export type BridgeReadinessState =
  | "disabled"
  | "missing-settings"
  | "missing-credential"
  | "connecting"
  | "bound"
  | "unbound"
  | "failed";

export interface BridgeReadiness {
  state: BridgeReadinessState;
  workspaceId?: string;
  sessionId?: string;
  detail?: "workspace-not-found" | "invalid-settings" | "matrix-start-failed" | "session-inspection-failed" | "credential-unavailable";
}

export interface CredentialValue {
  value: string;
  source?: string;
}

export interface BridgeAgent extends Pick<Agent, "id" | "followup"> {
  session?: {
    id?: string;
    events?: readonly SessionEventLike[];
  };
  whenIdle?: () => Promise<void>;
}

export interface BridgeAgentHandle {
  agent: BridgeAgent;
  dispose(): Promise<void>;
}

export interface BridgeDependencies {
  /** Read once at startup; restart semantics mean later edits do not switch this bridge. */
  getSettings: () => unknown;
  resolveCredential: (ref: string) => Promise<CredentialValue | string | undefined>;
  workspaceRegistry: {
    get: (workspaceId: string) => WorkspaceLike | undefined;
    /** DSH exposes this as an ordered readonly array; tests may use a Set. */
    archivedSessionIds?: ReadonlySet<string> | readonly string[];
  };
  inspectSession: (sessionId: string) => Promise<SessionInspectionLike>;
  agents: {
    get: (sessionId: string) => BridgeAgent | undefined;
    resume: (options: { resumeSessionId: string; setup?: (agentContext: unknown) => Promise<void> }) => Promise<BridgeAgentHandle>;
  };
  agentPresets?: {
    mount: (agentContext: unknown, presetId: string) => Promise<unknown>;
  } | undefined;
  matrixClientFactory: (options: { baseUrl: string; accessToken: string; userId: string }) => MatrixClientLike | Promise<MatrixClientLike>;
  /** Optional diagnostic sink. Arguments are bounded and never contain credentials. */
  onReadiness?: (readiness: BridgeReadiness) => void;
  onError?: (error: unknown) => void;
  now?: () => number;
  unboundNoticeIntervalMs?: number;
  dedupeLimit?: number;
  turnTimeoutMs?: number;
}

interface PendingTurn {
  messageId: string;
  matrixEventId: string;
  turn?: number | undefined;
  text?: string | undefined;
  interrupted?: boolean | undefined;
  resolve: (text: string | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface AgentInboxClaimed {
  agent: BridgeAgent;
  message: UserMessage;
  turn: number;
}

interface SessionEventEnvelope {
  id?: string;
  session?: { id?: string };
}

function idOf(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value === "object" && value !== null) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const blocks = content.filter((block): block is { type?: unknown; text?: unknown } => typeof block === "object" && block !== null);
  // A model message that requests a tool is intermediate even when a provider
  // also included a short textual preface. A later plain assistant message is
  // the only candidate that may cross the Matrix boundary.
  if (blocks.some((block) => block.type === "tool-call" || block.type === "tool-result")) return "";
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
    .trim();
}

/** Extract visible textual blocks from one assistant message, excluding tool/reasoning blocks. */
export function assistantText(message: Partial<AssistantMessage> | undefined): string {
  if (!message || message.role !== "assistant") return "";
  return textFromContent(message.content);
}

/** Read the last non-empty assistant text in one exact persisted turn. */
export function finalAssistantTextForTurn(events: readonly SessionEventLike[], turn: number): string | undefined {
  let final: string | undefined;
  let interrupted = false;
  for (const event of events) {
    const data = event.data;
    if (!data || typeof data !== "object") continue;
    const payload = data as Record<string, unknown>;
    if (event.type === "assistant/message" && payload.turn === turn) {
      if (payload.interrupted === true) interrupted = true;
      const message = payload.message;
      const text = assistantText(message as Partial<AssistantMessage> | undefined);
      // Usage-only assistant/message rows are allowed to have empty content;
      // they must not erase the last visible answer from the same turn.
      if (text) final = text;
    }
    if (event.type === "turn/end" && payload.turn === turn) {
      const reason = payload.reason;
      if (reason && typeof reason === "object") {
        const kind = (reason as { kind?: unknown }).kind;
        if (kind === "aborted" || kind === "error" || kind === "blocked" || kind === "interrupted") interrupted = true;
      }
    }
  }
  return interrupted ? undefined : final;
}

function snapshotReadiness(value: BridgeReadiness): BridgeReadiness {
  return Object.freeze({ ...value });
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

function recordedModelSelection(inspection: SessionInspectionLike): ModelSelection | undefined {
  let selection: ModelSelection | undefined;
  for (const event of inspection.events ?? []) {
    if (event.type !== "request/header" || !event.data || typeof event.data !== "object") continue;
    const header = (event.data as { header?: unknown }).header;
    if (!header || typeof header !== "object") continue;
    const config = (header as { config?: unknown }).config;
    if (!config || typeof config !== "object") continue;
    const provider = (config as { provider?: unknown }).provider;
    const model = (config as { model?: unknown }).model;
    if (typeof provider !== "string" || !provider || typeof model !== "string" || !model) continue;
    const reasoningEffort = (config as { reasoningEffort?: unknown }).reasoningEffort;
    const next: ModelSelection = { provider, model };
    if (typeof reasoningEffort === "string" && reasoningEffort) next.reasoningEffort = reasoningEffort as NonNullable<ModelSelection["reasoningEffort"]>;
    selection = next;
  }
  return selection;
}

/**
 * Host-side Matrix companion bridge. The class has no Cordis dependency so its
 * public orchestration boundary can be exercised with test-owned fakes.
 */
export class MatrixBridge {
  private readonly deps: BridgeDependencies;
  private readonly dedupe: EventDeduper;
  private readonly now: () => number;
  private readonly unboundNoticeIntervalMs: number;
  private readonly turnTimeoutMs: number;
  private readinessValue: BridgeReadiness = snapshotReadiness({ state: "disabled" });
  private settings: MatrixSettings = DEFAULT_SETTINGS;
  private client: MatrixClientLike | undefined;
  private boundAgent: BridgeAgent | undefined;
  private boundSessionId: string | undefined;
  private ownedHandle: BridgeAgentHandle | undefined;
  private started = false;
  private accepting = false;
  private stopped = false;
  private prepared = false;
  private startPromise?: Promise<void>;
  private queueTail: Promise<void> = Promise.resolve();
  private queueGeneration = 0;
  private lastUnboundNoticeAt = -Infinity;
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly pendingEventIds = new Set<string>();
  private readonly listeners: Array<() => void> = [];
  private readonly syncListener = (state: unknown) => this.onSync(state);
  private readonly timelineListener = (
    event: MatrixEventLike,
    _room: unknown,
    toStartOfTimeline?: boolean,
    _removed?: boolean,
    data?: MatrixTimelineData
  ) => {
    void this.onTimeline(event, Boolean(toStartOfTimeline), data).catch(() => this.reportError());
  };

  constructor(deps: BridgeDependencies) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.unboundNoticeIntervalMs = deps.unboundNoticeIntervalMs ?? UNBOUND_NOTICE_INTERVAL_MS;
    this.turnTimeoutMs = deps.turnTimeoutMs ?? 120_000;
    this.dedupe = new EventDeduper(deps.dedupeLimit ?? DEDUPE_LIMIT);
  }

  get readiness(): BridgeReadiness {
    return this.readinessValue;
  }

  /** JSON-safe readiness used by the browser card's read-only RPC. */
  readinessForClient(): BridgeReadiness {
    const current = this.readinessValue;
    return snapshotReadiness({
      state: current.state,
      ...(current.workspaceId ? { workspaceId: current.workspaceId } : {}),
      ...(current.sessionId ? { sessionId: current.sessionId } : {}),
      ...(current.detail ? { detail: current.detail } : {})
    });
  }

  get matrixClient(): MatrixClientLike | undefined {
    return this.client;
  }

  get agent(): BridgeAgent | undefined {
    return this.boundAgent;
  }

  get ownedAgentHandle(): BridgeAgentHandle | undefined {
    return this.ownedHandle;
  }

  get pendingCount(): number {
    return this.pendingTurns.size;
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startOnce().catch(() => {
      if (this.stopped) return;
      this.reportError();
      this.setReadiness({ state: "failed", detail: "invalid-settings" });
    });
    return this.startPromise;
  }

  private async startOnce(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    const configured = normalizeSettings(this.deps.getSettings());
    this.settings = {
      ...configured,
      homeserverUrl: configured.homeserverUrl.trim(),
      userId: configured.userId.trim(),
      roomId: configured.roomId.trim(),
      workspaceId: configured.workspaceId.trim()
    };
    const settingsValidation = validateSettings(this.settings);
    if (!settingsValidation.valid) {
      this.setReadiness({ state: "missing-settings", detail: "invalid-settings" });
      return;
    }
    let credential: CredentialValue | string | undefined;
    try {
      credential = await this.deps.resolveCredential(CREDENTIAL_REF);
    } catch {
      if (this.stopped) return;
      this.reportError();
      this.setReadiness({ state: "missing-credential", detail: "credential-unavailable" });
      return;
    }
    if (this.stopped) return;
    const accessToken = typeof credential === "string" ? credential : credential?.value;
    if (!accessToken?.trim()) {
      this.setReadiness({ state: "missing-credential", detail: "credential-unavailable" });
      return;
    }

    const lockSucceeded = await this.lockConversation();
    if (!lockSucceeded || this.stopped) return;
    this.setReadiness({
      state: "connecting",
      workspaceId: this.settings.workspaceId,
      ...(this.boundSessionId ? { sessionId: this.boundSessionId } : {})
    });
    try {
      this.client = await this.deps.matrixClientFactory({
        baseUrl: this.settings.homeserverUrl.trim().replace(/\/$/, ""),
        accessToken: accessToken.trim(),
        userId: this.settings.userId.trim()
      });
      if (this.stopped) {
        const lateClient = this.client;
        this.client = undefined;
        await lateClient?.stopClient?.();
        return;
      }
      this.attachMatrixListeners(this.client);
      await this.client.startClient?.({ initialSyncLimit: 0 });
    } catch {
      if (!this.stopped) this.reportError();
      for (const dispose of this.listeners.splice(0)) {
        try { dispose(); } catch { if (!this.stopped) this.reportError(); }
      }
      const failedClient = this.client;
      this.client = undefined;
      try { await failedClient?.stopClient?.(); } catch { if (!this.stopped) this.reportError(); }
      if (!this.stopped) this.setReadiness({ state: "failed", detail: "matrix-start-failed", workspaceId: this.settings.workspaceId });
    }
  }

  private async lockConversation(): Promise<boolean> {
    if (this.stopped) return false;
    const workspaceId = this.settings.workspaceId.trim();
    const workspace = this.deps.workspaceRegistry.get(workspaceId);
    if (!workspace) {
      this.setReadiness({ state: "failed", detail: "workspace-not-found", workspaceId });
      return false;
    }
    const inspections = new Map<string, SessionInspectionLike>();
    let inspectionFailures = 0;
    try {
      await Promise.all(workspace.sessionIds.map(async (sessionId) => {
        const key = String(sessionId);
        try {
          inspections.set(key, await this.deps.inspectSession(key));
        } catch {
          // One malformed/unavailable session must not prevent another eligible
          // workspace member from being selected.
          if (!this.stopped) this.reportError();
          inspectionFailures += 1;
        }
      }));
    } catch {
      if (!this.stopped) {
        this.reportError();
        this.setReadiness({ state: "failed", detail: "session-inspection-failed", workspaceId });
      }
      return false;
    }
    if (this.stopped) return false;
    if (workspace.sessionIds.length > 0 && inspections.size === 0 && inspectionFailures === workspace.sessionIds.length) {
      if (!this.stopped) this.setReadiness({ state: "failed", detail: "session-inspection-failed", workspaceId });
      return false;
    }
    const archived = this.deps.workspaceRegistry.archivedSessionIds;
    const archivedSet = archived instanceof Set ? archived : new Set(archived ?? []);
    const selected = selectMostRecentEligibleSession(workspace, inspections, archivedSet);
    if (!selected) {
      this.boundAgent = undefined;
      this.boundSessionId = undefined;
      this.setReadiness({ state: "unbound", workspaceId });
      return true;
    }
    this.boundSessionId = selected.sessionId;
    const live = this.deps.agents.get(selected.sessionId);
    if (live) {
      this.boundAgent = live;
      return true;
    }
    const recordedPreset = selected.inspection.meta?.agentPreset ?? selected.inspection.header?.agentPreset;
    const recordedSelection = recordedModelSelection(selected.inspection);
    try {
      if (this.stopped) return false;
      const resumeOptions: { resumeSessionId: string; setup?: (agentContext: unknown) => Promise<void> } = {
        resumeSessionId: selected.sessionId
      };
      if (recordedPreset && this.deps.agentPresets) {
        resumeOptions.setup = async (agentContext) => {
          this.installRecordedModelSelection(agentContext, recordedSelection);
          await this.deps.agentPresets!.mount(agentContext, recordedPreset);
        };
      } else if (recordedSelection) {
        resumeOptions.setup = async (agentContext) => {
          this.installRecordedModelSelection(agentContext, recordedSelection);
        };
      }
      const handle = await this.deps.agents.resume(resumeOptions);
      if (this.stopped) {
        await handle.dispose();
        return false;
      }
      this.ownedHandle = handle;
      this.boundAgent = handle.agent;
      return true;
    } catch {
      if (!this.stopped) this.reportError();
      this.boundAgent = undefined;
      if (!this.stopped) this.setReadiness({ state: "failed", detail: "session-inspection-failed", workspaceId, sessionId: selected.sessionId });
      return false;
    }
  }

  private installRecordedModelSelection(agentContext: unknown, selection: ModelSelection | undefined): void {
    if (!selection) return;
    const context = agentContext as Context & { effect?: (execute: () => unknown, label?: string) => unknown };
    if (typeof context.effect !== "function") return;
    // The model-selection helper installs scoped waterfalls. Register its
    // disposer on the resumed Agent context so unloading the owned handle
    // cannot leave listeners attached to a dead session.
    context.effect(
      () => installModelSelection(context, { current: selection, assembled: undefined }),
      "dsh-matrix: recorded model selection"
    );
  }

  private setReadiness(next: BridgeReadiness): void {
    this.readinessValue = snapshotReadiness(next);
    try {
      this.deps.onReadiness?.(this.readinessValue);
    } catch {
      this.reportError();
    }
  }

  /** Report a bounded diagnostic marker; provider exception text may contain a credential. */
  private reportError(): void {
    try {
      this.deps.onError?.(new Error("dsh-matrix bridge operation failed"));
    } catch {
      // A diagnostic sink must never interfere with bridge lifecycle cleanup.
    }
  }

  private attachMatrixListeners(client: MatrixClientLike): void {
    client.on?.("sync", this.syncListener);
    client.on?.("Room.timeline", this.timelineListener);
    this.listeners.push(() => {
      if (client.off) client.off("sync", this.syncListener);
      else client.removeListener?.("sync", this.syncListener);
    });
    this.listeners.push(() => {
      if (client.off) client.off("Room.timeline", this.timelineListener);
      else client.removeListener?.("Room.timeline", this.timelineListener);
    });
  }

  private onSync(state: unknown): void {
    if (this.stopped) return;
    if (state === "ERROR") {
      this.setReadiness({
        state: "failed",
        detail: "matrix-start-failed",
        workspaceId: this.settings.workspaceId,
        ...(this.boundSessionId ? { sessionId: this.boundSessionId } : {})
      });
      return;
    }
    if (state !== "PREPARED") return;
    this.prepared = true;
    this.accepting = !this.stopped;
    this.setReadiness({
      state: this.boundAgent ? "bound" : "unbound",
      workspaceId: this.settings.workspaceId,
      ...(this.boundSessionId ? { sessionId: this.boundSessionId } : {})
    });
  }

  private async onTimeline(event: MatrixEventLike, toStartOfTimeline: boolean, data?: MatrixTimelineData): Promise<void> {
    if (!this.accepting || !this.prepared || this.stopped || !this.client) return;
    const eventId = matrixEventId(event);
    if (!eventId || this.dedupe.has(eventId) || this.pendingEventIds.has(eventId)) return;
    this.pendingEventIds.add(eventId);
    let admitted;
    try {
      admitted = await admitMatrixEvent(event, this.settings, this.client, toStartOfTimeline, data);
    } finally {
      this.pendingEventIds.delete(eventId);
    }
    if (!admitted) return;
    this.dedupe.add(admitted.eventId);
    this.enqueue(admitted);
  }

  private enqueue(message: AdmittedMatrixMessage): void {
    const generation = this.queueGeneration;
    this.queueTail = this.queueTail
      .catch(() => undefined)
      .then(async () => {
        if (this.stopped || generation !== this.queueGeneration) return;
        await this.processMessage(message);
      })
      .catch(() => this.reportError());
  }

  private async processMessage(message: AdmittedMatrixMessage): Promise<void> {
    if (this.stopped || !this.client) return;
    if (!this.boundAgent) {
      await this.sendUnboundNotice(message.roomId);
      return;
    }
    const source = message.source as unknown as UserMessage["source"];
    const userMessage = createUserMessage({
      content: [{ type: "text", text: message.text }],
      source
    });
    const wait = this.waitForTurn(String(userMessage.id), message.eventId);
    try {
      const result = this.boundAgent.followup(userMessage as never);
      if (isThenable(result)) await result;
    } catch {
      this.finishTurn(String(userMessage.id), undefined);
      this.reportError();
      return;
    }
    // Real Agent.followup is synchronous; waiting for idle gives fakes and
    // resumed loops a chance to publish their final session event before the
    // exact-turn promise falls back to persisted events.
    let idleFinished = this.boundAgent.whenIdle === undefined;
    const idle = (async () => {
      try {
        await this.boundAgent?.whenIdle?.();
      } catch {
        this.reportError();
      } finally {
        idleFinished = true;
      }
    })();
    // Teardown resolves `wait` immediately. Racing it with the Agent's idle
    // signal prevents an unload from hanging on an owned queue while a shared
    // Agent's unrelated foreground work is still running.
    await Promise.race([idle, wait]);
    const pending = this.pendingTurns.get(String(userMessage.id));
    if (idleFinished && pending) {
      if (pending.turn !== undefined && this.boundAgent.session?.events) {
        this.finishTurn(String(userMessage.id), finalAssistantTextForTurn(this.boundAgent.session.events, pending.turn));
      } else {
        // A rejected inbox item can settle without a turn claim. Likewise, a
        // fake or older Agent may expose only the live event callbacks. Once
        // whenIdle resolves, no later output can belong to this message.
        this.finishTurn(String(userMessage.id), pending.interrupted ? undefined : pending.text);
      }
    }
    const text = await wait;
    if (!text || this.stopped || !this.client) return;
    await this.sendMessage(message.roomId, text);
  }

  private waitForTurn(messageId: string, matrixEventIdValue: string): Promise<string | undefined> {
    let resolve!: (text: string | undefined) => void;
    const promise = new Promise<string | undefined>((settle) => { resolve = settle; });
    const timer = setTimeout(() => this.finishTurn(messageId, undefined), this.turnTimeoutMs);
    this.pendingTurns.set(messageId, { messageId, matrixEventId: matrixEventIdValue, resolve, timer });
    return promise;
  }

  private finishTurn(messageId: string, text: string | undefined): void {
    const pending = this.pendingTurns.get(messageId);
    if (!pending) return;
    this.pendingTurns.delete(messageId);
    clearTimeout(pending.timer);
    pending.resolve(text);
  }

  /** Feed the runtime's scoped inbox claim event into exact-turn attribution. */
  onInboxClaimed(payload: AgentInboxClaimed): void {
    if (!this.boundAgent || payload.agent !== this.boundAgent) return;
    const pending = this.pendingTurns.get(String(payload.message.id));
    if (pending) pending.turn = payload.turn;
  }

  /** Feed the runtime's session event firehose into exact-turn attribution. */
  onSessionEvent(session: SessionEventEnvelope, event: SessionEventLike): void {
    if (!this.boundAgent || !event.data || typeof event.data !== "object") return;
    const sessionId = idOf(session) ?? session.session?.id;
    if (this.boundSessionId && sessionId && sessionId !== this.boundSessionId) return;
    const data = event.data as Record<string, unknown>;
    if (event.type === "assistant/message") {
      const turn = data.turn;
      if (typeof turn !== "number") return;
      for (const pending of this.pendingTurns.values()) {
        if (pending.turn !== turn) continue;
        const text = assistantText(data.message as Partial<AssistantMessage> | undefined);
        if (text) pending.text = text;
        if (data.interrupted === true) pending.interrupted = true;
      }
      return;
    }
    if (event.type === "turn/end") {
      const turn = data.turn;
      if (typeof turn !== "number") return;
      const reason = data.reason;
      const aborted = reason && typeof reason === "object" && ((reason as { kind?: unknown }).kind === "aborted" || (reason as { kind?: unknown }).kind === "error" || (reason as { kind?: unknown }).kind === "blocked" || (reason as { kind?: unknown }).kind === "interrupted");
      for (const pending of [...this.pendingTurns.values()]) {
        if (pending.turn !== turn) continue;
        this.finishTurn(pending.messageId, aborted || pending.interrupted ? undefined : pending.text);
      }
    }
  }

  private async sendMessage(roomId: string, body: string): Promise<void> {
    if (!this.client || this.stopped) return;
    if (this.client.sendMessage) {
      await this.client.sendMessage(roomId, matrixTextMessage(roomId, body));
      return;
    }
    if (this.client.sendEvent) {
      await this.client.sendEvent(roomId, "m.room.message", matrixTextMessage(roomId, body));
    }
  }

  private async sendUnboundNotice(roomId: string): Promise<void> {
    const now = this.now();
    if (now - this.lastUnboundNoticeAt < this.unboundNoticeIntervalMs) return;
    this.lastUnboundNoticeAt = now;
    await this.sendMessage(roomId, "No Companion conversation is available in the configured workspace. Start a Companion conversation there, then restart DSH.");
  }

  /** Stop intake first, then settle queued work and dispose only resumed ownership. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.accepting = false;
    this.queueGeneration += 1;
    for (const pending of [...this.pendingTurns.values()]) this.finishTurn(pending.messageId, undefined);
    for (const dispose of this.listeners.splice(0)) {
      try { dispose(); } catch { this.reportError(); }
    }
    const client = this.client;
    this.client = undefined;
    try { await client?.stopClient?.(); } catch { this.reportError(); }
    await this.queueTail.catch(() => undefined);
    if (this.ownedHandle) {
      const handle = this.ownedHandle;
      this.ownedHandle = undefined;
      try { await handle.dispose(); } catch { this.reportError(); }
    }
    this.boundAgent = undefined;
    this.dedupe.clear();
    this.pendingEventIds.clear();
    this.setReadiness({ state: "disabled" });
  }
}

export function bridgeRpcHandler(bridge: MatrixBridge) {
  return async (endpoint: string, _payload: unknown, _signal: AbortSignal) => {
    if (endpoint !== RPC_ENDPOINT) return {
      ok: false as const,
      error: { code: "not-found", message: "unknown endpoint", details: {} }
    };
    return { ok: true as const, value: bridge.readinessForClient() };
  };
}

export { CREDENTIAL_REF, RPC_CHANNEL, RPC_ENDPOINT };
