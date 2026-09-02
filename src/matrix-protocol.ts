import {
  DEDUPE_LIMIT,
  MAX_PROMPT_CHARS,
  MAX_PROVENANCE_CHARS,
  PACKAGE_NAME,
  type MatrixSettings
} from "./constants.js";

export interface MatrixEventLike {
  getType?: () => string;
  getRoomId?: () => string | undefined;
  getSender?: () => string | undefined;
  getId?: () => string | undefined;
  getContent?: () => Record<string, unknown>;
  getWireContent?: () => Record<string, unknown>;
  getOriginalContent?: () => Record<string, unknown>;
  getUnsigned?: () => Record<string, unknown>;
  event?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MatrixTimelineData {
  timeline?: "live" | "back-paginate" | "forward-paginate" | string;
  liveEvent?: boolean;
  [key: string]: unknown;
}

export interface MatrixRoomLike {
  getTimeline?: () => readonly unknown[];
  timeline?: readonly unknown[];
  getLiveTimeline?: () => { getEvents?: () => readonly unknown[] };
}

export interface MatrixClientLike {
  startClient?: (options?: Record<string, unknown>) => void | Promise<void>;
  stopClient?: () => void | Promise<void>;
  on?: (event: string, listener: (...args: any[]) => void) => unknown;
  off?: (event: string, listener: (...args: any[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: any[]) => void) => unknown;
  sendMessage?: (roomId: string, content: Record<string, unknown>) => Promise<unknown>;
  sendEvent?: (roomId: string, type: string, content: Record<string, unknown>) => Promise<unknown>;
  getRoom?: (roomId: string) => MatrixRoomLike | null | undefined;
  fetchRoomEvent?: (roomId: string, eventId: string) => Promise<MatrixEventLike>;
  getUserId?: () => string | undefined;
}

export interface AdmittedMatrixMessage {
  eventId: string;
  roomId: string;
  sender: string;
  text: string;
  source: MatrixProvenance;
}

/** Extra provenance rides beside the standard plugin source, never in prompt text. */
export interface MatrixProvenance {
  kind: "plugin";
  plugin: typeof PACKAGE_NAME;
  roomId: string;
  sender: string;
  eventId: string;
}

function call<T>(event: MatrixEventLike, method: keyof MatrixEventLike, fallback: T): T {
  const value = event[method];
  if (typeof value === "function") {
    try {
      const result = (value as () => unknown)();
      return (result as T) ?? fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function matrixEventType(event: MatrixEventLike): string | undefined {
  return call(event, "getType", (event.event?.type as string | undefined) ?? (event.type as string | undefined));
}

export function matrixEventRoomId(event: MatrixEventLike): string | undefined {
  return call(event, "getRoomId", (event.event?.room_id as string | undefined) ?? (event.roomId as string | undefined) ?? (event.room_id as string | undefined));
}

export function matrixEventSender(event: MatrixEventLike): string | undefined {
  return call(event, "getSender", (event.event?.sender as string | undefined) ?? (event.sender as string | undefined));
}

export function matrixEventId(event: MatrixEventLike): string | undefined {
  return call(event, "getId", (event.event?.event_id as string | undefined) ?? (event.eventId as string | undefined) ?? (event.event_id as string | undefined));
}

export function matrixEventContent(event: MatrixEventLike): Record<string, unknown> {
  const content = call(event, "getContent", undefined as Record<string, unknown> | undefined);
  if (content && typeof content === "object") return content;
  const original = call(event, "getOriginalContent", undefined as Record<string, unknown> | undefined);
  if (original && typeof original === "object") return original;
  const wire = call(event, "getWireContent", undefined as Record<string, unknown> | undefined);
  if (wire && typeof wire === "object") return wire;
  const fallback = event.event?.content;
  if (fallback && typeof fallback === "object") return fallback as Record<string, unknown>;
  const wireFallback = event.content;
  return wireFallback && typeof wireFallback === "object" ? wireFallback as Record<string, unknown> : {};
}

function relatesTo(content: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = content["m.relates_to"];
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function isReplyRelation(relation: Record<string, unknown> | undefined): string | undefined {
  const reply = relation?.["m.in_reply_to"];
  if (!reply || typeof reply !== "object") return undefined;
  const eventId = (reply as { event_id?: unknown }).event_id;
  return typeof eventId === "string" && eventId ? eventId : undefined;
}

function hasMention(content: Record<string, unknown>, userId: string): boolean {
  const mentions = content["m.mentions"];
  if (!mentions || typeof mentions !== "object") return false;
  const userIds = (mentions as { user_ids?: unknown }).user_ids;
  return Array.isArray(userIds) && userIds.some((candidate) => candidate === userId);
}

function relationIsUnsupported(content: Record<string, unknown>): boolean {
  const relation = relatesTo(content);
  if (!relation) return false;
  const relationType = relation.rel_type;
  if (relationType === "m.replace" || relationType === "m.thread") return true;
  // Only a bare in-reply-to relation is supported by the bridge. References,
  // annotations, and unknown relation forms are not conversational triggers.
  if (relationType !== undefined && relationType !== "") return true;
  return Object.hasOwn(relation, "event_id") && !Object.hasOwn(relation, "m.in_reply_to");
}

function stripReplyFallback(text: string): string {
  let result = text.replace(/^\s*<mx-reply>[\s\S]*?<\/mx-reply>\s*/i, "");
  // Older Matrix clients put a plain-text quote before the actual body. Remove
  // only a contiguous leading quote block so ordinary prose beginning with `>`
  // is not unexpectedly rewritten later in the message.
  const lines = result.split(/\r?\n/);
  while (lines.length > 0 && /^\s*>/.test(lines[0] ?? "")) lines.shift();
  return lines.join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove reply fallback markup and the configured bot mention while retaining human text. */
export function cleanMatrixPrompt(text: string, userId: string): string {
  let result = stripReplyFallback(text).trim();
  const localpart = userId.startsWith("@") ? userId.slice(1).split(":", 1)[0] : userId.split(":", 1)[0];
  const mentionForms = [userId, userId.startsWith("@") ? userId.slice(1) : `@${userId}`, `@${localpart}`]
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
    .map(escapeRegExp);
  if (mentionForms.length > 0) {
    result = result.replace(new RegExp(`(?:^|[\\s])(?:${mentionForms.join("|")})(?=$|[\\s,:;.!?])`, "gi"), " ");
  }
  result = result.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim();
  return result.slice(0, MAX_PROMPT_CHARS).trim();
}

function roomTimelineEvents(room: MatrixRoomLike | null | undefined): readonly unknown[] {
  if (!room) return [];
  try {
    const timeline = room.getTimeline?.();
    if (Array.isArray(timeline)) return timeline;
  } catch {
    // Fall through to the SDK's live-timeline accessor.
  }
  if (Array.isArray(room.timeline)) return room.timeline;
  try {
    const events = room.getLiveTimeline?.()?.getEvents?.();
    if (Array.isArray(events)) return events;
  } catch {
    // A missing/evicted local timeline is resolved over the client API below.
  }
  return [];
}

async function replyAuthorIsBot(
  client: MatrixClientLike,
  roomId: string,
  eventId: string,
  userId: string
): Promise<boolean> {
  let local: readonly unknown[] = [];
  try {
    local = roomTimelineEvents(client.getRoom?.(roomId));
  } catch {
    local = [];
  }
  for (const candidate of local) {
    if (matrixEventId(candidate as MatrixEventLike) !== eventId) continue;
    return matrixEventSender(candidate as MatrixEventLike) === userId;
  }
  if (!client.fetchRoomEvent) return false;
  try {
    const target = await client.fetchRoomEvent(roomId, eventId);
    return matrixEventSender(target) === userId;
  } catch {
    return false;
  }
}

/** A bounded FIFO event-id set; duplicate tracking intentionally is not durable. */
export class EventDeduper {
  private readonly ids = new Set<string>();
  private readonly limit: number;

  constructor(limit = DEDUPE_LIMIT) {
    this.limit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEDUPE_LIMIT;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    this.ids.delete(id);
    this.ids.add(id);
    while (this.ids.size > this.limit) this.ids.delete(this.ids.values().next().value as string);
  }

  clear(): void {
    this.ids.clear();
  }

  get size(): number {
    return this.ids.size;
  }
}

/**
 * Check one Matrix timeline callback and return an admitted prompt. The caller
 * owns dedupe state and invokes this only after initial sync is prepared.
 */
export async function admitMatrixEvent(
  event: MatrixEventLike,
  settings: Pick<MatrixSettings, "roomId" | "userId" | "respondToAll">,
  client: MatrixClientLike,
  toStartOfTimeline = false,
  data?: MatrixTimelineData
): Promise<AdmittedMatrixMessage | undefined> {
  if (toStartOfTimeline || data?.timeline === "back-paginate" || data?.timeline === "forward-paginate" || data?.liveEvent === false) return undefined;
  if (matrixEventType(event) !== "m.room.message") return undefined;
  const roomId = matrixEventRoomId(event);
  if (!roomId || roomId !== settings.roomId) return undefined;
  const sender = matrixEventSender(event);
  const eventId = matrixEventId(event);
  if (!sender || !eventId) return undefined;
  const clientUserId = client.getUserId?.();
  if (sender === settings.userId || (typeof clientUserId === "string" && sender === clientUserId)) return undefined;
  const content = matrixEventContent(event);
  const msgtype = content.msgtype;
  if (msgtype !== "m.text") return undefined;
  if (relationIsUnsupported(content)) return undefined;
  const body = typeof content.body === "string" ? content.body : "";
  const text = cleanMatrixPrompt(body, settings.userId);
  if (!text) return undefined;

  const replyId = isReplyRelation(relatesTo(content));
  if (!settings.respondToAll) {
    const reply = replyId ? await replyAuthorIsBot(client, roomId, replyId, settings.userId) : false;
    if (!hasMention(content, settings.userId) && !reply) return undefined;
  }
  const source: MatrixProvenance = {
    kind: "plugin",
    plugin: PACKAGE_NAME,
    roomId: roomId.slice(0, MAX_PROVENANCE_CHARS),
    sender: sender.slice(0, MAX_PROVENANCE_CHARS),
    eventId: eventId.slice(0, MAX_PROVENANCE_CHARS)
  };
  return { eventId, roomId, sender, text, source };
}

export function matrixTextMessage(roomId: string, body: string): Record<string, unknown> {
  return { msgtype: "m.text", body };
}
