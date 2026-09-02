# DSH Matrix Bridge

This context describes how a Matrix identity carries group-chat messages into an existing DeepSeek Harness companion conversation.

## Language

**Matrix connection**:
A configured Matrix identity consisting of a homeserver, Matrix user ID, and access-token credential.
_Avoid_: Account, bot account

**Workspace binding**:
The required association between a Matrix connection and one DSH workspace whose existing conversation receives Matrix messages.
_Avoid_: Session binding

**Active conversation**:
The existing DSH session in the bound workspace that most recently received a human prompt when the bridge starts. The bridge keeps that conversation for its lifetime and never creates one.
_Avoid_: Matrix session, configured session

**Allowed room**:
The single Matrix room from which the bridge accepts messages and to which it sends replies.
_Avoid_: Channel, chat

**Mention-only mode**:
The default response policy in which a room message triggers the companion only when it mentions or replies to the Matrix identity.
_Avoid_: Silent mode

**Room context buffer**:
The bounded, in-memory sequence of eligible messages from the allowed room that have not yet been supplied to the active conversation. It is drained into one Matrix-triggered prompt when a reply trigger arrives, and is cleared on restart.
_Avoid_: Queue

**Reply trigger**:
An allowed-room message that mentions the Matrix identity or is a verified reply to its message. A reply trigger drains the room context buffer, starts one companion turn, and receives that turn's Matrix reply.
_Avoid_: Mention

**Suppressed Matrix reply**:
An otherwise completed Matrix-triggered turn whose final assistant text is the exact sentinel `NO_REPLY`; its text remains in the Companion conversation but is not sent to the allowed room.
_Avoid_: No-op, skipped turn

**Matrix context envelope**:
The deterministic plugin-authored user message that quotes drained room-context records, labels their Matrix sender and event identities, marks them as untrusted data, names the reply trigger, and explains the exact `NO_REPLY` suppression token.
_Avoid_: Raw room transcript, prompt injection

**Matrix provenance**:
The bounded plugin source attached to a Matrix context envelope for Host-side attribution. It retains the allowed room, triggering event, sender, relation target when present, and the drained record identities without depending on provider serialization for model visibility.
_Avoid_: Provider metadata, display name

**Matrix reply anchor**:
The triggering Matrix event ID carried in the outbound `m.relates_to.m.in_reply_to` relation. A reply anchor always points to the explicit trigger, never to an older buffered context record.
_Avoid_: Thread, quote fallback

**Fixed-room Matrix tools**:
The two native tools scoped to the locked active Companion: `matrix_list_room_members` and `matrix_send_room_message`. Neither accepts a room ID; both derive the one restart-scoped allowed room, require a usable PREPARED bridge, and disappear when the bridge stops or releases ownership.
_Avoid_: Matrix-wide tools, room selector

**Joined-user roster**:
The bounded sorted Matrix user-ID list returned by `matrix_list_room_members` from the allowed room's current joined membership state. It excludes profile, presence, power-level, membership-history, and other-room data.
_Avoid_: Display-name roster, member history

**Fixed-room Matrix send**:
The bounded plain-text operation performed by `matrix_send_room_message`, which emits one ordinary `m.text` event to the allowed room through DSH's existing approval and cancellation pipeline. It cannot impersonate, reply, thread, or choose another room.
_Avoid_: Matrix reply tool, arbitrary room send

**DSH-only proactive turn**:
A Web/CLI-initiated Companion turn that uses the fixed-room send tool. Its bot-authored event is ignored by the bridge, so the turn's final Assistant text remains in DSH and cannot start a Matrix-triggered follow-up.
_Avoid_: Tool-triggered Matrix turn
