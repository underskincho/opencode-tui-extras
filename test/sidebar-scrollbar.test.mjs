import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  describeChain,
  diagnosticLogPath,
  findSidebarScrollBox,
  hideSidebarScrollbar,
  logDiagnostic,
  retryFindScrollBox,
} from "../dist/sidebar-scrollbar.js";
import { setupV2 } from "../dist/tui-v2.js";

function node(parent = null) {
  return { parent, isDestroyed: false };
}

function scrollBox(parent = null) {
  const box = node(parent);
  const wrapper = node(box);
  const viewport = node(wrapper);
  const content = node(viewport);
  let resets = 0;
  const verticalScrollBar = {
    ...node(box),
    orientation: "vertical",
    visible: true,
    resetVisibilityControl() {
      resets += 1;
      this.visible = true;
    },
    scrollBy(delta) {
      this.position = (this.position ?? 0) + delta;
    },
  };
  Object.assign(box, { content, verticalScrollBar });
  return { box, content, verticalScrollBar, resets: () => resets };
}

// A controllable scheduler: records scheduled callbacks, lets the test flush
// one "round" of them manually, and supports cancellation. Lets us drive the
// retry loop deterministically without real timers.
function fakeScheduler() {
  const pending = [];
  const schedule = (fn, ms) => {
    const handle = { fn, ms, cancelled: false };
    pending.push(handle);
    return handle;
  };
  const cancel = (handle) => {
    handle.cancelled = true;
  };
  const flush = () => {
    const toRun = pending.filter((h) => !h.cancelled);
    pending.length = 0;
    for (const h of toRun) h.fn();
  };
  const pendingCount = () => pending.length;
  return { schedule, cancel, flush, pendingCount };
}

test("finds only a scrollbox whose content contains the marker", () => {
  const outer = scrollBox();
  const inner = scrollBox(outer.content);
  const marker = node(inner.content);

  assert.equal(findSidebarScrollBox(marker), inner.box);

  const unrelated = scrollBox();
  const malformedMarker = node(unrelated.box);
  assert.equal(findSidebarScrollBox(malformedMarker), undefined);
});

test("hides the visual scrollbar without disabling scrolling and restores it", () => {
  const sidebar = scrollBox();
  const marker = node(sidebar.content);
  const restore = hideSidebarScrollbar(marker);

  assert.equal(sidebar.verticalScrollBar.visible, false);
  sidebar.verticalScrollBar.scrollBy(3);
  assert.equal(sidebar.verticalScrollBar.position, 3);

  restore();
  assert.equal(sidebar.resets(), 1);
  assert.equal(sidebar.verticalScrollBar.visible, true);
  restore();
  assert.equal(sidebar.resets(), 1);
});

test("keeps the scrollbar hidden until every marker is released", () => {
  const sidebar = scrollBox();
  const first = hideSidebarScrollbar(node(sidebar.content));
  const second = hideSidebarScrollbar(node(sidebar.content));

  first();
  assert.equal(sidebar.resets(), 0);
  assert.equal(sidebar.verticalScrollBar.visible, false);
  second();
  assert.equal(sidebar.resets(), 1);
});

test("leaves unrelated renderables unchanged", () => {
  const marker = node(node());
  const restore = hideSidebarScrollbar(marker);
  assert.doesNotThrow(restore);
});

test("writes a timestamped entry to the diagnostics file", () => {
  const file = path.join(os.tmpdir(), `tui-extras-diagnostic-${Date.now()}.log`);
  process.env.OPENCODE_TUI_EXTRAS_DIAGNOSTICS = file;
  try {
    assert.equal(diagnosticLogPath(), file);
    assert.equal(logDiagnostic("sidebarScrollbar: test"), true);
    const content = readFileSync(file, "utf8");
    assert.match(content, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] sidebarScrollbar: test\n?$/);
  } finally {
    delete process.env.OPENCODE_TUI_EXTRAS_DIAGNOSTICS;
    rmSync(file, { force: true });
  }
});

test("records a diagnostic when the marker is not inside a sidebar ScrollBox", () => {
  const file = path.join(os.tmpdir(), `tui-extras-diagnostic-${Date.now()}.log`);
  process.env.OPENCODE_TUI_EXTRAS_DIAGNOSTICS = file;
  try {
    const restore = hideSidebarScrollbar(node(node()));
    restore();
    const content = readFileSync(file, "utf8");
    assert.match(content, /no sidebar ScrollBox found; scrollbar stays visible/);
  } finally {
    delete process.env.OPENCODE_TUI_EXTRAS_DIAGNOSTICS;
    rmSync(file, { force: true });
  }
});

test("falls back to the console when the diagnostics file is unwritable", () => {
  const originalWarn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args.join(" "));
  try {
    // A directory cannot be appended to as a file, so the write fails.
    process.env.OPENCODE_TUI_EXTRAS_DIAGNOSTICS = os.tmpdir();
    assert.equal(logDiagnostic("sidebarScrollbar: fallback"), false);
    assert.deepEqual(warned, ["[opencode-tui-extras] sidebarScrollbar: fallback"]);
  } finally {
    delete process.env.OPENCODE_TUI_EXTRAS_DIAGNOSTICS;
    console.warn = originalWarn;
  }
});

