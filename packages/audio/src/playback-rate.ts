import type { AudioBackend } from './audio-backend';

export interface AudioPlaybackRateLease {
  readonly active: boolean;
  readonly scale: number;
  set(scale: number): void;
  release(): void;
}
interface Rates {
  readonly entries: Set<{ scale: number }>;
}
const owners = new WeakMap<AudioBackend, Rates>();
function valid(scale: number): void {
  if (!Number.isFinite(scale) || scale <= 0)
    throw new RangeError('Audio playback scale must be finite and positive');
}
/** Minimum active contribution wins. Release removes only this caller's contribution. */
export function acquireAudioPlaybackRate(backend: AudioBackend, scale = 1): AudioPlaybackRateLease {
  valid(scale);
  let rates = owners.get(backend);
  if (!rates) {
    rates = { entries: new Set() };
    owners.set(backend, rates);
  }
  const owned = rates,
    entry = { scale };
  let active = true;
  const publish = () =>
    backend.setGlobalPlaybackRate(
      owned.entries.size ? Math.min(...Array.from(owned.entries, (item) => item.scale)) : 1,
    );
  owned.entries.add(entry);
  publish();
  return {
    get active() {
      return active;
    },
    get scale() {
      return entry.scale;
    },
    set(next) {
      valid(next);
      if (!active) throw new Error('Audio playback rate lease has been released');
      entry.scale = next;
      publish();
    },
    release() {
      if (!active) return;
      active = false;
      owned.entries.delete(entry);
      publish();
    },
  };
}
