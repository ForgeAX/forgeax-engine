import { AudioError, err, ok, type Result } from '@forgeax/engine-types';

export interface AudioBusSend {
  readonly bus: string;
  readonly gain: number;
  /** Relative to this bus's fader; both taps obey its mute. */
  readonly tap: 'pre-fader' | 'post-fader';
}

export interface AudioBus {
  readonly id: string;
  /** Exactly one root uses null and connects to the device output. */
  readonly parent: string | null;
  readonly volume?: number;
  readonly muted?: boolean;
  readonly sends?: readonly AudioBusSend[];
}

export const DEFAULT_AUDIO_BUSES: readonly AudioBus[] = [
  { id: 'master', parent: null },
  { id: 'sfx', parent: 'master' },
  { id: 'music', parent: 'master' },
];

/** Validate all audible edges together: a send cannot introduce feedback. */
export function validateAudioBuses(buses: readonly AudioBus[]): Result<void, AudioError> {
  const fail = (reason: string) =>
    err(
      new AudioError({
        code: 'control-failed',
        expected: 'a bounded acyclic audio graph with one output',
        hint: 'use unique bus IDs, one null parent, valid references and finite non-negative gains',
        detail: { code: 'control-failed', reason },
      }),
    );
  if (buses.length < 1 || buses.length > 64) return fail('bus count must be 1..64');
  const ids = new Map(buses.map((bus) => [bus.id, bus]));
  if (ids.size !== buses.length) return fail('duplicate bus ID');
  if (buses.filter((bus) => bus.parent === null).length !== 1)
    return fail('exactly one root required');
  for (const bus of buses) {
    if (
      !bus.id ||
      bus.id.length > 128 ||
      !Number.isFinite(bus.volume ?? 1) ||
      !Number.isFinite(Math.fround(bus.volume ?? 1)) ||
      (bus.volume ?? 1) < 0
    )
      return fail('invalid bus ID or volume');
    if ((bus.sends?.length ?? 0) > 32) return fail('at most 32 sends per bus');
    if (bus.parent !== null && !ids.has(bus.parent)) return fail(`missing parent for ${bus.id}`);
    for (const send of bus.sends ?? []) {
      if (
        !ids.has(send.bus) ||
        !Number.isFinite(send.gain) ||
        !Number.isFinite(Math.fround(send.gain)) ||
        send.gain < 0 ||
        (send.tap !== 'pre-fader' && send.tap !== 'post-fader')
      )
        return fail(`invalid send from ${bus.id}`);
    }
  }
  const visited = new Set<string>(),
    visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    const bus = ids.get(id);
    if (!bus) return false;
    for (const target of [
      ...(bus.parent === null ? [] : [bus.parent]),
      ...(bus.sends ?? []).map((send) => send.bus),
    ])
      if (!visit(target)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  return buses.every((bus) => visit(bus.id)) ? ok(undefined) : fail('parent/send feedback cycle');
}
