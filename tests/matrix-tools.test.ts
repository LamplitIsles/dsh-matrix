import { describe, expect, it } from "vitest";
import {
  createMatrixToolDefinitions,
  listJoinedMatrixMembers,
  MATRIX_LIST_ROOM_MEMBERS,
  MATRIX_SEND_ROOM_MESSAGE
} from "../src/matrix-tools.js";
import { MAX_MATRIX_TOOL_BODY_CHARS, MAX_PROMPT_CHARS, MAX_ROOM_MEMBERS } from "../src/constants.js";
import type { MatrixClientLike } from "../src/matrix-protocol.js";

function execution(signal = new AbortController().signal): any {
  return { signal };
}

function definitions(client: MatrixClientLike, roomId = "!allowed:example") {
  return createMatrixToolDefinitions({ getClient: () => client, roomId, isReady: () => true });
}

describe("fixed-room Matrix tools", () => {
  it("lists only a bounded, deterministic current joined roster with display labels", async () => {
    const members = Array.from({ length: MAX_ROOM_MEMBERS + 20 }, (_, index) => ({
      userId: `@member-${String(MAX_ROOM_MEMBERS + 20 - index).padStart(3, "0")}:example`,
      name: `Member ${String(MAX_ROOM_MEMBERS + 20 - index).padStart(3, "0")}`,
      presence: "online",
      powerLevel: 100,
      membership: "join"
    }));
    let requestedRoom = "";
    const client: MatrixClientLike = {
      getRoom: (roomId) => {
        requestedRoom = roomId;
        return { getJoinedMembers: () => members };
      }
    };
    const result = await definitions(client)[0]!.execute({}, execution()) as { members: Array<{ userId: string; displayName: string }> };
    expect(requestedRoom).toBe("!allowed:example");
    expect(result.members).toHaveLength(MAX_ROOM_MEMBERS);
    expect(result.members[0]).toEqual({ userId: "@member-001:example", displayName: "Member 001" });
    expect(result.members.every((member) => member.userId.startsWith("@member-") && member.displayName.startsWith("Member "))).toBe(true);
    expect(result).not.toHaveProperty("userIds");
  });

  it("uses joined membership from the current-room fallback and falls back to IDs", () => {
    const client: MatrixClientLike = {
      getRoom: () => ({
        getMembers: () => [
          { userId: "@joined:example", name: "Joined", membership: "join" },
          { userId: "@blank:example", name: "   ", membership: "join" },
          { userId: "@left:example", membership: "leave" }
        ]
      })
    };
    expect(listJoinedMatrixMembers(client, "!fixed:example")).toEqual([
      { userId: "@blank:example", displayName: "@blank:example" },
      { userId: "@joined:example", displayName: "Joined" }
    ]);
  });

  it("keeps SDK-provided disambiguated labels and deduplicates user IDs", () => {
    const client: MatrixClientLike = {
      getRoom: () => ({
        getJoinedMembers: () => [
          { userId: "@same:example", name: "Same (@same:example)", membership: "join" },
          { userId: "@same:example", name: "stale", membership: "join" },
          { userId: "@other:example", displayName: "Same (@other:example)", membership: "join" }
        ]
      })
    };
    expect(listJoinedMatrixMembers(client, "!fixed:example")).toEqual([
      { userId: "@other:example", displayName: "Same (@other:example)" },
      { userId: "@same:example", displayName: "Same (@same:example)" }
    ]);
  });

  it("bounds the rendered roster contribution", async () => {
    const client: MatrixClientLike = {
      getRoom: () => ({
        getJoinedMembers: () => Array.from({ length: MAX_ROOM_MEMBERS }, (_, index) => ({
          userId: `@member-${index}:example`,
          name: "x".repeat(600),
          membership: "join"
        }))
      })
    };
    const result = await definitions(client)[0]!.execute({}, execution()) as { members: Array<{ userId: string; displayName: string }> };
    const rendered = result.members.map((member) => `${member.displayName} (${member.userId})`).join("\n");
    expect(rendered.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });

  it("sends one ordinary fixed-room m.text event with no relation", async () => {
    const sent: Array<{ roomId: string; content: Record<string, unknown> }> = [];
    const client: MatrixClientLike = {
      sendMessage: async (roomId, content) => { sent.push({ roomId, content }); }
    };
    const tool = definitions(client, "!fixed:example").find((candidate) => candidate.name === MATRIX_SEND_ROOM_MESSAGE)!;
    const result = await tool.execute({ body: "hello group", roomId: "!attacker:example" } as any, execution());
    expect(result).toEqual({ sent: true });
    expect(sent).toEqual([{ roomId: "!fixed:example", content: { msgtype: "m.text", body: "hello group" } }]);
  });

  it("resolves exact current display labels to intentional Matrix mentions", async () => {
    const sent: Array<{ roomId: string; content: Record<string, unknown> }> = [];
    const client: MatrixClientLike = {
      getRoom: () => ({
        getJoinedMembers: () => [
          { userId: "@alice:example", name: "Alice", membership: "join" },
          { userId: "@bob:example", name: "Bob", membership: "join" }
        ]
      }),
      sendMessage: async (roomId, content) => { sent.push({ roomId, content }); }
    };
    const tool = definitions(client, "!fixed:example").find((candidate) => candidate.name === MATRIX_SEND_ROOM_MESSAGE)!;
    await tool.execute({ body: "hello @people", mentions: ["Alice", "Alice", "Bob"] }, execution());
    expect(sent).toEqual([{
      roomId: "!fixed:example",
      content: {
        msgtype: "m.text",
        body: "hello @people",
        "m.mentions": { user_ids: ["@alice:example", "@bob:example"] }
      }
    }]);
  });

  it("treats omitted and empty mentions as the existing no-mention payload", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client: MatrixClientLike = {
      getRoom: () => ({ getJoinedMembers: () => [{ userId: "@alice:example", name: "Alice", membership: "join" }] }),
      sendMessage: async (_roomId, content) => { sent.push(content); }
    };
    const tool = definitions(client)[1]!;
    await tool.execute({ body: "without mentions" }, execution());
    await tool.execute({ body: "empty mentions", mentions: [] }, execution());
    expect(sent).toEqual([
      { msgtype: "m.text", body: "without mentions" },
      { msgtype: "m.text", body: "empty mentions" }
    ]);
  });

  it("rejects stale, direct-ID, ambiguous, and special labels before sending", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client: MatrixClientLike = {
      getRoom: () => ({
        getJoinedMembers: () => [
          { userId: "@alice:example", name: "Alice", membership: "join" },
          { userId: "@bob:example", name: "Bob", membership: "join" },
          { userId: "@one:example", name: "Same", membership: "join" },
          { userId: "@two:example", name: "Same", membership: "join" }
        ]
      }),
      sendMessage: async (_roomId, content) => { sent.push(content); }
    };
    const tool = definitions(client)[1]!;
    for (const label of ["Missing", "alice", " @alice:example", "@alice:example", "@room", "Same"]) {
      await expect(tool.execute({ body: "must not send", mentions: [label] }, execution()))
        .rejects.toThrow(new RegExp(label.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
    }
    await expect(tool.execute({ body: "must not send", mentions: ["Missing"] }, execution()))
      .rejects.toThrow(/\["Alice","Bob","Same"\]/);
    await expect(tool.execute({ body: "must not send", mentions: ["Missing"] }, execution()))
      .rejects.not.toThrow("@alice:example");
    expect(sent).toHaveLength(0);
  });

  it("fails closed when the local roster changes after label resolution", async () => {
    const sent: Array<Record<string, unknown>> = [];
    let reads = 0;
    const client: MatrixClientLike = {
      getRoom: () => ({
        getJoinedMembers: () => {
          reads += 1;
          return reads === 1
            ? [{ userId: "@alice:example", name: "Alice", membership: "join" }]
            : [{ userId: "@alice:example", name: "Renamed", membership: "join" }];
        }
      }),
      sendMessage: async (_roomId, content) => { sent.push(content); }
    };
    const tool = definitions(client)[1]!;
    await expect(tool.execute({ body: "stale", mentions: ["Alice"] }, execution()))
      .rejects.toThrow(/\["Renamed"\]/);
    expect(sent).toHaveLength(0);
  });

  it("rejects invalid bodies, unavailable connections, and cancellation with bounded errors", async () => {
    const tool = definitions({ sendMessage: async () => undefined })[1]!;
    await expect(tool.execute({ body: "   " }, execution())).rejects.toThrow("non-empty");
    await expect(tool.execute({ body: "x".repeat(MAX_MATRIX_TOOL_BODY_CHARS + 1) }, execution())).rejects.toThrow("at most");

    const unavailable = definitions(undefined as unknown as MatrixClientLike)[1]!;
    await expect(unavailable.execute({ body: "hello" }, execution())).rejects.toThrow("unavailable");

    const controller = new AbortController();
    controller.abort();
    await expect(tool.execute({ body: "hello" }, execution(controller.signal))).rejects.toThrow("cancelled");
    const broken = definitions({ getRoom: () => { throw new Error("secret token from Matrix"); } } as MatrixClientLike)[0]!;
    await expect(broken.execute({}, execution())).rejects.toThrow("unavailable");
    await expect(broken.execute({}, execution())).rejects.not.toThrow("secret token");
  });

  it("exposes exactly the two native names and no room parameter", () => {
    const tools = definitions({});
    expect(tools.map((tool) => tool.name)).toEqual([MATRIX_LIST_ROOM_MEMBERS, MATRIX_SEND_ROOM_MESSAGE]);
    expect(tools[0]!.parameters).toMatchObject({ type: "object", properties: {} });
    expect(tools[1]!.parameters).toMatchObject({
      type: "object",
      properties: { body: { type: "string" }, mentions: { type: "array", items: { type: "string" } } },
      required: ["body"]
    });
    expect(tools[1]!.parameters).not.toHaveProperty("roomId");
  });
});
