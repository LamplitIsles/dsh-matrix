import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { MatrixSettingsCard } from "../src/client/settings-card.js";

function scopeFixture(status: "loading" | "ready" = "ready") {
  let snapshot: any = {
    status,
    mode: "host",
    writable: true,
    value: { homeserverUrl: "https://matrix.example", userId: "@bot:example", roomId: "!room:example", workspaceId: "w1", respondToAll: false },
    base: {}, user: {}, revision: 1
  };
  const listeners = new Set<() => void>();
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    set: async (field: string, value: unknown) => { snapshot = { ...snapshot, value: { ...snapshot.value, [field]: value } }; for (const listener of listeners) listener(); },
    unset: async () => undefined
  };
  return { scope, publish(next: any) { snapshot = next; for (const listener of listeners) listener(); } };
}

function props(fixture: ReturnType<typeof scopeFixture>) {
  return {
    scope: fixture.scope as never,
    api: {
      credentials: {
        describe: async () => ({ ok: true, value: { DSH_MATRIX_ACCESS_TOKEN: { configured: true, writable: true } } }),
        set: async () => ({ ok: true })
      }
    },
    readiness: { get: async () => ({ ok: true, value: { state: "bound", workspaceId: "w1", sessionId: "s1" } }) },
    useWorkspaces: (selector: (state: { items: readonly { id: string; title: string }[] }) => unknown) => selector({ items: [{ id: "w1", title: "Main" }, { id: "w2", title: "Other" }] })
  } as any;
}

function field(renderer: ReactTestRenderer, name: string) {
  return renderer.root.findByProps({ "data-settings-field": name });
}

describe("MatrixSettingsCard", () => {
  it("hides an unavailable namespace and renders workspace/credential/readiness state when ready", async () => {
    const unavailable = scopeFixture("loading");
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<MatrixSettingsCard {...props(unavailable)} />); });
    expect(renderer.toJSON()).toBeNull();

    const ready = scopeFixture();
    await act(async () => { renderer = create(<MatrixSettingsCard {...props(ready)} />); });
    expect(field(renderer, "workspaceId").props.value).toBe("w1");
    expect(field(renderer, "accessToken").props.type).toBe("password");
    expect(renderer.root.findByProps({ "data-readiness": "bound" })).toBeTruthy();
  });

  it("keeps a dirty draft across an external refresh and supports discard/save", async () => {
    const fixture = scopeFixture();
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<MatrixSettingsCard {...props(fixture)} />); });
    await act(async () => { field(renderer, "roomId").props.onChange({ target: { value: "!draft:example" } }); });
    fixture.publish({ ...fixture.scope.getSnapshot(), value: { ...fixture.scope.getSnapshot().value, roomId: "!external:example" } });
    expect(field(renderer, "roomId").props.value).toBe("!draft:example");
    const discard = renderer.root.findByProps({ children: "Discard" });
    await act(async () => { discard.props.onClick(); });
    expect(field(renderer, "roomId").props.value).toBe("!external:example");

    await act(async () => { field(renderer, "respondToAll").props.onChange({ target: { checked: true } }); });
    const save = renderer.root.findByProps({ children: "Save" });
    await act(async () => { save.props.onClick(); });
    expect(fixture.scope.getSnapshot().value.respondToAll).toBe(true);
  });
});
