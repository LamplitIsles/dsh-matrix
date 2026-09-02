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

Admitted prompts are serialized because they share one locked Agent. Matrix
room, sender, and event identity remain bounded plugin provenance on the DSH
message; event fields are data, not instructions. The bridge waits for the
exact Matrix-initiated turn and sends only its final non-empty assistant text as
one ordinary `m.text` message. Tool output, intermediate assistant messages,
and activity initiated by Web or CLI are not relayed.

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
transactional outbox, or exactly-once delivery guarantees.

## Operator verification

1. Install the package and restart DSH.
2. Select a workspace that already has a normal human prompt, enter the room
   and account values, write the Element token, and save.
3. Restart DSH again and confirm the card reports **bound** (or the expected
   bounded missing/unbound state).
4. In the allowed room, send a mention or reply and confirm exactly one final
   text answer. Send a notice, an edit, a thread event, and a message in another
   room; confirm none produces a reply.
5. Toggle **Respond to all**, save, restart, and verify an ordinary text message
   triggers. Stop/reload DSH and confirm the Matrix client stops before a new
   instance starts.

For an isolated release check, run `npm run typecheck`, `npm test`, `npm run
build`, then `npm pack --dry-run`; the packed tarball contains both Host/client
entries, declarations, the Cordis patch, this README, license notices, and the
inlined client stylesheet.
