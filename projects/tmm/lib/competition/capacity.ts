export const MAX_COMPETITION_USERS = 2_000;
export const COMPETITION_SCORING_CONCURRENCY = 2;
export const COMPETITION_SCORING_QUEUE_CAPACITY = 4_096;
export const COMPETITION_TEAM_WRITE_QUEUE_CAPACITY = 2_048;

export interface CompetitionQueueSnapshot {
  readonly concurrency: number;
  readonly capacity: number;
  readonly active: number;
  readonly pending: number;
  readonly uniqueJobs: number;
  readonly accepted: number;
  readonly completed: number;
  readonly failed: number;
  readonly rejected: number;
}

export interface CompetitionQueueAdmission<Result> {
  readonly accepted: boolean;
  readonly deduplicated: boolean;
  readonly promise: Promise<Result> | null;
}

interface PendingWork<Result> {
  readonly key: string;
  readonly work: () => Promise<Result>;
  readonly resolve: (value: Result) => void;
  readonly reject: (reason: unknown) => void;
}

/**
 * Small in-isolate FIFO used to protect the single local D1 writer and the
 * CPU-heavy model evaluator. A key is executed at most once at a time, so
 * browser retries join the original work instead of duplicating it.
 */
export class CompetitionWorkQueue {
  readonly #concurrency: number;
  readonly #capacity: number;
  readonly #pending: PendingWork<unknown>[] = [];
  readonly #jobs = new Map<string, Promise<unknown>>();
  #active = 0;
  #accepted = 0;
  #completed = 0;
  #failed = 0;
  #rejected = 0;

  constructor(concurrency: number, capacity: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError("queue concurrency must be a positive integer");
    }
    if (!Number.isInteger(capacity) || capacity < concurrency) {
      throw new RangeError("queue capacity must be at least its concurrency");
    }
    this.#concurrency = concurrency;
    this.#capacity = capacity;
  }

  enqueue<Result>(key: string, work: () => Promise<Result>): CompetitionQueueAdmission<Result> {
    const existing = this.#jobs.get(key) as Promise<Result> | undefined;
    if (existing) return { accepted: true, deduplicated: true, promise: existing };
    if (this.#jobs.size >= this.#capacity) {
      this.#rejected += 1;
      return { accepted: false, deduplicated: false, promise: null };
    }

    let resolve!: (value: Result) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<Result>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.#jobs.set(key, promise);
    this.#pending.push({
      key,
      work,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    this.#accepted += 1;
    this.#drain();
    return { accepted: true, deduplicated: false, promise };
  }

  snapshot(): CompetitionQueueSnapshot {
    return Object.freeze({
      concurrency: this.#concurrency,
      capacity: this.#capacity,
      active: this.#active,
      pending: this.#pending.length,
      uniqueJobs: this.#jobs.size,
      accepted: this.#accepted,
      completed: this.#completed,
      failed: this.#failed,
      rejected: this.#rejected,
    });
  }

  #drain(): void {
    while (this.#active < this.#concurrency) {
      const task = this.#pending.shift();
      if (!task) return;
      this.#active += 1;
      void Promise.resolve()
        .then(task.work)
        .then((value) => {
          this.#completed += 1;
          task.resolve(value);
        }, (error: unknown) => {
          this.#failed += 1;
          task.reject(error);
        })
        .finally(() => {
          this.#active -= 1;
          this.#jobs.delete(task.key);
          this.#drain();
        });
    }
  }
}
