# Explicit Matrix message delivery

Matrix delivery is performed only by `matrix_send_message`; completing a Companion turn never automatically relays its final Assistant text. A Matrix-triggered turn supplies its context event IDs as eligible optional reply anchors, so the Agent explicitly chooses whether to send, and which supplied event to reply to, without gaining arbitrary Matrix-event addressing. Events arriving after that context was injected remain for a later turn and are not eligible anchors for the current one.

The stable policy that explains these boundaries is an active-Companion-scoped system-prompt section. Per-turn room records, the triggering event, and current reply-anchor choices remain untrusted dynamic data rather than repeated instructions.
