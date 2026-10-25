/**
 * Keyed scheduling for non-urgent editor work.
 *
 * The editor's own transactions and input rules stay synchronous; only the
 * expensive derived work (full-document Markdown serialization, metadata)
 * goes through this module. Every key holds at most one pending task, so a
 * burst of keystrokes collapses into one deferred run, and any action that
 * needs a fresh snapshot can cancel or flush the pending work first.
 */

interface PendingTask {
  timer: number;
  run: () => void;
}

const pending = new Map<string, PendingTask>();

/**
 * How long a document of this size may wait before its Markdown snapshot is
 * refreshed automatically. Small documents are cheap enough to keep almost
 * live; big ones only refresh when the writer pauses, or on an explicit flush.
 */
export function delayForDocSize(bytes: number): number {
  if (bytes <= 64_000) return 0;
  if (bytes <= 256_000) return 350;
  return 1500;
}

export function scheduleTask(key: string, delayMs: number, run: () => void): void {
  cancelTask(key);
  const timer = window.setTimeout(() => {
    pending.delete(key);
    run();
  }, delayMs);
  pending.set(key, { timer, run });
}

export function cancelTask(key: string): boolean {
  const task = pending.get(key);
  if (!task) return false;
  window.clearTimeout(task.timer);
  pending.delete(key);
  return true;
}

export function hasPendingTask(key: string): boolean {
  return pending.has(key);
}

export function pendingTaskCount(): number {
  return pending.size;
}

export function cancelAllTasks(): void {
  pending.forEach((task) => window.clearTimeout(task.timer));
  pending.clear();
}
