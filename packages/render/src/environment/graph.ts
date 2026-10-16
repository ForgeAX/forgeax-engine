import type { EnvironmentFrame } from './frame';

/** Both Standard lanes consume the same selected CPU environment facts. */
export function sharedEnvironmentFrame(
  frame: EnvironmentFrame,
  _lane: 'direct' | 'clustered',
): EnvironmentFrame {
  return frame;
}
