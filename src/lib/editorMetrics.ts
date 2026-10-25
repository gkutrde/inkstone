/**
 * Runtime probes for the typing-smoothness work.
 *
 * Enabled in development, and in a release build only when the bundle is
 * compiled with VITE_EDITOR_METRICS=1 (the release perf harness does that).
 * A normal production bundle compiles every helper below down to an early
 * return, so the editor pays nothing for it.
 *
 * No sample is ever written to disk or sent anywhere: the ring buffers live
 * only in memory and are read by scripts/perf via window.__inkMetrics.
 */

const ENABLED: boolean =
  import.meta.env.DEV || import.meta.env.VITE_EDITOR_METRICS === "1";

const MAX_SAMPLES = 200;
const MAX_LONG_TASKS = 60;
const MAX_COMMITS = 200;

export interface MetricSample {
  name: string;
  ms: number;
  at: number;
  meta?: Record<string, number | string | boolean | null>;
}

interface LongTaskSample {
  kind: "longtask" | "long-animation-frame";
  start: number;
  duration: number;
}

interface CommitSample {
  id: string;
  phase: string;
  actualDuration: number;
  baseDuration: number;
  commitTime: number;
}

const samples: MetricSample[] = [];
const longTasks: LongTaskSample[] = [];
const commits: CommitSample[] = [];

let inputStartedAt = 0;
let lastInputMarkAt = 0;
let commitStartedAt = 0;
let modeSwitchStartedAt = 0;
let lastTransactionAt = 0;
let observersAttached = false;
let serializeProbe: (() => void) | null = null;

export const metricsEnabled: boolean = ENABLED;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function push(entry: MetricSample): void {
  if (samples.length >= MAX_SAMPLES) samples.shift();
  samples.push(entry);
}

export function now(): number {
  return ENABLED ? performance.now() : 0;
}

export function record(
  name: string,
  ms: number,
  meta?: MetricSample["meta"]
): void {
  if (!ENABLED) return;
  push({ name, ms: round(ms), at: round(performance.now()), meta });
}

/** Time a synchronous unit of work (metadata, drafts, serialization probe). */
export function timeSync<T>(name: string, fn: () => T, meta?: MetricSample["meta"]): T {
  if (!ENABLED) return fn();
  const started = performance.now();
  const result = fn();
  record(name, performance.now() - started, meta);
  return result;
}

/** Called on the first input of a burst; every pipeline timestamp hangs off it. */
export function markInputStart(): void {
  if (!ENABLED) return;
  const stamp = performance.now();
  // keydown and beforeinput both fire for one physical key: keep one frame probe.
  if (stamp - lastInputMarkAt < 5) return;
  lastInputMarkAt = stamp;
  inputStartedAt = stamp;
  window.requestAnimationFrame(() => {
    record("input_to_frame", performance.now() - stamp);
  });
}

/** Marks the moment a content update is handed to React. */
export function beginCommit(): void {
  if (!ENABLED) return;
  commitStartedAt = performance.now();
}

/** Records setState -> DOM mutation time for a content update. */
export function endCommit(name = "react_commit_span"): void {
  if (!ENABLED || !commitStartedAt) return;
  const elapsed = performance.now() - commitStartedAt;
  commitStartedAt = 0;
  if (elapsed < 2000) record(name, elapsed);
}

/** Called from the ProseMirror transaction boundary. */
export function markTransaction(): void {
  if (!ENABLED) return;
  lastTransactionAt = performance.now();
}

export function sinceInput(name: string, maxAgeMs = 2000): void {
  if (!ENABLED || !inputStartedAt) return;
  const elapsed = performance.now() - inputStartedAt;
  if (elapsed > maxAgeMs) return;
  record(name, elapsed);
}

export function sinceTransaction(name: string): void {
  if (!ENABLED || !lastTransactionAt) return;
  const elapsed = performance.now() - lastTransactionAt;
  if (elapsed > 2000) return;
  record(name, elapsed);
}

export function markModeSwitch(): void {
  if (!ENABLED) return;
  modeSwitchStartedAt = performance.now();
}

