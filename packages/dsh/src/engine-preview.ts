import { Update } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';

import {
  type EnginePreviewStatus,
  FEDERATION_PROTOCOL_VERSION,
  isEnginePreviewRequest,
} from './protocol';

export interface EnginePreviewPluginOptions {
  readonly window?: Window;
  readonly initialState?: number;
  readonly control?: (state: number) => number | Promise<number>;
}

/**
 * Engine-native half of the DSH Web preview bridge. The effect owns one ECS
 * counter system and one postMessage listener; neither exists while disabled.
 */
export function enginePreviewPlugin(options: EnginePreviewPluginOptions = {}): Plugin {
  return {
    name: 'dsh-engine-preview',
    inject: ['world'],
    apply(ctx) {
      const targetWindow = options.window ?? globalThis.window;
      let tick = 0;
      let state = options.initialState ?? 0;
      const systemName = 'dsh-engine-preview-tick';

      ctx.effect(() => {
        ctx.world
          .addSystem(Update, {
            name: systemName,
            queries: [],
            fn: () => {
              tick += 1;
            },
          })
          .unwrap();

        const respond = (event: MessageEvent, value: EnginePreviewStatus): void => {
          if (event.source === null) return;
          const origin = event.origin === 'null' ? '*' : event.origin;
          (event.source as WindowProxy).postMessage(value, { targetOrigin: origin });
        };
        const snapshot = (): EnginePreviewStatus => ({
          protocol: FEDERATION_PROTOCOL_VERSION,
          kind: 'forgeax-engine-status',
          binding: 'external',
          ready: true,
          frameId: tick,
          tick,
          state,
        });
        const onMessage = (event: MessageEvent): void => {
          if (!isEnginePreviewRequest(event.data)) return;
          if (event.data.kind === 'forgeax-engine-poll') {
            respond(event, snapshot());
            return;
          }
          Promise.resolve(options.control?.(state) ?? (state === 0 ? 1 : 0))
            .then((next) => {
              state = next;
              respond(event, snapshot());
            })
            .catch(() => undefined);
        };
        targetWindow.addEventListener('message', onMessage);

        return () => {
          targetWindow.removeEventListener('message', onMessage);
          ctx.world.removeSystem(Update, systemName).unwrap();
        };
      }, 'dsh-engine-preview: tick and message bridge');
    },
  };
}
