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
