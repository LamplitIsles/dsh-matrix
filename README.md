# dsh-matrix

`@lamplitisles/dsh-matrix` is a DSH `0.1.2-alpha.3` plugin that connects one
Matrix identity and one room to one already-existing DeepSeek Harness Companion
conversation. It never creates a session and never changes the conversation
selected after startup.

## Requirements and installation

- DSH `0.1.2-alpha.3` with the native web settings surface
- Node.js 22 or newer
- A Matrix account that has already joined the allowed room
- An access token for that account (password and SSO login are not implemented)

Install the package in the DSH deployment that owns your bundle registry:

```sh
npm install @lamplitisles/dsh-matrix@0.1.2-alpha.3
```

The package declares the DSH Host/client bundle patch. Restart DSH after
installing it, after changing a field, and after revoking/replacing a token.

## Settings

Open the native plugin settings card and fill in:

- **Homeserver URL** — the `https://` (or `http://` for a deliberately local
  deployment) base URL, without a Matrix API path.
- **Matrix user ID** — the full ID, such as `@companion:example.org`, for the
  identity represented by the token.
- **Allowed room ID** — one Matrix room ID, such as `!room:example.org`.
  Messages from every other room are ignored and every reply is sent back only
  to this room.
- **Companion workspace** — selected from the DSH workspace list. The bridge
  inspects this workspace at startup and locks the most recently human-active
  eligible existing session (archived, blank, and subagent sessions are
  excluded). It does not offer a session selector.
- **Element access token** — a write-only DSH credential. Enter a new value to
  replace the stored credential; leaving it blank preserves the existing one.
- **Respond to all messages** — off by default. With it off, a message must
  mention the configured Matrix user in `m.mentions` or be a verified reply to
  a message authored by that user. With it on, every otherwise eligible text
  message in the room can trigger the bridge.

The card shows only whether the credential is configured, never the token.
Readiness is bounded to states such as connecting, bound, unbound, or failed;
provider and Matrix errors are not copied into settings or room messages.

## Getting and revoking an Element token

In Element, open the account/settings area for the account that will be the
bot, find the **Help & About** (or account security) section, and use the
**Access Token** / **Developer** token action exposed by that Element build.
Copy the token once into the DSH card and save. Element's menus differ between
web, desktop, and mobile releases; if the action is not visible, use the
account's supported developer/session-token screen rather than entering a
password into this plugin. The Matrix identity must already have joined the
room; the bridge does not invite or auto-join it.

To revoke a token, use Element's account/session management to sign out or
revoke that session (or revoke all sessions if that is the only control), then
replace or clear the DSH credential and restart DSH. A revoked token cannot be
recovered by the plugin.

## Runtime behavior and security boundary

After startup, the plugin performs one workspace/session selection and opens one
`matrix-js-sdk@42.3.0` client. It begins processing only after initial sync is
prepared. It accepts new `m.room.message` text events from the allowed room and
ignores history, pagination, notices, the bot's own messages,
edits/replacements, threads, empty text, and duplicate event IDs. Reply
fallback markup and the bot mention are removed before the prompt is sent.
Element reply envelopes may include `format`/`formatted_body`; the bridge
verifies the referenced event author and uses only the plaintext `body`.
Formatted HTML is never rendered or treated as prompt content.

Every eligible external text message is captured in timeline order in a
bounded, in-memory room context buffer. In mention-only mode an ordinary
message adds context but does not open a turn. A mention, verified reply, or
literal occurrence of the identity's current non-empty room display label (for
example, `汐`) drains the FIFO buffer atomically (the triggering message
included) into one Matrix-initiated turn; **Respond to all messages** makes each
eligible message a trigger. The label is read from local room member state and
matched as a literal substring, with no profile lookup. Messages that arrive
while a turn is pending stay in the next buffer.

The resulting ordinary DSH user message contains a deterministic
plugin-authored envelope. Each record uses the sender's current room display
label as its primary speaker label alongside the stable Matrix user ID and
event ID; missing labels fall back to the ID. The envelope identifies the
trigger and marks room records as untrusted data. Routing metadata stays
bridge-owned rather than plugin-sourcing the composite, so an enabled Hindsight
companion-memory plugin applies its normal user-turn recall and retention to
the Matrix transcript and final answer; Hindsight's plugin-origin recall
injection remains outside that path. The transcript is durable DSH/model input,
so the selected room is a deliberate privacy boundary.

