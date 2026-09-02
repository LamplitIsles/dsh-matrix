/** Browser-safe default copy shared by the locale registration and settings card. */
export type MatrixLocaleKey =
  | "title" | "description" | "homeserverUrl" | "homeserverHint" | "userId" | "userIdHint"
  | "roomId" | "roomIdHint" | "workspaceId" | "workspaceHint" | "workspaceMissing" | "accessToken"
  | "accessTokenHint" | "configured" | "notConfigured" | "respondToAll" | "respondToAllHint" | "runtime"
  | "restartHint" | "unbound" | "save" | "saving" | "discard" | "unsaved" | "readOnly" | "saveFailed"
  | "required" | "invalidUrl" | "missingSettings" | "missingCredential" | "connecting" | "bound" | "failed" | "disabled";

export const matrixLabels: Record<MatrixLocaleKey, string> = {
  title: "Matrix companion",
  description: "Connect one Matrix room to an existing Companion conversation.",
  homeserverUrl: "Homeserver URL",
  homeserverHint: "The Matrix homeserver base URL, for example https://matrix.example.",
  userId: "Matrix user ID",
  userIdHint: "The bot identity that already belongs to the room.",
  roomId: "Allowed room ID",
  roomIdHint: "Only this room can trigger the bridge or receive replies.",
  workspaceId: "Companion workspace",
  workspaceHint: "The workspace whose active conversation is locked at startup.",
  workspaceMissing: "The selected workspace is not available in this DSH deployment.",
  accessToken: "Element access token",
  accessTokenHint: "Write-only. Leave blank to keep the current token.",
  configured: "Configured",
  notConfigured: "Not configured",
  respondToAll: "Respond to all messages",
  respondToAllHint: "Off means the bot requires a mention or a reply to its message.",
  runtime: "Runtime readiness",
  restartHint: "Changes apply after restarting DSH; the bound conversation never switches live.",
  unbound: "Connected, but no eligible existing Companion conversation was found.",
  save: "Save",
  saving: "Saving…",
  discard: "Discard",
  unsaved: "Unsaved",
  readOnly: "This deployment is read-only.",
  saveFailed: "The deployment rejected these values; your draft was kept.",
  required: "Required",
  invalidUrl: "Enter a valid http(s) URL.",
  missingSettings: "Incomplete settings",
  missingCredential: "Access token is not configured.",
  connecting: "Connecting…",
  bound: "Bound to an existing conversation",
  failed: "Connection unavailable",
  disabled: "Stopped"
};

/** Keep a complete second locale entry for hosts that select Chinese. */
export const matrixLocale = { en: matrixLabels, zh: matrixLabels } as const;
