import test from "node:test";
import assert from "node:assert/strict";
import { mcpStatusLabel } from "../dist/tui.js";
import { mcpStatusColor, mcpToggleAction } from "../dist/mcp-sidebar.js";
import { readFile } from "node:fs/promises";

test("uses clear MCP status labels", () => {
  assert.equal(mcpStatusLabel("connected"), "Connected");
  assert.equal(mcpStatusLabel("pending"), "Connecting");
  assert.equal(mcpStatusLabel("failed"), "Error");
  assert.equal(mcpStatusLabel("needs_auth"), "Sign in");
  assert.equal(mcpStatusLabel("disabled"), "Disabled");
});

test("mcpToggleAction: disabled connects, everything else disconnects", () => {
  assert.equal(mcpToggleAction("disabled"), "connect");
  assert.equal(mcpToggleAction("connected"), "disconnect");
  assert.equal(mcpToggleAction("pending"), "disconnect");
  assert.equal(mcpToggleAction("failed"), "disconnect");
  assert.equal(mcpToggleAction("needs_auth"), "disconnect");
});

test("only changes the Connected label color and preserves other status colors", () => {
  const muted = {};
  const success = {};
  const error = {};
  const warning = {};
  const context = {
    theme: {
      text: {
        muted,
        feedback: { success: { base: success }, error: { base: error }, warning: { base: warning } },
      },
    },
  };

  assert.equal(mcpStatusColor(context, "connected", true), success);
  assert.equal(mcpStatusColor(context, "connected"), success);
  assert.equal(mcpStatusColor(context, "failed", true), error);
  for (const status of ["pending", "disabled", "needs_auth"]) {
    assert.equal(mcpStatusColor(context, status, true), muted);
  }
  assert.equal(mcpStatusColor(context, "needs_auth"), warning);
});

test("row clicks toggle directly via the built-in mcp endpoints and refresh on status changes", async () => {
  const source = await readFile(new URL("../src/mcp-sidebar.tsx", import.meta.url), "utf8");

  assert.match(source, /client\.mcp\.connect\(\{ server: server\.name, location: ref \}\)/);
  assert.match(source, /client\.mcp\.disconnect\(\{ server: server\.name, location: ref \}\)/);
  assert.match(source, /variant: "error"/);
  assert.match(source, /data\.on\("mcp\.status\.changed"/);
  assert.match(source, /sameLocation\(event\.location, location\(\)\)/);
  assert.match(source, /mcp\.server\.invalidate\(current\)/);
  assert.match(source, /mcp\.server\.sync\(current\)/);
  assert.match(source, /onCleanup\(stop\)/);
  assert.match(source, /onMouseUp=\{\(\) => toggleServer\(server\)\}/);
  assert.doesNotMatch(source, /keymap\.dispatch\("mcp\.list"/);
  assert.doesNotMatch(source, /mcpSelectionCommands/);
  assert.doesNotMatch(source, /openDialog/);
});
