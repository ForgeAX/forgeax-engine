/**
 * Default-on, bounded load timeline shared by every Engine realm.
 *
 * Each realm (page, Engine Worker, Render Worker, kernel Worker) appends
 * records to its own fixed-capacity buffer. Recording is a timestamp read and
 * one small object push; nothing is posted, cloned or logged until a consumer
 * calls {@link collectLoadTimeline}. Collection pulls every live realm's buffer
 * over a page-scoped `BroadcastChannel`, sharing the progress model's page
 * identity. Unscoped native realms record locally without opening a channel.
 *
 * Times are epoch milliseconds (`performance.timeOrigin + performance.now()`),
 * which aligns realms without a clock handshake. A consumer derives phases from
 * marks; records never store a phase they could be assigned from their time.
 */

import { type LoadChannel, loadChannelConstructor } from './load-channel.js';
import { loadProgressScope } from './load-progress.js';

/** Stable record categories. `mark` is an instant; every other kind is a span. */
export type LoadTimelineKind =
  | 'mark'
  | 'boot'
  | 'fetch'
  | 'decode'
  | 'shader'
  | 'pipeline'
  | 'frame';

export type LoadTimelineDetailValue = string | number | boolean | null;

export interface LoadTimelineRecord {
  readonly kind: LoadTimelineKind;
  /** Owner-defined name: a boot step, a URL, a shader/pipeline label or an App mark. */
  readonly name: string;
  /** Recording realm, e.g. `main`, `engine-worker`, `render-worker`. */
  readonly realm: string;
  /** Epoch milliseconds. */
  readonly start: number;
  /** Epoch milliseconds; equals `start` for a mark. */
  readonly end: number;
  /** Payload or source size when the owner knows it (transferred body, WGSL characters). */
  readonly bytes?: number;
  readonly detail?: Readonly<Record<string, LoadTimelineDetailValue>>;
}

export interface LoadTimelineRealmSnapshot {
  readonly realm: string;
  /** This realm's `performance.timeOrigin`, for converting back to its local clock. */
  readonly timeOrigin: number;
  readonly records: readonly LoadTimelineRecord[];
  /** Records rejected after the realm reached its capacity. */
  readonly dropped: number;
}

export interface LoadTimelineSnapshot {
  readonly version: 1;
  /** Collector realm's `performance.timeOrigin` (page navigation start on the main thread). */
  readonly timeOrigin: number;
  readonly realms: readonly LoadTimelineRealmSnapshot[];
}

/** Records per realm; a full-map game load records a few thousand. Later records count as dropped. */
export const LOAD_TIMELINE_CAPACITY = 16_384;
const CHANNEL = 'forgeax:load-timeline:';
const GLOBAL_KEY = '__forgeaxLoadTimeline';

interface RealmBuffer {
  realm: string;
  readonly id: string;
  readonly records: LoadTimelineRecord[];
  dropped: number;
  scope?: string | undefined;
  channel?: LoadChannel | undefined;
}

type CollectRequest = { readonly type: 'collect'; readonly id: string; readonly from: string };
type CollectReply = {
  readonly type: 'snapshot';
  readonly id: string;
  readonly snapshot: LoadTimelineRealmSnapshot;
};

const scope = globalThis as typeof globalThis & {
  [GLOBAL_KEY]?: LoadTimelineInspection;
  __forgeaxLoadTimelineBuffer?: RealmBuffer;
};

