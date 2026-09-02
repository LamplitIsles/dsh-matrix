import { defineTool, type ToolDefinition, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  MAX_MATRIX_TOOL_BODY_CHARS,
  MAX_PROMPT_CHARS,
  MAX_ROOM_MEMBER_ID_CHARS,
  MAX_ROOM_MEMBERS
} from "./constants.js";
import {
  matrixMemberDisplayName,
  matrixTextMessage,
  type MatrixClientLike,
  type MatrixRoomLike
} from "./matrix-protocol.js";

export const MATRIX_LIST_ROOM_MEMBERS = "matrix_list_room_members" as const;
export const MATRIX_SEND_ROOM_MESSAGE = "matrix_send_room_message" as const;

export interface MatrixToolDependencies {
  /** Read the live connection at execution time, never a stale startup copy. */
  getClient: () => MatrixClientLike | undefined;
  /** The restart-scoped room allowlist; tools deliberately have no room argument. */
  roomId: string;
  /** The bridge gate; tools are unavailable before prepared sync or after failure. */
  isReady: () => boolean;
}

export interface MatrixRoomMember {
  userId: string;
  displayName: string;
}

export interface MatrixListRoomMembersResult {
  members: MatrixRoomMember[];
}

export interface MatrixSendRoomMessageResult {
  sent: true;
}

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
  return new Error("Matrix room message could not be sent.");
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

/** Build exactly the two native definitions for one locked Companion scope. */
export function createMatrixToolDefinitions(deps: MatrixToolDependencies): readonly ToolDefinition[] {
  const listTool = defineTool({
    name: MATRIX_LIST_ROOM_MEMBERS,
    description: "List the current joined Matrix room members with their display names and stable user IDs.",
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
    async execute(_args, exec): Promise<MatrixListRoomMembersResult> {
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

  const sendTool = defineTool({
    name: MATRIX_SEND_ROOM_MESSAGE,
    description: `Send one bounded plain-text message to the configured Matrix room (maximum ${MAX_MATRIX_TOOL_BODY_CHARS} characters).`,
    parameters: {
      body: { type: "string", required: true, description: "Plain-text message body." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { sent: { type: "boolean", const: true, required: true } }
      },
      render: (_args, value) => toolText(value.sent ? "Matrix room message sent." : "Matrix room message was not sent.")
    },
    async execute(args, exec): Promise<MatrixSendRoomMessageResult> {
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
        const content = matrixTextMessage(deps.roomId, body);
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
        if (error instanceof Error && (error.message === "Matrix room message could not be sent." || error.message === "Matrix connection or the configured room is unavailable.")) throw error;
        throw sendFailureError();
      }
    }
  });

  return [listTool, sendTool];
}
