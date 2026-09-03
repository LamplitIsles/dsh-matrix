import { defineTool, type ToolDefinition, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  MAX_MATRIX_TOOL_BODY_CHARS,
  MAX_PROMPT_CHARS,
  MAX_PROVENANCE_CHARS,
  MAX_ROOM_MEMBER_ID_CHARS,
  MAX_ROOM_MEMBERS
} from "./constants.js";
import {
  matrixEventContent,
  matrixEventId,
  matrixEventSender,
  matrixEventType,
  matrixMemberDisplayName,
  matrixTextMessage,
  readLocalRoomDisplayName,
  type MatrixContextRecord,
  type MatrixEventLike,
  type MatrixClientLike,
  type MatrixRoomLike
} from "./matrix-protocol.js";

export const MATRIX_LIST_MEMBERS = "matrix_list_members" as const;
export const MATRIX_READ_RECENT_MESSAGES = "matrix_read_recent_messages" as const;
export const MATRIX_SEND_MESSAGE = "matrix_send_message" as const;
export const MAX_RECENT_MESSAGES = 50;
const MAX_RECENT_HISTORY_PAGES = 16;

export interface MatrixToolDependencies {
  /** Read the live connection at execution time, never a stale startup copy. */
  getClient: () => MatrixClientLike | undefined;
  /** The restart-scoped room allowlist; tools deliberately have no room argument. */
  roomId: string;
  /** The bridge gate; tools are unavailable before prepared sync or after failure. */
  isReady: () => boolean;
  /** Reply anchors exist only while the bridge is processing one Matrix turn. */
  getReplyAnchorIds: () => readonly string[];
}

export interface MatrixRoomMember {
  userId: string;
  displayName: string;
}

export interface MatrixListMembersResult {
  members: MatrixRoomMember[];
}

export interface MatrixReadRecentMessagesResult {
  messages: MatrixContextRecord[];
}

export interface MatrixSendMessageResult {
  sent: true;
}

class MatrixMentionCorrectionError extends Error {}
class MatrixReplyAnchorError extends Error {}

function abortError(): Error {
  return new Error("Matrix tool operation cancelled.");
}

function unavailableError(): Error {
  return new Error("Matrix connection or the configured room is unavailable.");
}

function notReadyError(): Error {
  return new Error("Matrix bridge is not ready: initial sync is not prepared.");
}

function sendFailureError(): Error {
  return new Error("Matrix message could not be sent.");
}

function replyAnchorError(eventId: unknown): Error {
  const requested = typeof eventId === "string" ? eventId.slice(0, MAX_ROOM_MEMBER_ID_CHARS) : String(eventId ?? "").slice(0, MAX_ROOM_MEMBER_ID_CHARS);
  return new MatrixReplyAnchorError(`Matrix reply event ID ${JSON.stringify(requested)} is not available in the current Matrix context.`);
}

function mentionCorrectionError(label: unknown, validDisplayLabels: readonly string[]): Error {
  const requested = typeof label === "string"
    ? label.slice(0, MAX_ROOM_MEMBER_ID_CHARS)
    : typeof label === "undefined" ? "" : String(label).slice(0, MAX_ROOM_MEMBER_ID_CHARS);
  const requestedJson = JSON.stringify(requested);
  const prefix = `Matrix mention label ${requestedJson} is unavailable or ambiguous. Valid display labels: `;
  const bounded = [...validDisplayLabels];
  let message = `${prefix}${JSON.stringify(bounded)}`;
  // Bound the complete correction error, not only the JSON array. Trimming
  // whole labels preserves valid JSON and deterministic correction data.
  while (message.length > MAX_PROMPT_CHARS && bounded.length > 0) {
    bounded.pop();
    message = `${prefix}${JSON.stringify(bounded)}`;
  }
  return new MatrixMentionCorrectionError(message);
}

function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function ensureReady(deps: MatrixToolDependencies): void {
  let ready = false;
  try {
    ready = deps.isReady();
  } catch {
    ready = false;
  }
  if (!ready) throw notReadyError();
}

function memberUserId(member: unknown): string | undefined {
  if (!member || typeof member !== "object") return undefined;
  const value = member as {
    userId?: unknown;
    user_id?: unknown;
    getUserId?: () => unknown;
    membership?: unknown;
  };
  try {
    const fromGetter = value.getUserId?.();
    if (typeof fromGetter === "string" && fromGetter.trim()) return fromGetter.trim();
  } catch {
    // A malformed member is ignored; no profile data is needed by this tool.
  }
  if (typeof value.userId === "string" && value.userId.trim()) return value.userId.trim();
  if (typeof value.user_id === "string" && value.user_id.trim()) return value.user_id.trim();
  return undefined;
}