export function sinceModeSwitch(name: string): void {
  if (!ENABLED || !modeSwitchStartedAt) return;
  const elapsed = performance.now() - modeSwitchStartedAt;
  if (elapsed > 5000) return;
  record(name, elapsed);
}

export function recordCommit(
  id: string,
  phase: string,
  actualDuration: number,
  baseDuration: number,
  commitTime: number
): void {
  if (!ENABLED) return;
  if (commits.length >= MAX_COMMITS) commits.shift();
  commits.push({
    id,
    phase,
    actualDuration: round(actualDuration),
    baseDuration: round(baseDuration),
    commitTime: round(commitTime)
  });
}

export function registerSerializeProbe(fn: (() => void) | null): void {
  if (!ENABLED) return;
  serializeProbe = fn;
}

/**
 * One-off full-document serialization measurement, invoked by the benchmark
 * driver after a typing burst. Kept off the hot path on purpose.
 */
export function runSerializeProbe(): boolean {
  if (!ENABLED || !serializeProbe) return false;
  serializeProbe();
  return true;
}

export function observeLongTasks(): void {
  if (!ENABLED || observersAttached) return;
  observersAttached = true;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === "longtask") {
          if (longTasks.length >= MAX_LONG_TASKS) longTasks.shift();
          longTasks.push({
            kind: "longtask",
            start: round(entry.startTime),
            duration: round(entry.duration)
          });
        }
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    /* longtask unsupported */
  }
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const frame = entry as PerformanceEntry & {
          styleAndLayoutStart?: number;
          blockingDuration?: number;
          renderStart?: number;
        };
        if (longTasks.length >= MAX_LONG_TASKS) longTasks.shift();
        longTasks.push({
          kind: "long-animation-frame",
          start: round(entry.startTime),
          duration: round(frame.blockingDuration ?? entry.duration)
        });
      }
    });
    observer.observe({ type: "long-animation-frame", buffered: false } as PerformanceObserverInit);
  } catch {
    /* long-animation-frame unsupported */
  }
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const timing = entry as PerformanceEntry & { processingStart?: number };
        if (entry.entryType !== "event" || entry.name !== "input") continue;
        record("event_input", entry.duration, {
          processingStart: round(timing.processingStart ?? 0)
        });
      }
    });
    observer.observe({
      type: "event",
      durationThreshold: 16,
      buffered: false
    } as PerformanceObserverInit);
  } catch {
    /* event timing unsupported */
  }
}

interface MetricsSnapshot {
  enabled: boolean;
  samples: MetricSample[];
  longTasks: LongTaskSample[];
  commits: CommitSample[];
  memory: { usedJSHeapSize: number; totalJSHeapSize: number } | null;
  env: { ua: string; devicePixelRatio: number; viewport: string };
  counts: { samples: number; longTasks: number; commits: number };
}

export function snapshot(): MetricsSnapshot {
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
  }).memory;
  return {
    enabled: ENABLED,
    samples: samples.slice(),
    longTasks: longTasks.slice(),
    commits: commits.slice(),
    memory: memory
      ? {
          usedJSHeapSize: memory.usedJSHeapSize,
          totalJSHeapSize: memory.totalJSHeapSize
        }
      : null,
    env: {
      ua: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
      viewport: window.innerWidth + "x" + window.innerHeight
    },
    counts: {
      samples: samples.length,
      longTasks: longTasks.length,
      commits: commits.length
    }
  };
}

export function clear(): void {
  samples.length = 0;
  longTasks.length = 0;
  commits.length = 0;
  inputStartedAt = 0;
  lastInputMarkAt = 0;
  commitStartedAt = 0;
  modeSwitchStartedAt = 0;
  lastTransactionAt = 0;
}

export function installWindowProbe(): void {
  if (!ENABLED) return;
  (window as Window & { __inkMetrics?: unknown }).__inkMetrics = {
    enabled: true,
    snapshot,
    clear,
    probeSerialize: () => runSerializeProbe()
  };
}
