// 6.0.2 ships index.d.ts but omits it from the ESM exports condition. The used
// surface is standard Event/EventTarget plus these two event attribute helpers.
declare module 'event-target-shim' {
  export const Event: typeof globalThis.Event;
  export const EventTarget: typeof globalThis.EventTarget;
  export function getEventAttributeValue(
    target: globalThis.EventTarget,
    type: string,
  ): ((event: globalThis.Event) => void) | null;
  export function setEventAttributeValue(
    target: globalThis.EventTarget,
    type: string,
    callback: ((event: globalThis.Event) => void) | null,
  ): void;
}
