/** A cache whose completed bytes count against a shared retention budget. */
export interface RetainedBytes {
  /** Last-use tick of the least recently used entry this cache can release. */
  oldest(): number | undefined;
  /** Release that entry; the cache returns its bytes through `add`. */
  releaseOldest(): void;
}

/** Bytes one realm retains across all of its read caches. */
const MAX_BYTES = 64 * 1024 * 1024;
/** An entry not used for this long is idle and released by `step`. */
const IDLE_MS = 60_000;
/** `step` releases at most one idle entry per this interval. */
const STEP_MS = 1_000;

/**
 * One byte budget for the read caches of a realm. Crossing the budget releases
 * least recently used entries across every member until a margin below the
 * budget is free, so a cache held at its limit does not release on every
 * admission. Entries left unused go one at a time as time advances.
 */
export class RetentionBudget {
  private readonly members = new Set<RetainedBytes>();
  private bytes = 0;
  private peak = 0;
  private releases = 0;
  private clock = 0;
  private readonly low: number;
  /** The clock reached at past steps, oldest first; spans one idle interval. */
  private readonly marks: { readonly tick: number; readonly at: number }[] = [];
  private stepped = Number.NEGATIVE_INFINITY;

  constructor(
    readonly maxBytes = MAX_BYTES,
    private readonly idleMs = IDLE_MS,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new RangeError('retention budget must be a non-negative safe integer');
    this.low = maxBytes - Math.floor(maxBytes / 16);
  }

  join(member: RetainedBytes): void {
    this.members.add(member);
  }

  /** Stop releasing from `member`; it has already returned its bytes. */
  leave(member: RetainedBytes): void {
    this.members.delete(member);
  }

  tick(): number {
    return ++this.clock;
  }

  /** Account retained bytes; released bytes are negative. */
  add(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes > this.peak) this.peak = this.bytes;
  }

  /** Whether `bytes` more fit without releasing. */
  fits(bytes: number): boolean {
    return this.bytes + bytes <= this.maxBytes;
  }

  /**
   * Release down to the margin when `incoming` more bytes cross the budget,
   * never entries used at or after `keep`.
   */
  settle(keep = Number.POSITIVE_INFINITY, incoming = 0): void {
    if (this.bytes + incoming <= this.maxBytes) return;
    while (this.bytes + incoming > this.low) if (!this.releaseBefore(keep)) return;
  }

  /** Release every releasable entry of every member. */
  trim(): void {
    while (this.releaseBefore(Number.POSITIVE_INFINITY));
  }

  /**
   * Advance idle time to `now` from a frame. Releases at most one entry that
   * has not been used for the idle interval.
   */
  step(now: number): void {
    if (now - this.stepped < STEP_MS) return;
    this.stepped = now;
    const marks = this.marks;
    if (marks.at(-1)?.tick !== this.clock) marks.push({ tick: this.clock, at: now });
    const idleSince = now - this.idleMs;
    for (let next = marks[1]; next !== undefined && next.at <= idleSince; next = marks[1])
      marks.shift();
    const idle = marks[0];
    // Every entry used at or before `idle.tick` was last used by `idle.at`.
    if (idle !== undefined && idle.at <= idleSince) this.releaseBefore(idle.tick + 1);
  }

  snapshot(): { readonly bytes: number; readonly peak: number; readonly releases: number } {
    return { bytes: this.bytes, peak: this.peak, releases: this.releases };
  }

  private releaseBefore(keep: number): boolean {
    let next: RetainedBytes | undefined;
    let used = keep;
    for (const member of this.members) {
      const oldest = member.oldest();
      if (oldest !== undefined && oldest < used) {
        used = oldest;
        next = member;
      }
    }
    if (next === undefined) return false;
    next.releaseOldest();
    this.releases++;
    return true;
  }
}

const realmKey = Symbol.for('forgeax.assets.retention-budget');
const realm = globalThis as typeof globalThis & { [realmKey]?: RetentionBudget };

/** The budget every read cache of this realm shares. */
export function realmRetention(): RetentionBudget {
  realm[realmKey] ??= new RetentionBudget();
  return realm[realmKey];
}

/** Release every releasable entry this realm retains. */
export function trimRetainedBytes(): void {
  realm[realmKey]?.trim();
}

/** Advance this realm's idle release; call once per frame. */
export function stepRetainedBytes(now = performance.now()): void {
  realm[realmKey]?.step(now);
}
