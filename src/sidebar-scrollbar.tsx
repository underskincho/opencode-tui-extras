/** @jsxImportSource @opentui/solid */
import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BoxRenderable, Renderable } from "@opentui/core";
import type { Context } from "@opencode/plugin/tui/plugin";
import { onCleanup, onMount } from "solid-js";

type VerticalScrollBar = Renderable & {
  orientation: "vertical";
  resetVisibilityControl: () => void;
};

type ScrollBox = Renderable & {
  content: Renderable;
  verticalScrollBar: VerticalScrollBar;
};

const hiddenBars = new WeakMap<VerticalScrollBar, number>();

export function diagnosticLogPath(): string {
  return (
    process.env.OPENCODE_TUI_EXTRAS_DIAGNOSTICS ??
    path.join(os.homedir(), ".config", "opencode", "tui-extras-diagnostics.log")
  );
}

/**
 * Records a best-effort diagnostic entry. In a full-screen TUI the process
 * stderr is not visible, so failures are surfaced through a log file the
 * user can open; console.warn is kept as a fallback for headless runs.
 */
export function logDiagnostic(message: string): boolean {
  const entry = `[${new Date().toISOString()}] ${message}\n`;
  try {
    appendFileSync(diagnosticLogPath(), entry);
    return true;
  } catch {
    console.warn("[opencode-tui-extras]", message);
    return false;
  }
}

function isVerticalScrollBar(value: unknown): value is VerticalScrollBar {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<VerticalScrollBar>;
  return candidate.orientation === "vertical" &&
    typeof candidate.resetVisibilityControl === "function";
}

function isScrollBox(value: Renderable): value is ScrollBox {
  return "content" in value &&
    "verticalScrollBar" in value &&
    (value as Partial<ScrollBox>).content !== undefined &&
    isVerticalScrollBar((value as Partial<ScrollBox>).verticalScrollBar);
}

export function findSidebarScrollBox(marker: Renderable): ScrollBox | undefined {
  // Return the innermost scrollbox that contains the marker: the first
  // scrollbox encountered while walking up from the marker. The marker is
  // appended to the sidebar.content slot, which OpenTUI attaches as a direct
  // child of the sidebar ScrollBox (not inside its `content` sub-node), so
  // containment must be judged by the ancestor chain, not by `content`.
  let current = marker.parent;
  while (current) {
    if (isScrollBox(current)) return current;
    current = current.parent;
  }
  return undefined;
}

/**
 * A human-readable description of a single renderable, including whether it
 * looks like a ScrollBox. Used to diagnose why findSidebarScrollBox fails.
 */
export function describeNode(node: Renderable): string {
  const n = node as unknown as { id?: unknown; content?: unknown; verticalScrollBar?: unknown };
  const id = typeof n.id === "string" && n.id ? n.id : "(no-id)";
  const hasContent = n.content !== undefined && n.content !== null;
  const vbar = n.verticalScrollBar;
  const hasVbar = vbar !== undefined && vbar !== null;
  const orient = hasVbar ? String((vbar as { orientation?: unknown }).orientation ?? "n/a") : "-";
  const rvc = hasVbar ? typeof (vbar as { resetVisibilityControl?: unknown }).resetVisibilityControl === "function" : false;
  return `${id} content=${hasContent} vbar=${hasVbar} orient=${orient} rvc=${rvc} isScrollBox=${isScrollBox(node)}`;
}

/**
 * A human-readable description of the full parent chain from the marker up to
 * the root. Used to diagnose where the marker actually lives in the tree.
 */
export function describeChain(marker: Renderable): string {
  const parts: string[] = [describeNode(marker)];
  let current: Renderable | null = marker.parent;
  while (current) {
    parts.push(describeNode(current));
    current = current.parent;
  }
  return parts.join(" -> ");
}

export interface RetryOptions {
  delayMs?: number;
  maxAttempts?: number;
}

type ScheduleHandle = unknown;

