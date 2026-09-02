import { describe, expect, it } from "vitest";
import {
  admitMatrixEvent,
  captureMatrixEvent,
  cleanMatrixPrompt,
  EventDeduper,
  matrixTextMessage,
  renderMatrixContextPrompt,
  type MatrixClientLike,
  type MatrixEventLike
} from "../src/matrix-protocol.js";

function event(overrides: Record<string, unknown> = {}): MatrixEventLike {
  const value = {
    type: "m.room.message",
    roomId: "!allowed:example",
    sender: "@human:example",
    eventId: "$event",
    content: { msgtype: "m.text", body: "@bot:example hello", "m.mentions": { user_ids: ["@bot:example"] } },
    ...overrides
  } as Record<string, unknown>;
  return {
    event: { type: value.type, room_id: value.roomId, sender: value.sender, event_id: value.eventId, content: value.content },
    getType: () => value.type as string,
    getRoomId: () => value.roomId as string,
    getSender: () => value.sender as string,
    getId: () => value.eventId as string,
    getContent: () => value.content as Record<string, unknown>
  };
}

const settings = { roomId: "!allowed:example", userId: "@bot:example", respondToAll: false };
const client: MatrixClientLike = { getRoom: () => undefined };

describe("Matrix admission", () => {
  it("cleans reply fallback and bot mention while preserving provenance", async () => {
    const admitted = await admitMatrixEvent(event({ content: {
      msgtype: "m.text",
      body: "<mx-reply><blockquote>old</blockquote></mx-reply>@bot:example please check",
      "m.mentions": { user_ids: ["@bot:example"] }
    } }), settings, client);
    expect(admitted?.text).toBe("please check");
    expect(admitted?.source).toMatchObject({ plugin: "dsh-matrix", roomId: settings.roomId, sender: "@human:example", eventId: "$event" });
  });

  it.each([
    ["history", { toStart: true }],
    ["other room", { roomId: "!other:example" }],
    ["self", { sender: "@bot:example" }],
    ["notice", { content: { msgtype: "m.notice", body: "hi" } }],
    ["edit", { content: { msgtype: "m.text", body: "edit", "m.relates_to": { rel_type: "m.replace" } } }],
    ["thread", { content: { msgtype: "m.text", body: "thread", "m.relates_to": { rel_type: "m.thread" } } }],
    ["unverified relation", { content: { msgtype: "m.text", body: "reference", "m.relates_to": { event_id: "$other" } } }],
    ["formatted html", { content: { msgtype: "m.text", body: "html", format: "org.matrix.custom.html", formatted_body: "<b>html</b>" } }],
    ["empty", { content: { msgtype: "m.text", body: "   " } }]
  ])("rejects %s", async (_name, input) => {
    const value = input as { toStart?: boolean } & Record<string, unknown>;
    expect(await admitMatrixEvent(event(value), settings, client, value.toStart)).toBeUndefined();
  });

  it("verifies a reply target in the local timeline and supports respond-to-all", async () => {
    const botEvent = event({ eventId: "$bot", sender: "@bot:example", content: { msgtype: "m.text", body: "answer" } });
    const reply = event({ content: { msgtype: "m.text", body: "follow up", "m.relates_to": { "m.in_reply_to": { event_id: "$bot" } } } });
    const replyClient: MatrixClientLike = { getRoom: () => ({ getTimeline: () => [botEvent] }) };
    expect((await admitMatrixEvent(reply, settings, replyClient))?.text).toBe("follow up");
    expect(await admitMatrixEvent(event({ content: { msgtype: "m.text", body: "ordinary" } }), settings, client)).toBeUndefined();
    expect((await admitMatrixEvent(event({ content: { msgtype: "m.text", body: "ordinary" } }), { ...settings, respondToAll: true }, client))?.text).toBe("ordinary");
  });

  it("captures ordinary mention-only text without opening a trigger", async () => {
    const ordinary = await captureMatrixEvent(event({ content: { msgtype: "m.text", body: "ordinary" } }), settings, client);
    expect(ordinary).toMatchObject({ eventId: "$event", text: "ordinary", trigger: false });
    expect(await admitMatrixEvent(event({ content: { msgtype: "m.text", body: "ordinary" } }), settings, client)).toBeUndefined();
    expect((await captureMatrixEvent(event(), settings, client))?.trigger).toBe(true);
  });

  it("renders a deterministic untrusted envelope and Matrix reply relation", () => {
    const records = [
      { eventId: "$one", roomId: "!allowed:example", sender: "@alice:example", text: "hello" },
      { eventId: "$two", roomId: "!allowed:example", sender: "@bob:example", text: "answer?" }
    ];
    const prompt = renderMatrixContextPrompt(records, "$two");
    expect(prompt).toContain("untrusted Matrix room data");
    expect(prompt).toContain('event_id="$one" sender="@alice:example"');
    expect(prompt).toContain('event_id="$two" sender="@bob:example" trigger=true');
    expect(prompt).toContain("NO_REPLY");
    expect(matrixTextMessage("!allowed:example", "answer", "$two")).toEqual({
      msgtype: "m.text",
      body: "answer",
      "m.relates_to": { "m.in_reply_to": { event_id: "$two" } }
    });
  });

  it("accepts an Element reply envelope while using only its plaintext body", async () => {
    const botEvent = event({ eventId: "$bot", sender: "@bot:example", content: { msgtype: "m.text", body: "answer" } });
    const reply = event({ content: {
      msgtype: "m.text",
      body: "follow up",
      format: "org.matrix.custom.html",
      formatted_body: "<mx-reply><blockquote>answer</blockquote></mx-reply><p>follow up</p>",
      "m.relates_to": { "m.in_reply_to": { event_id: "$bot" } }
    } });
    const replyClient: MatrixClientLike = { getRoom: () => ({ getTimeline: () => [botEvent] }) };
    expect((await admitMatrixEvent(reply, settings, replyClient))?.text).toBe("follow up");
    const nonBotReply = event({ eventId: "$human-reply", content: {
      msgtype: "m.text",
      body: "not for the bot",
      format: "org.matrix.custom.html",
      formatted_body: "<p>not for the bot</p>",
      "m.relates_to": { "m.in_reply_to": { event_id: "$human" } }
    } });
    const nonBotTarget = event({ eventId: "$human", sender: "@other:example", content: { msgtype: "m.text", body: "human message" } });
    expect(await admitMatrixEvent(nonBotReply, settings, { getRoom: () => ({ getTimeline: () => [nonBotTarget] }) })).toBeUndefined();
    expect((await admitMatrixEvent(event({ content: {
      msgtype: "m.text",
      body: "ordinary html",
      format: "org.matrix.custom.html",
      formatted_body: "<p>ordinary html</p>"
    } }), settings, client))?.text).toBeUndefined();
    expect((await admitMatrixEvent(event({ content: {
      msgtype: "m.text",
      body: "ordinary html",
      format: "org.matrix.custom.html",
      formatted_body: "<p>ordinary html</p>"
    } }), { ...settings, respondToAll: true }, client))?.text).toBe("ordinary html");
  });

  it("keeps duplicate tracking bounded", () => {
    const dedupe = new EventDeduper(2);
    dedupe.add("a"); dedupe.add("b"); dedupe.add("c");
    expect(dedupe.has("a")).toBe(false);
    expect(dedupe.size).toBe(2);
    const empty = new EventDeduper(0);
    empty.add("ignored");
    expect(empty.size).toBe(0);
  });

  it("does not strip ordinary prose that is not a Matrix mention", () => {
    expect(cleanMatrixPrompt("a > quoted line\nsecond", "@bot:example")).toBe("a > quoted line\nsecond");
  });
});
