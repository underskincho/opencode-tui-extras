/** @jsxImportSource @opentui/solid */
import type { Context } from "@opencode/plugin/tui/plugin";
import { createMemo, For, onCleanup, Show } from "solid-js";

type McpServer = NonNullable<ReturnType<Context["data"]["location"]["mcp"]["server"]["list"]>>[number];
type McpStatus = McpServer["status"]["status"];
type Location = ReturnType<Context["data"]["location"]["default"]>;

export function mcpStatusLabel(status: McpStatus): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "pending":
      return "Connecting";
    case "failed":
      return "Error";
    case "needs_auth":
      return "Sign in";
    default:
      return "Disabled";
  }
}

export function mcpStatusColor(context: Context, status: McpStatus, label = false) {
  if (status === "connected") return context.theme.text.feedback.success.base;
  if (status === "failed") return context.theme.text.feedback.error.base;
  if (status === "needs_auth" && !label) return context.theme.text.feedback.warning.base;
  return context.theme.text.muted;
}

/** A row click flips the server's disabled state: a disabled server is connected,
 * any other status (connected, pending, failed, needs_auth) is disconnected.
 * Sign-in for needs_auth servers stays in the native manager (/mcps). */
export function mcpToggleAction(status: McpStatus): "connect" | "disconnect" {
  return status === "disabled" ? "connect" : "disconnect";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sameLocation(left: Location | undefined, right: Location) {
  if (!left) return true;
  return left.directory === right.directory && left.workspaceID === right.workspaceID;
}

export function McpSidebar(props: { context: Context; sessionID: string }) {
  const [view, updateView] = props.context.storage.store("mcp-sidebar", { initial: { open: true } });
  const session = createMemo(() => props.context.data.session.get(props.sessionID));
  const location = () => session()?.location ?? props.context.location ?? props.context.data.location.default();
  const list = createMemo(() => props.context.data.location.mcp.server.list(location()) ?? []);
  const connected = createMemo(() => list().filter((server) => server.status.status === "connected").length);
  const errors = createMemo(
    () => list().filter((server) => server.status.status === "failed" || server.status.status === "needs_auth").length,
  );
  const toggleServer = (server: McpServer) => {
    const target = mcpToggleAction(server.status.status);
    const ref = { directory: location().directory };
    const call =
      target === "connect"
        ? () => props.context.client.mcp.connect({ server: server.name, location: ref })
        : () => props.context.client.mcp.disconnect({ server: server.name, location: ref });
    void call().catch((error) => {
      props.context.ui.toast.show({
        title: target === "connect" ? `Could not connect ${server.name}` : `Could not disconnect ${server.name}`,
        message: errorMessage(error),
        variant: "error",
      });
    });
  };

  const stop = props.context.data.on("mcp.status.changed", (event) => {
    if (!sameLocation(event.location, location())) return;
    const current = location();
    props.context.data.location.mcp.server.invalidate(current);
    void props.context.data.location.mcp.server.sync(current);
  });
  onCleanup(stop);

  return (
    <Show when={list().length > 0}>
      <box>
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => {
            if (list().length <= 2) return;
            void updateView((draft) => {
              draft.open = !draft.open;
            }).catch((error) => console.error("Failed to persist MCP sidebar state", error));
          }}
        >
          <Show when={list().length > 2}>
            <text fg={props.context.theme.text.base}>{view.open ? "▼" : "▶"}</text>
          </Show>
          <text fg={props.context.theme.text.base}>
            <b>MCP</b>
            <Show when={!view.open}>
              <span style={{ fg: props.context.theme.text.muted }}>{` (${connected()} active${errors() ? `, ${errors()} error${errors() > 1 ? "s" : ""}` : ""})`}</span>
            </Show>
          </text>
        </box>
        <Show when={list().length <= 2 || view.open}>
          <For each={list()}>
            {(server) => (
              <box flexDirection="row" gap={1} minWidth={0} onMouseUp={() => toggleServer(server)}>
                <text flexShrink={0} fg={mcpStatusColor(props.context, server.status.status)}>•</text>
                <text fg={props.context.theme.text.base} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
                  <b>{server.name}</b>
                </text>
                <text fg={mcpStatusColor(props.context, server.status.status, true)} wrapMode="none" flexShrink={0}>
                  {mcpStatusLabel(server.status.status)}
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  );
}