function now(): number {
  const performance = globalThis.performance;
  return performance === undefined ? Date.now() : performance.timeOrigin + performance.now();
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function defaultRealm(): string {
  if (typeof (globalThis as { document?: unknown }).document === 'object') return 'main';
  const name = (globalThis as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : 'worker';
}

function buffer(): RealmBuffer {
  // One buffer per realm even when bundlers duplicate this module.
  let current = scope.__forgeaxLoadTimelineBuffer;
  if (current === undefined) {
    current = { realm: defaultRealm(), id: randomId(), records: [], dropped: 0 };
    scope.__forgeaxLoadTimelineBuffer = current;
    // Inspection surface for browser automation and version-independent game marks.
    scope[GLOBAL_KEY] ??= {
      collect: collectLoadTimeline,
      snapshot: snapshotLoadTimeline,
      mark: markLoadTimeline,
    };
  }
  const page = loadProgressScope();
  if (current.scope !== page) {
    current.channel?.close();
    current.channel = undefined;
    current.scope = page;
    if (page !== undefined) listen(current, page);
  }
  return current;
}

function listen(target: RealmBuffer, page: string): void {
  const Channel = loadChannelConstructor();
  if (Channel === undefined) return;
  try {
    const channel = new Channel(CHANNEL + page);
    channel.unref?.();
    channel.onmessage = (event) => {
      const request = event.data as CollectRequest | undefined;
      if (request?.type !== 'collect' || request.from === target.id) return;
      const reply: CollectReply = {
        type: 'snapshot',
        id: request.id,
        snapshot: snapshotLoadTimeline(),
      };
      channel.postMessage(reply);
    };
    target.channel = channel;
  } catch {
    // A realm without a usable channel still serves its own snapshot.
  }
}

/** Append one completed record. Never throws; a full buffer counts drops. */
export function recordLoadTimeline(
  kind: LoadTimelineKind,
  name: string,
  start: number,
  end: number = now(),
  bytes?: number,
  detail?: Readonly<Record<string, LoadTimelineDetailValue>>,
): void {
  const target = buffer();
  if (target.records.length >= LOAD_TIMELINE_CAPACITY) {
    target.dropped++;
    return;
  }
  target.records.push({
    kind,
    name,
    realm: target.realm,
    start,
    end,
    ...(bytes === undefined || !Number.isFinite(bytes) ? {} : { bytes }),
    ...(detail === undefined ? {} : { detail }),
  });
}

/** Current epoch-millisecond clock used by every record. */
export const loadTimelineNow: () => number = now;

/**
 * Start a span and return its completion. The completion may add bytes or
 * detail known only at the end; calling it twice records once.
 */
export function beginLoadTimeline(
  kind: Exclude<LoadTimelineKind, 'mark'>,
  name: string,
  detail?: Readonly<Record<string, LoadTimelineDetailValue>>,
): (bytes?: number, endDetail?: Readonly<Record<string, LoadTimelineDetailValue>>) => void {
  const start = now();
  let open = true;
  return (bytes, endDetail) => {
    if (!open) return;
    open = false;
    recordLoadTimeline(
      kind,
      name,
      start,
      now(),
      bytes,
      endDetail === undefined ? detail : { ...detail, ...endDetail },
    );
  };
}

/** Record an App- or Engine-defined instant such as `home-ready` or `map-ready`. */
export function markLoadTimeline(
  name: string,
  detail?: Readonly<Record<string, LoadTimelineDetailValue>>,
): void {
  const at = now();
  recordLoadTimeline('mark', name, at, at, undefined, detail);
}

/** This realm's records only; synchronous. */
export function snapshotLoadTimeline(): LoadTimelineRealmSnapshot {
  const target = buffer();
  return {
    realm: target.realm,
    timeOrigin: globalThis.performance?.timeOrigin ?? 0,
    records: target.records.slice(),
    dropped: target.dropped,
  };
}

/**
 * Collect this page's live realms. Realms answer over a page-scoped
 * BroadcastChannel; a realm busy longer than `timeoutMs` is absent from the
 * result rather than delaying it. A terminated Worker's records are gone.
 */
export async function collectLoadTimeline(
  options: { readonly timeoutMs?: number } = {},
): Promise<LoadTimelineSnapshot> {
  const local = snapshotLoadTimeline();
  const realms: LoadTimelineRealmSnapshot[] = [local];
  const timeoutMs = options.timeoutMs ?? 250;
  const Channel = loadChannelConstructor();
  const page = buffer().scope;
  if (Channel !== undefined && page !== undefined && timeoutMs > 0) {
    const id = randomId();
    const channel = new Channel(CHANNEL + page);
    try {
      channel.onmessage = (event) => {
        const reply = event.data as CollectReply | undefined;
        if (reply?.type === 'snapshot' && reply.id === id) realms.push(reply.snapshot);
      };
      channel.postMessage({ type: 'collect', id, from: buffer().id } satisfies CollectRequest);
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    } finally {
      channel.close();
    }
  }
  return { version: 1, timeOrigin: local.timeOrigin, realms };
}

/** `globalThis.__forgeaxLoadTimeline`, installed by each realm's first record. */
export interface LoadTimelineInspection {
  readonly collect: typeof collectLoadTimeline;
  readonly snapshot: typeof snapshotLoadTimeline;
  readonly mark: typeof markLoadTimeline;
}
