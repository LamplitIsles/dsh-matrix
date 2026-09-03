# Explicit Matrix message delivery

Matrix delivery is performed only by `matrix_send_message`; completing a Companion turn never automatically relays its final Assistant text. The Agent explicitly chooses whether to send and may reply to any event Matrix verifies in the configured room's server history, without gaining another-room event addressing.

The stable policy that explains these boundaries is an active-Companion-scoped system-prompt section. Per-turn room records and the triggering event remain untrusted dynamic data rather than repeated instructions.