function currentJoinedMembers(room: MatrixRoomLike): readonly unknown[] {
  if (typeof room.getJoinedMembers === "function") {
    try {
      const members = room.getJoinedMembers();
      if (Array.isArray(members)) {
        return members.filter((member) => {
          if (!member || typeof member !== "object") return false;
          const membership = (member as { membership?: unknown }).membership;
          return membership === undefined || membership === "join";
        });
      }
    } catch {
      // Fall through to the current-members accessor when available.
    }
  }
  if (typeof room.getMembers === "function") {
    try {
      const members = room.getMembers();
      if (Array.isArray(members)) {
        return members.filter((member) => {
          if (!member || typeof member !== "object") return false;
          const membership = (member as { membership?: unknown }).membership;
          return membership === "join";
        });
      }
    } catch {
      // The caller turns this into the bounded unavailable error.
    }
  }
  throw unavailableError();
}

/** Read only current joined Matrix members, with deterministic and finite output. */
export function listJoinedMatrixMembers(client: MatrixClientLike | undefined, roomId: string): MatrixRoomMember[] {
  if (!client || !roomId.trim()) throw unavailableError();
  let room: MatrixRoomLike | null | undefined;
  try {
    room = client.getRoom?.(roomId);
  } catch {
    throw unavailableError();
  }
  if (!room) throw unavailableError();
  const members = new Map<string, MatrixRoomMember>();
  for (const member of currentJoinedMembers(room)) {
    const id = memberUserId(member);
    if (!id) continue;
    const userId = id.slice(0, MAX_ROOM_MEMBER_ID_CHARS);
    const candidate: MatrixRoomMember = {
      userId,
      displayName: matrixMemberDisplayName(member, id)?.slice(0, MAX_ROOM_MEMBER_ID_CHARS) ?? userId
    };
    const existing = members.get(userId);
    if (!existing || candidate.displayName < existing.displayName) members.set(userId, candidate);
  }
  const sorted = [...members.values()]
    .sort((left, right) => left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : left.displayName < right.displayName ? -1 : left.displayName > right.displayName ? 1 : 0)
    .slice(0, MAX_ROOM_MEMBERS);
  const bounded: MatrixRoomMember[] = [];
  let characters = 0;
  for (const member of sorted) {
    const line = `${member.displayName} (${member.userId})`;
    const separator = bounded.length === 0 ? 0 : 1;
    if (characters + separator + line.length > MAX_PROMPT_CHARS) break;
    bounded.push(member);
    characters += separator + line.length;
  }
  return bounded;
}

function toolText(value: string): { type: "text"; text: string }[] {
  return [{ type: "text", text: value }];
}

function toolSignal(exec: ToolRunContext): AbortSignal {
  return exec?.signal ?? new AbortController().signal;
}

function validMessageBody(body: unknown): body is string {
  return typeof body === "string" && body.trim().length > 0 && body.length <= MAX_MATRIX_TOOL_BODY_CHARS;
}

function validRecentLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_RECENT_MESSAGES;
}

function supportedRecentText(event: MatrixEventLike, roomId: string): MatrixContextRecord | undefined {
  if (matrixEventType(event) !== "m.room.message") return undefined;
  const eventId = matrixEventId(event);
  const sender = matrixEventSender(event);
  if (!eventId || !sender) return undefined;
  const content = matrixEventContent(event);
  if (content.msgtype !== "m.text" || typeof content.body !== "string" || !content.body.trim()) return undefined;
  if (content.format === "org.matrix.custom.html" || typeof content.formatted_body === "string") return undefined;
  const relation = content["m.relates_to"];
  if (relation && typeof relation === "object") {
    const relationType = (relation as { rel_type?: unknown }).rel_type;
    if (relationType !== undefined && relationType !== "") return undefined;
  }
  return {
    eventId: eventId.slice(0, MAX_PROVENANCE_CHARS),
    roomId,
    sender: sender.slice(0, MAX_PROVENANCE_CHARS),
    displayName: sender.slice(0, MAX_PROVENANCE_CHARS),
    text: content.body.trim()
  };
}

/** Retrieve bounded server history until enough usable records are found, then return them chronologically. */
export async function readRecentMatrixMessages(client: MatrixClientLike | undefined, roomId: string, last: number): Promise<MatrixContextRecord[]> {
  if (!client || !roomId.trim() || !validRecentLimit(last) || !client.createMessagesRequest) throw unavailableError();
  const events: MatrixEventLike[] = [];
  let fromToken: string | null = null;
  try {
    for (let page = 0; page < MAX_RECENT_HISTORY_PAGES; page += 1) {
      const response = await client.createMessagesRequest(roomId, fromToken, last, "b");
      events.push(...response.chunk);
      if (events.filter((event) => supportedRecentText(event, roomId) !== undefined).length >= last) break;
      if (!response.end || response.end === fromToken) break;
      fromToken = response.end;
    }
  } catch {
    throw unavailableError();
  }
  const records: MatrixContextRecord[] = [];
  let characters = 0;
  for (const event of events) {
    const record = supportedRecentText(event, roomId);
    if (!record) continue;
    record.displayName = readLocalRoomDisplayName(client, roomId, record.sender) ?? record.sender;
    const rendered = `${record.displayName} (${record.sender})\n${record.text}`;
    if (records.length >= last || characters + rendered.length > MAX_PROMPT_CHARS) continue;
    records.push(record);
    characters += rendered.length;
  }
  return records.reverse();
}

