/**
 * Source -> receiver publication of VFX tick intents without resending heavy payloads.
 *
 * A queued intent stays in every published frame until the receiver acknowledges it,
 * so with several frames in flight the same per-tick payload would be structured-cloned
 * repeatedly. The source sends each intent's payload once per receiver session and a
 * payload-free reference afterwards; the receiver resolves references from its
 * per-sequence cache. A receiver miss (aborted frame, cache reset after a device or
 * render-generation change) is reported back and the source resends the full intent.
 */

/** Heavy per-tick fields the receiver keeps in its per-sequence intent cache. */
const PAYLOAD_KEYS = [
  'parameterBlock',
  'canonicalPayload',
  'replayInput',
  'channelInputs',
] as const;
type PayloadKey = (typeof PAYLOAD_KEYS)[number];

/** A queued intent whose payload the receiver already holds for this sequence. */
export type VfxIntentReference<T> = Omit<T, PayloadKey> & { readonly payload: 'cached' };

export function isVfxIntentReference<T extends object>(
  intent: T | VfxIntentReference<T>,
): intent is VfxIntentReference<T> {
  return (intent as { readonly payload?: unknown }).payload === 'cached';
}

function referenceOf<T extends { readonly sequence: number }>(intent: T): VfxIntentReference<T> {
  const reference: Record<string, unknown> = { ...intent, payload: 'cached' };
  for (const key of PAYLOAD_KEYS) delete reference[key];
  return reference as VfxIntentReference<T>;
}

interface PublishableIntent {
  readonly sequence: number;
  readonly player: number;
  readonly emitter: { readonly id: string };
}

/** One published tick: its stream and sequence. */
const tickKey = (intent: PublishableIntent): string =>
  `${Number(intent.player)}:${intent.emitter.id}:${intent.sequence}`;

/** Source ledger of ticks whose payload was published, per runtime render session. */
export function createVfxIntentPublication() {
  /** Session -> published tick key -> its sequence and the frame that carried the payload. */
  const sent = new Map<
    string,
    Map<string, { readonly sequence: number; readonly frame: number }>
  >();
  return {
    /** Full payload on first publication; a reference while the receiver may hold it. */
    publish<T extends PublishableIntent>(
      session: string,
      intent: T,
      cacheable: boolean,
      frame: number,
    ): T | VfxIntentReference<T> {
      if (!cacheable) return intent;
      let ticks = sent.get(session);
      if (ticks === undefined) {
        ticks = new Map();
        sent.set(session, ticks);
      }
      const key = tickKey(intent);
      if (ticks.has(key)) return referenceOf(intent);
      ticks.set(key, { sequence: intent.sequence, frame });
      return intent;
    },
    /** The receiver lacked these sequences: send their payloads again. */
    forget(session: string, sequences: readonly number[]): void {
      const ticks = sent.get(session);
      if (ticks === undefined || sequences.length === 0) return;
      const missing = new Set(sequences);
      for (const [key, tick] of ticks) if (missing.has(tick.sequence)) ticks.delete(key);
    },
    /** A new receiver session holds nothing: send every payload again. */
    reset(): void {
      sent.clear();
    },
    /** A publication carrying these payloads was never sent: send them again. */
    discard(frame: number): void {
      for (const ticks of sent.values())
        for (const [key, tick] of ticks) if (tick.frame === frame) ticks.delete(key);
    },
    /** Keep only ticks still queued in the given sessions; drop other sessions. */
    retain(live: ReadonlyMap<string, ReadonlySet<string>>): void {
      for (const [session, ticks] of sent) {
        const queued = live.get(session);
        if (queued === undefined) sent.delete(session);
        else for (const key of ticks.keys()) if (!queued.has(key)) ticks.delete(key);
      }
    },
  };
}

/** Stream identity shared by the source adoption ledger and the receiver cache. */
export const retainedStreamKey = (
  runtime: number,
  generation: number,
  player: number,
  emitter: string,
): string => `${runtime}:${generation}:${Number(player)}:${emitter}`;

