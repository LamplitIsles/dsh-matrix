import { createElement } from "react";
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type { SettingsScope } from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@deepseek-ai/dsh-api-workspace-controller/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings-plugins/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import { CREDENTIAL_REF, RPC_CHANNEL, RPC_ENDPOINT, SETTINGS_NAMESPACE, type MatrixSettings } from "./constants.js";
import { decodeSettings } from "./settings-client.js";
import { MatrixSettingsCard, type CredentialApi, type ReadinessApi } from "./client/settings-card.js";

export const inject = ["connection", "locale", "remote", "settingsScope", "slots"] as const;

export type MatrixLocaleKey =
  | "title" | "description" | "homeserverUrl" | "homeserverHint" | "userId" | "userIdHint"
  | "roomId" | "roomIdHint" | "workspaceId" | "workspaceHint" | "workspaceMissing" | "accessToken"
  | "accessTokenHint" | "configured" | "notConfigured" | "respondToAll" | "respondToAllHint" | "runtime"
  | "restartHint" | "unbound" | "save" | "saving" | "discard" | "unsaved" | "readOnly" | "saveFailed"
  | "required" | "invalidUrl" | "missingSettings" | "missingCredential" | "connecting" | "bound" | "failed" | "disabled";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "dsh-matrix": MatrixLocaleKey;
  }
}

const en: Record<MatrixLocaleKey, string> = {
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

// Keep a complete second locale entry so a deployment with a Chinese locale
// never falls back to an empty namespace. Operators can still override copy via
// the host locale layer.
const zh: Record<MatrixLocaleKey, string> = { ...en };

function createReadinessApi(connection: Pick<ConnectionHandle, "rpc">): ReadinessApi {
  return {
    async get(signal?: AbortSignal): Promise<unknown> {
      return connection.rpc.call(RPC_CHANNEL, RPC_ENDPOINT, {}, signal);
    }
  };
}

export function apply(ctx: ClientContext): void {
  const clientRoot = ctx as ClientContext & {
    locale: { register: (namespace: string, dictionaries: { en: Record<string, string>; zh: Record<string, string> }) => unknown };
    slots: {
      inject: (name: string, factory: () => unknown) => unknown;
      register: (options: unknown, component: unknown) => unknown;
    };
  };
  ctx.effect(() => clientRoot.locale.register(SETTINGS_NAMESPACE, { en, zh }), "dsh-matrix: dictionaries");

  const scope = ctx.settingsScope.bind<Partial<MatrixSettings>>({
    namespace: SETTINGS_NAMESPACE,
    decode: decodeSettings
  }) as SettingsScope<Partial<MatrixSettings>>;
  const clientContext = ctx as ClientContext & {
    connection: ConnectionHandle;
    remote: { credentials: CredentialApi["credentials"] };
  };
  const connection = clientContext.connection;
  const api: CredentialApi = { credentials: clientContext.remote.credentials };
  const readiness = createReadinessApi(connection);

  clientRoot.slots.inject("settings.plugin.item", () => clientRoot.slots.register(
    {
      name: "settings.plugin.item",
      key: SETTINGS_NAMESPACE,
      priority: 0,
      inject: () => ({}),
      locale: SETTINGS_NAMESPACE
    } as never,
    ((props: Record<string, unknown>) => createElement(MatrixSettingsCard, {
      ...props,
      scope,
      api,
      readiness
    } as never)) as never
  ));
}

export { MatrixSettingsCard, decodeSettings, describeCredential, saveCredential } from "./client/settings-card.js";
export type { ClientSettingsScope, CredentialApi, CredentialStatus, MatrixSettingsCardProps, ReadinessApi, WorkspaceChoice } from "./client/settings-card.js";
export { CREDENTIAL_REF, RPC_CHANNEL, RPC_ENDPOINT, SETTINGS_NAMESPACE } from "./constants.js";
export default { inject, apply };
