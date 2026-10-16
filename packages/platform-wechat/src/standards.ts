import { TextDecoder, TextEncoder } from '@exodus/bytes/encoding.js';
import { type PlatformError, platformError } from '@forgeax/engine-platform';
import { ok, type Result } from '@forgeax/engine-types';
import DOMException from 'core-js-pure/actual/dom-exception/index.js';
import clone from 'core-js-pure/actual/structured-clone.js';
import URL from 'core-js-pure/actual/url/index.js';
import URLSearchParams from 'core-js-pure/actual/url-search-params/index.js';
import { Event, EventTarget } from 'event-target-shim';
import { RealmAbortController, RealmAbortSignal } from './abort.js';
import { RealmMessageChannel, RealmMessageEvent, RealmMessagePort } from './message-channel.js';

export type StructuredClone = <T>(value: T, options?: { transfer?: object[] }) => T;

/** Install missing standards before loading the game. These belong to the realm, not one App. */
export function installWechatStandards(): Result<void, PlatformError> {
  const realm = globalThis;
  if ((typeof realm.AbortController === 'function') !== (typeof realm.AbortSignal === 'function')) {
    return platformError('platform-unavailable', {
      operation: 'standards.AbortController/AbortSignal pair',
    });
  }
  if ((typeof realm.MessageChannel === 'function') !== (typeof realm.MessagePort === 'function')) {
    return platformError('platform-unavailable', {
      operation: 'standards.MessageChannel/MessagePort pair',
    });
  }
  const installed: [string, PropertyDescriptor | undefined][] = [];
  let operation = 'standards';
  try {
    for (const [name, fallback] of Object.entries({
      TextEncoder,
      TextDecoder,
      URL,
      URLSearchParams,
      structuredClone: clone,
      DOMException,
      Event,
      EventTarget,
      AbortController: RealmAbortController,
      AbortSignal: RealmAbortSignal,
      MessageEvent: RealmMessageEvent,
      MessageChannel: RealmMessageChannel,
      MessagePort: RealmMessagePort,
    })) {
      if (typeof Reflect.get(realm, name) === 'function') continue;
      operation = `standards.${name}`;
      const previous = Object.getOwnPropertyDescriptor(realm, name);
      Object.defineProperty(realm, name, {
        value: fallback,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      installed.push([name, previous]);
    }
    return ok(undefined);
  } catch (cause) {
    for (const [name, descriptor] of installed.reverse()) {
      if (descriptor) Object.defineProperty(realm, name, descriptor);
      else Reflect.deleteProperty(realm, name);
    }
    return platformError('platform-operation-failed', { operation, cause });
  }
}