/** Append one per-runtime miss to a frame ledger. */
export function recordVfxMiss<T>(ledger: Map<number, T[]>, runtime: number, value: T): void {
  let missing = ledger.get(runtime);
  if (missing === undefined) {
    missing = [];
    ledger.set(runtime, missing);
  }
  missing.push(value);
}

/** The intent behind one retained row: its new copy, or the receiver's cached copy of that sequence. */
export function resolveRetainedIntent<I extends { readonly sequence: number }>(
  received: Map<string, { readonly sequence: number; readonly intent: I }>,
  resolution: {
    readonly liveRetained: Set<string>;
    readonly missingRetained: Map<number, string[]>;
  },
  entry: { readonly runtimeId: number; readonly renderGeneration: number },
  row: {
    readonly player: number;
    readonly emitter: { readonly id: string };
    readonly intentSequence: number;
    readonly intent?: I;
  },
  recent?: { find(key: string, sequence: number): I | undefined },
): I | undefined {
  const key = retainedStreamKey(
    entry.runtimeId,
    entry.renderGeneration,
    row.player,
    row.emitter.id,
  );
  resolution.liveRetained.add(key);
  if (row.intent !== undefined) {
    received.set(key, { sequence: row.intentSequence ?? row.intent.sequence, intent: row.intent });
    return row.intent;
  }
  const cached = received.get(key);
  if (cached !== undefined && cached.sequence === row.intentSequence) return cached.intent;
  const queued = recent?.find(key, row.intentSequence);
  if (queued !== undefined) return queued;
  // Not drawable this frame; the source resends it next frame.
  recordVfxMiss(resolution.missingRetained, entry.runtimeId, key);
  return undefined;
}

/** Publish one world's queued intents through the ledger, recording its live session. */
export function publishQueuedIntents<S extends PublishableIntent, P extends PublishableIntent>(
  ledger: ReturnType<typeof createVfxIntentPublication>,
  sessions: Map<string, Set<string>>,
  session: string,
  intents: readonly S[],
  publish: (intent: S) => P,
  cacheable: (intent: S) => boolean,
  frame: number,
): (P | VfxIntentReference<P>)[] {
  let queued = sessions.get(session);
  if (queued === undefined) {
    queued = new Set();
    sessions.set(session, queued);
  }
  const published: (P | VfxIntentReference<P>)[] = [];
  for (const intent of intents) {
    const next = publish(intent);
    queued.add(tickKey(next));
    published.push(ledger.publish(session, next, cacheable(intent), frame));
  }
  return published;
}

/**
 * Receiver store of published tick payloads, per runtime render session. It survives
 * device replacement (the payload is CPU data), so a recovering device can resolve every
 * still-queued reference without a source round trip. Entries live while their tick is
 * still published.
 */
export function createVfxIntentPayloads() {
  const sessions = new Map<number, { generation: number; ticks: Map<string, object> }>();
  return {
    /** Start one runtime's frame: reset on a new render session, keep only published ticks. */
    begin(runtime: number, generation: number, published: readonly PublishableIntent[]): void {
      let session = sessions.get(runtime);
      if (session?.generation !== generation) {
        session = { generation, ticks: new Map() };
        sessions.set(runtime, session);
      }
      const live = new Set(published.map(tickKey));
      for (const key of session.ticks.keys()) if (!live.has(key)) session.ticks.delete(key);
    },
    /** A full intent: remember its payload; a reference: restore it, or undefined on a miss. */
    resolve<T extends PublishableIntent>(
      runtime: number,
      intent: T | VfxIntentReference<T>,
    ): T | undefined {
      const ticks = sessions.get(runtime)?.ticks;
      const key = tickKey(intent);
      if (!isVfxIntentReference(intent)) {
        const payload: Record<string, unknown> = {};
        for (const field of PAYLOAD_KEYS)
          payload[field] = (intent as Record<string, unknown>)[field];
        ticks?.set(key, payload);
        return intent;
      }
      const payload = ticks?.get(key);
      if (payload === undefined) return undefined;
      const { payload: _cached, ...fields } = intent;
      return { ...fields, ...payload } as unknown as T;
    },
    retire(live: ReadonlySet<number>): void {
      for (const runtime of sessions.keys()) if (!live.has(runtime)) sessions.delete(runtime);
    },
  };
}