Admitted prompts are serialized because they share one locked Agent. The bridge
waits for the exact Matrix-initiated turn and sends only its final non-empty
assistant text as one `m.text` reply related to the triggering event. Tool
output, intermediate assistant messages, and activity initiated by Web or CLI
are not relayed. If the final text, after trimming, is exactly `NO_REPLY`, it is
retained in DSH but no Matrix message is sent.

The locked Companion also receives exactly two native tools in its scoped
conversation:

- **`matrix_list_room_members`** takes no arguments and returns a bounded (at
  most 128 entries and 16,000 rendered characters), sorted list of
  `{ userId, displayName }` entries for current joined members of the
  configured room only. `displayName` is the current local room label (which
  the Matrix SDK may disambiguate) and falls back to `userId` when unavailable.
  It intentionally omits avatars, presence, power levels, membership history,
  and every other room.
- **`matrix_send_room_message`** takes one non-empty plain-text `body` of at
  most 16,000 characters and sends one ordinary `m.text` event to the
  configured room. It has no room argument and cannot impersonate, reply, or
  create a thread. The normal DSH tool approval and cancellation pipeline
  still applies. Tools return a bounded not-ready error before initial sync is
  **PREPARED** and after a sync **ERROR**; other unavailable Matrix connections
  produce the same bounded failure boundary.

These registrations belong only to the startup-locked Companion and are
removed when the bridge stops or ownership is released. A Web/CLI-initiated
turn may use the send tool to greet the room; that turn's final Assistant text
stays in DSH because it has no Matrix pending-turn attribution, and the
bot-authored event is ignored by the bridge so it cannot retrigger a turn.

If no eligible conversation existed when DSH started, the Matrix client stays
connected but the bridge remains **unbound** until the next restart. A
qualifying trigger receives at most one concise reminder per minute to start a
Companion conversation in the selected workspace and restart DSH. Saving
settings never switches the running client or conversation; restart is the
explicit boundary.

The access token is resolved only through the package-owned DSH credential
reference. It is not part of settings snapshots, readiness RPC responses,
provenance, logs, or room replies. The one-room allowlist and one-account
client are hard boundaries, not UI suggestions.

## Unsupported limitations

This alpha intentionally does not support end-to-end encryption or crypto/device
persistence, media/files, formatted HTML rendering (formatted reply HTML is
ignored), threads, reactions, moderation,
invites/auto-join, streaming output or `m.replace` edits, multiple rooms or
accounts, per-room/session selection, live switching, automatic session
creation, password/SSO login, durable sync tokens, durable deduplication,
transactional outbox, or exactly-once delivery guarantees. The fixed-room
tools do not provide room selection, profile lookup, presence, power levels,
membership history, invitations, moderation, media/HTML,
threads, reactions, or any other Matrix account capability.

## Operator verification

1. Install the package and restart DSH.
2. Select a workspace that already has a normal human prompt, enter the room
   and account values, write the Element token, and save.
3. Restart DSH again and confirm the card reports **bound** (or the expected
   bounded missing/unbound state).
4. In the allowed room, send two ordinary messages followed by a mention,
   verified reply, or the Matrix identity's current room display label. Confirm
   the bounded-context answer replies to that event. Send a notice, edit,
   thread, and another-room message; confirm none enters context or replies.
5. Ask the companion to answer exactly `NO_REPLY` and confirm that the turn is
   visible in DSH but no room message is sent. Toggle **Respond to all**, save,
   restart, and verify an ordinary text message triggers.
6. Ask the locked Companion to call `matrix_list_room_members`; verify only
   bounded `{ userId, displayName }` entries from the configured room. Ask it to call
   `matrix_send_room_message` with a short greeting and confirm the single
   plain-text room message, DSH approval prompt, and absence of a second bridge
   turn. Try an empty/overlong body and an unavailable connection to confirm
   bounded errors.
7. Stop/reload DSH and confirm the Matrix client, listeners, queued work,
   scoped tool registrations, and any plugin-resumed Agent stop before a new
   instance starts.

For an isolated release check, run `npm run typecheck`, `npm test`, `npm run
build`, then `npm pack --dry-run`; the packed tarball contains both Host/client
entries, declarations, the Cordis patch, this README, license notices, and the
inlined client stylesheet.