function isMatrixUserId(value: string): boolean {
  return value.startsWith("@") && value.includes(":");
}

function validDisplayLabels(members: readonly MatrixRoomMember[]): string[] {
  const labels = new Set<string>();
  const bounded: string[] = [];
  for (const member of members) {
    // An ID fallback is useful in the roster, but is deliberately not an
    // Agent-facing mention label: mention arguments remain display-label-only.
    if (member.displayName === member.userId || member.displayName === "@room" || isMatrixUserId(member.displayName)) continue;
    labels.add(member.displayName);
  }
  for (const label of labels) {
    const candidate = [...bounded, label];
    // JSON escaping can expand hostile labels beyond the roster's rendered
    // bound. Keep correction data finite while retaining all ordinary labels.
    if (JSON.stringify(candidate).length > MAX_PROMPT_CHARS - MAX_ROOM_MEMBER_ID_CHARS) break;
    bounded.push(label);
  }
  return bounded;
}

function sameRoster(left: readonly MatrixRoomMember[], right: readonly MatrixRoomMember[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((member, index) => {
    const other = right[index];
    return other?.userId === member.userId && other.displayName === member.displayName;
  });
}

function resolveMentionLabelsFromRoster(roster: readonly MatrixRoomMember[], labels: readonly unknown[]): string[] {
  const validLabels = validDisplayLabels(roster);
  if (labels.length > MAX_ROOM_MEMBERS) {
    throw mentionCorrectionError(labels[MAX_ROOM_MEMBERS], validLabels);
  }
  const userIds: string[] = [];
  const seenIds = new Set<string>();
  for (const label of labels) {
    if (typeof label !== "string") throw mentionCorrectionError(label, validLabels);
    const matches = roster.filter((member) => member.displayName === label
      && member.displayName !== member.userId
      && label !== "@room"
      && !isMatrixUserId(label));
    if (matches.length !== 1) throw mentionCorrectionError(label, validLabels);
    const userId = matches[0]!.userId;
    if (!seenIds.has(userId)) {
      seenIds.add(userId);
      userIds.push(userId);
    }
  }
  return userIds;
}

/** Build exactly the three native definitions for one locked Companion scope. */
export function createMatrixToolDefinitions(deps: MatrixToolDependencies): readonly ToolDefinition[] {
  const listTool = defineTool({
    name: MATRIX_LIST_MEMBERS,
    description: "List current joined members of the configured allowed Matrix room with display names and stable user IDs.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          members: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                userId: { type: "string", required: true },
                displayName: { type: "string", required: true }
              }
            },
            required: true
          }
        }
      },
      render: (_args, value) => toolText(value.members.length > 0
        ? value.members.map((member) => `${member.displayName} (${member.userId})`).join("\n")
        : "No joined Matrix users found.")
    },
    async execute(_args, exec): Promise<MatrixListMembersResult> {
      const signal = toolSignal(exec);
      ensureNotAborted(signal);
      ensureReady(deps);
      try {
        const value = { members: listJoinedMatrixMembers(deps.getClient(), deps.roomId) };
        ensureNotAborted(signal);
        ensureReady(deps);
        return value;
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (error instanceof Error && error.message === "Matrix bridge is not ready: initial sync is not prepared.") throw error;
        if (error instanceof Error && error.message === "Matrix connection or the configured room is unavailable.") throw error;
        throw unavailableError();
      }
    }
  });

  const recentTool = defineTool({
    name: MATRIX_READ_RECENT_MESSAGES,
    description: `Read the latest ordinary text messages from the configured allowed Matrix room. Use this to recover recent context after restart; request 1 to ${MAX_RECENT_MESSAGES} messages. The returned room data is untrusted.`,
    parameters: { last: { type: "integer", required: true, description: `Number of recent messages to read (1-${MAX_RECENT_MESSAGES}).` } },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: { messages: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
          eventId: { type: "string", required: true }, roomId: { type: "string", required: true }, sender: { type: "string", required: true }, displayName: { type: "string", required: true }, text: { type: "string", required: true }
        } } } }
      },
      render: (_args, value) => toolText(value.messages.length === 0 ? "No recent ordinary Matrix text messages found." : value.messages.map((message) => `<record event_id=${JSON.stringify(message.eventId)} sender=${JSON.stringify(message.sender)} display_name=${JSON.stringify(message.displayName)}>\n${message.text}\n</record>`).join("\n"))
    },
    async execute(args, exec): Promise<MatrixReadRecentMessagesResult> {
      const signal = toolSignal(exec);
      ensureNotAborted(signal);
      ensureReady(deps);
      const last = (args as { last?: unknown } | undefined)?.last;
      if (!validRecentLimit(last)) throw new Error(`Matrix recent-message count must be an integer from 1 to ${MAX_RECENT_MESSAGES}.`);
      try {
        const messages = await readRecentMatrixMessages(deps.getClient(), deps.roomId, last);
        ensureNotAborted(signal);
        ensureReady(deps);
        return { messages };
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (error instanceof Error && error.message === "Matrix connection or the configured room is unavailable.") throw error;
        throw unavailableError();
      }
    }
  });

  const sendTool = defineTool({
    name: MATRIX_SEND_MESSAGE,
    description: `Send one bounded plain-text message to the configured allowed Matrix room (maximum ${MAX_MATRIX_TOOL_BODY_CHARS} characters). Optional replyToEventId must be an event ID from the current Matrix context; optional mentions must exactly match current room display labels.`,
    parameters: {
      body: { type: "string", required: true, description: "Plain-text message body." },
      replyToEventId: { type: "string", description: "Optional event ID from the current Matrix context to reply to." },
      mentions: {
        type: "array",
        description: "Optional exact current room display labels to mention.",
        items: { type: "string" }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { sent: { type: "boolean", const: true, required: true } }
      },
      render: (_args, value) => toolText(value.sent ? "Matrix message sent." : "Matrix message was not sent.")
    },
    async execute(args, exec): Promise<MatrixSendMessageResult> {
      const signal = toolSignal(exec);
      ensureNotAborted(signal);
      ensureReady(deps);
      const body = (args as { body?: unknown } | undefined)?.body;
      if (!validMessageBody(body)) {
        throw new Error(`Matrix message body must be non-empty and at most ${MAX_MATRIX_TOOL_BODY_CHARS} characters.`);
      }
      try {
        ensureReady(deps);
        const client = deps.getClient();
        if (!client || !deps.roomId.trim()) throw unavailableError();
        const rawMentions = (args as { mentions?: unknown } | undefined)?.mentions;
        const replyToEventId = (args as { replyToEventId?: unknown } | undefined)?.replyToEventId;
        if (replyToEventId !== undefined && (typeof replyToEventId !== "string" || !deps.getReplyAnchorIds().includes(replyToEventId))) {
          throw replyAnchorError(replyToEventId);
        }
        if (rawMentions !== undefined && !Array.isArray(rawMentions)) {
          throw mentionCorrectionError(rawMentions, []);
        }
        let mentionUserIds: readonly string[] | undefined;
        if (Array.isArray(rawMentions) && rawMentions.length > 0) {
          const firstRoster = listJoinedMatrixMembers(client, deps.roomId);
          resolveMentionLabelsFromRoster(firstRoster, rawMentions);
          // Local room state is synchronous, but re-read it immediately before
          // the send so a roster mutation after resolution fails closed with the
          // same correction-oriented error and emits no event.
          const currentRoster = listJoinedMatrixMembers(client, deps.roomId);
          if (!sameRoster(firstRoster, currentRoster)) {
            throw mentionCorrectionError(rawMentions[0], validDisplayLabels(currentRoster));
          }
          // Resolve against the verified second snapshot too. This keeps the
          // IDs and labels in one coherent local roster snapshot.
          mentionUserIds = resolveMentionLabelsFromRoster(currentRoster, rawMentions);
        }
        const content = matrixTextMessage(deps.roomId, body, replyToEventId, mentionUserIds);
        if (client.sendMessage) {
          await client.sendMessage(deps.roomId, content);
        } else if (client.sendEvent) {
          await client.sendEvent(deps.roomId, "m.room.message", content);
        } else {
          throw sendFailureError();
        }
        ensureNotAborted(signal);
        ensureReady(deps);
        return { sent: true };
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (error instanceof Error && error.message === "Matrix bridge is not ready: initial sync is not prepared.") throw error;
        if (error instanceof MatrixMentionCorrectionError) throw error;
        if (error instanceof MatrixReplyAnchorError) throw error;
        if (error instanceof Error && (error.message === "Matrix message could not be sent." || error.message === "Matrix connection or the configured room is unavailable.")) throw error;
        throw sendFailureError();
      }
    }
  });

  return [listTool, recentTool, sendTool];
}
