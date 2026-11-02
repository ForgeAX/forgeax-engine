import type { ShowSegment } from './director.ts';
import type { ShowCommand, ShowState, ShowSubjectPanel } from './show.ts';

/** Messages between the Show (source realm) and its timeline UI (presentation realm). */
export const SHOW_CHANNEL = 'modeling-show';

export type ShowMessage =
  | {
      readonly channel: typeof SHOW_CHANNEL;
      readonly kind: 'program';
      readonly subjects: readonly ShowSubjectPanel[];
      readonly segments: readonly ShowSegment[];
      /** Build identity shown on the page (source commits). */
      readonly label?: string;
    }
  | { readonly channel: typeof SHOW_CHANNEL; readonly kind: 'state'; readonly state: ShowState }
  | { readonly channel: typeof SHOW_CHANNEL; readonly kind: 'command'; readonly command: ShowCommand };

export function isShowMessage(data: unknown): data is ShowMessage {
  return typeof data === 'object' && data !== null && (data as { channel?: unknown }).channel === SHOW_CHANNEL;
}