/**
 * Repeatedly searches for the sidebar ScrollBox that contains the marker,
 * retrying until it is found or the attempt budget is exhausted. Slot content
 * can be attached to the renderable tree after the marker's onMount fires, so
 * a single immediate search can miss it; retrying covers that window. The
 * scheduler/cancel functions are injected so the behavior is unit-testable
 * without real timers.
 */
export function retryFindScrollBox(
  getMarker: () => Renderable | undefined,
  onFound: (scrollBox: ScrollBox, attempts: number) => void,
  onGiveUp: (attempts: number, chain: string) => void,
  schedule: (fn: () => void, ms: number) => ScheduleHandle,
  cancel: (handle: ScheduleHandle) => void,
  options?: RetryOptions
): () => void {
  const delayMs = options?.delayMs ?? 250;
  const maxAttempts = options?.maxAttempts ?? 8;
  let attempts = 0;
  let handle: ScheduleHandle | undefined;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    const marker = getMarker();
    if (marker) {
      const scrollBox = findSidebarScrollBox(marker);
      if (scrollBox) {
        stopped = true;
        onFound(scrollBox, attempts + 1);
        return;
      }
    }
    // The marker ref can be assigned after onMount fires (the slot content is
    // attached to the tree by the reconciler), so a missing marker is a "not
    // yet found" state, not a failure: keep retrying until the budget is
    // exhausted.
    attempts += 1;
    if (attempts >= maxAttempts) {
      stopped = true;
      onGiveUp(attempts, marker ? describeChain(marker) : "");
      return;
    }
    handle = schedule(tick, delayMs);
  };

  tick();

  return () => {
    stopped = true;
    if (handle !== undefined) cancel(handle);
  };
}

export function hideSidebarScrollbar(marker: Renderable) {
  const scrollBox = findSidebarScrollBox(marker);
  if (!scrollBox) {
    // The marker is not inside a sidebar ScrollBox, so there is nothing to
    // hide. Surface this in the diagnostics file (stderr is not visible in a
    // full-screen TUI) so a no-op is debuggable.
    logDiagnostic("sidebarScrollbar: no sidebar ScrollBox found; scrollbar stays visible");
    return () => {};
  }

  const bar = scrollBox.verticalScrollBar;
  const count = hiddenBars.get(bar) ?? 0;
  hiddenBars.set(bar, count + 1);
  if (count === 0) bar.visible = false;

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const remaining = (hiddenBars.get(bar) ?? 1) - 1;
    if (remaining > 0) {
      hiddenBars.set(bar, remaining);
      return;
    }
    hiddenBars.delete(bar);
    if (!bar.isDestroyed) bar.resetVisibilityControl();
  };
}

function SidebarScrollbarMarker() {
  let marker: BoxRenderable | undefined;
  let restore: (() => void) | undefined;
  let stopRetry: (() => void) | undefined;

  onMount(() => {
    logDiagnostic(
      `sidebarScrollbar: mounted; marker=${marker ? String((marker as { id?: unknown }).id ?? "(no-id)") : "(none)"}`
    );
    // Start retrying even if the ref is not assigned yet: the slot content is
    // attached by the reconciler and the ref can land after onMount.
    stopRetry = retryFindScrollBox(
      () => marker,
      (_scrollBox, attempts) => {
        const m = marker;
        if (!m) return;
        restore = hideSidebarScrollbar(m);
        logDiagnostic(`sidebarScrollbar: found ScrollBox on attempt ${attempts}; hiding bar`);
      },
      (attempts, chain) => {
        logDiagnostic(`sidebarScrollbar: gave up after ${attempts} attempts; chain: ${chain}`);
      },
      (fn, ms) => setTimeout(fn, ms),
      (handle) => clearTimeout(handle as NodeJS.Timeout),
    );
  });

  onCleanup(() => {
    if (stopRetry) stopRetry();
    if (restore) restore();
  });

  return <box ref={marker} position="absolute" width={0} height={0} />;
}

export function installSidebarScrollbar(context: Context) {
  return context.ui.slot({
    append: "sidebar.content",
    render: () => <SidebarScrollbarMarker />,
  });
}
