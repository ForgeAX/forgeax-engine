import { Time, Update } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';

const PRINT_MESSAGE_STATE_KEY = 'PrintMessageState';

interface PrintMessageState {
  message: string;
  waitDuration: number;
  accumulator: number;
}

/**
 * Custom plugin that prints a message every `waitDuration` seconds.
 * Reproduces Bevy `app/plugin`: a Plugin with configuration that registers
 * a resource and an Update system.
 */
export function printMessagePlugin(waitDuration: number, message: string): Plugin {
  return {
    name: 'print-message',
    inject: ['world'],
    apply(ctx) {
      ctx.effect(() => {
        ctx.world.insertResource<PrintMessageState>(PRINT_MESSAGE_STATE_KEY, {
          message,
          waitDuration,
          accumulator: 0,
        });
        ctx.world.addSystem(Update, {
          name: 'print-message-system',
          queries: [],
          fn: (world) => {
            const state = world.getResource<PrintMessageState>(PRINT_MESSAGE_STATE_KEY);
            const time = world.getResource(Time);
            state.accumulator += time.delta;
            if (state.accumulator >= state.waitDuration) {
              state.accumulator -= state.waitDuration;
              console.log(state.message);
            }
          },
        });
        return () => {
          ctx.world.removeSystem(Update, 'print-message-system');
          ctx.world.removeResource(PRINT_MESSAGE_STATE_KEY);
        };
      }, 'print-message/runtime');
    },
  };
}