function pluginContext(options) {
  const claims = [];
  let disposals = 0;
  return {
    context: {
      options,
      ui: {
        router: { current: () => ({ type: "home" }) },
        slot: (claim) => {
          claims.push(claim);
          return () => { disposals += 1; };
        },
      },
      data: {
        on: () => () => {},
        session: { get: () => undefined },
        location: {
          default: () => ({ directory: "/repo" }),
          skill: { invalidate: () => {}, sync: async () => {} },
        },
      },
      keymap: { layer: () => {} },
    },
    claims,
    disposals: () => disposals,
  };
}

test("registers Context and Sidebar scrollbar options independently", () => {
  const defaults = pluginContext({});
  const disposeDefaults = setupV2(defaults.context);
  assert.equal(defaults.claims.length, 1);
  assert.equal(defaults.claims[0].prepend, "sidebar.content");
  disposeDefaults();

  const independent = pluginContext({ context: false, sidebarScrollbar: false });
  const disposeIndependent = setupV2(independent.context);
  assert.equal(independent.claims.length, 1);
  assert.equal(independent.claims[0].append, "sidebar.content");
  disposeIndependent();
  assert.equal(independent.disposals(), 1);
});

test("describeChain reports ScrollBox flags along the parent chain", () => {
  const sidebar = scrollBox();
  const marker = node(sidebar.content);
  const chain = describeChain(marker);
  assert.match(chain, /isScrollBox=false/); // the marker itself is not a ScrollBox
  assert.match(chain, /isScrollBox=true/); // the sidebar ScrollBox is detected
});

test("describeChain is a single node when the marker has no parent", () => {
  const marker = node(null);
  const chain = describeChain(marker);
  assert.ok(!chain.includes(" -> "));
  assert.match(chain, /isScrollBox=false/);
});

test("retryFindScrollBox finds the ScrollBox on the first attempt", () => {
  const sidebar = scrollBox();
  const marker = node(sidebar.content);
  let foundAttempts = 0;
  const sched = fakeScheduler();
  const stop = retryFindScrollBox(
    () => marker,
    (_sb, attempts) => { foundAttempts = attempts; },
    () => {},
    sched.schedule,
    sched.cancel
  );
  stop();
  assert.equal(foundAttempts, 1);
  assert.equal(sched.pendingCount(), 0);
});

test("retryFindScrollBox keeps retrying until the marker is attached", () => {
  const sidebar = scrollBox();
  const marker = node(null);
  let foundAttempts = 0;
  let giveUpAttempts = 0;
  const sched = fakeScheduler();
  const stop = retryFindScrollBox(
    () => marker,
    (_sb, attempts) => { foundAttempts = attempts; },
    (attempts) => { giveUpAttempts = attempts; },
    sched.schedule,
    sched.cancel
  );
  assert.equal(foundAttempts, 0); // synchronous attempt 1: not attached yet
  assert.equal(giveUpAttempts, 0);
  sched.flush(); // attempt 2: still not attached
  assert.equal(foundAttempts, 0);
  marker.parent = sidebar.content; // now attached
  sched.flush(); // attempt 3: found
  assert.equal(foundAttempts, 3);
  assert.equal(giveUpAttempts, 0);
  assert.equal(sched.pendingCount(), 0);
  stop();
});

test("retryFindScrollBox gives up after maxAttempts and reports the chain", () => {
  const marker = node(null);
  let giveUpAttempts = 0;
  let chain = "";
  const sched = fakeScheduler();
  const stop = retryFindScrollBox(
    () => marker,
    () => {},
    (attempts, c) => { giveUpAttempts = attempts; chain = c; },
    sched.schedule,
    sched.cancel,
    { maxAttempts: 3 }
  );
  sched.flush(); // attempt 2
  sched.flush(); // attempt 3 -> give up
  assert.equal(giveUpAttempts, 3);
  assert.match(chain, /isScrollBox=false/);
  assert.equal(sched.pendingCount(), 0);
  stop();
});

test("retryFindScrollBox stops retrying once cancelled", () => {
  const marker = node(null);
  let foundAttempts = 0;
  const sched = fakeScheduler();
  const stop = retryFindScrollBox(
    () => marker,
    (_sb, attempts) => { foundAttempts = attempts; },
    () => {},
    sched.schedule,
    sched.cancel
  );
  stop(); // cancel the pending retry
  sched.flush(); // must not run
  assert.equal(foundAttempts, 0);
  assert.equal(sched.pendingCount(), 0);
});

test("retryFindScrollBox reports give-up when there is no marker", () => {
  let giveUpAttempts = -1;
  let chain = "unset";
  const sched = fakeScheduler();
  const stop = retryFindScrollBox(
    () => undefined,
    () => {},
    (attempts, c) => { giveUpAttempts = attempts; chain = c; },
    sched.schedule,
    sched.cancel
  );
  stop();
  assert.equal(giveUpAttempts, 0);
  assert.equal(chain, "");
});