/**
 * Resolve one frame's queued intents in order. A tick without a payload is reported
 * missing and blocks later ticks of its stream for this frame, preserving order.
 */
export function createQueuedIntentResolution<I>(
  missing: Map<number, number[]>,
  runtime: number,
  resolve: (published: PublishableIntent) => I | undefined,
) {
  const blocked = new Set<string>();
  return (published: PublishableIntent): I | undefined => {
    const stream = `${Number(published.player)}:${published.emitter.id}`;
    const intent = blocked.has(stream) ? undefined : resolve(published);
    if (intent !== undefined) return intent;
    blocked.add(stream);
    recordVfxMiss(missing, runtime, published.sequence);
    return undefined;
  };
}

/**
 * Receiver history of queued intents it resolved, per retained stream (last few
 * sequences). A tick the receiver dispatched becomes the source's committed retained
 * row; the source then references it by sequence and the receiver resolves it here.
 */
export function createRecentQueuedIntents<I extends PublishableIntent>(depth = 8) {
  const streams = new Map<string, Map<number, I>>();
  const touched = new Set<string>();
  return {
    remember(
      entry: { readonly runtimeId: number; readonly renderGeneration: number },
      intent: I,
    ): void {
      const key = retainedStreamKey(
        entry.runtimeId,
        entry.renderGeneration,
        intent.player,
        intent.emitter.id,
      );
      touched.add(key);
      let recent = streams.get(key);
      if (recent === undefined) {
        recent = new Map();
        streams.set(key, recent);
      }
      recent.set(intent.sequence, intent);
      if (recent.size > depth) recent.delete(recent.keys().next().value as number);
    },
    find(key: string, sequence: number): I | undefined {
      touched.add(key);
      return streams.get(key)?.get(sequence);
    },
    /** Keep only streams this frame referenced. */
    endFrame(): void {
      for (const key of streams.keys()) if (!touched.has(key)) streams.delete(key);
      touched.clear();
    },
  };
}

/**
 * Source adoption after a submitted frame: retained rows it carried, and ticks the
 * receiver dispatched (it resolved their payload as queued work), are now cached there.
 * Reported misses are resent; the ledger keeps only streams this frame retained or dispatched.
 */
export function adoptSubmittedRetained(
  adopted: Map<string, number>,
  source: {
    readonly runtimeId: number;
    readonly renderGeneration: number;
    readonly retained: readonly {
      readonly player: number;
      readonly emitter: { readonly id: string };
      readonly intentSequence: number;
      readonly intent?: unknown;
    }[];
    readonly intents: readonly PublishableIntent[];
  },
  dispatched: readonly number[],
  missing: readonly string[],
): void {
  const key = (player: number, emitter: string) =>
    retainedStreamKey(source.runtimeId, source.renderGeneration, player, emitter);
  const live = new Set<string>();
  for (const row of source.retained) {
    const stream = key(row.player, row.emitter.id);
    live.add(stream);
    if (row.intent !== undefined) adopted.set(stream, row.intentSequence);
  }
  const published = new Set(dispatched);
  for (const intent of source.intents)
    if (published.has(intent.sequence)) {
      const stream = key(intent.player, intent.emitter.id);
      live.add(stream);
      if ((adopted.get(stream) ?? -1) < intent.sequence) adopted.set(stream, intent.sequence);
    }
  for (const stream of missing) adopted.delete(stream);
  const prefix = `${source.runtimeId}:`;
  for (const stream of adopted.keys())
    if (stream.startsWith(prefix) && !live.has(stream)) adopted.delete(stream);
}
