import { defineSystemSet } from '@forgeax/engine-ecs';
export const GamepadFeedbackProbeOrder = defineSystemSet({ name: 'gamepad-feedback-browser-probe' });
import { InputFrameStartScan } from "@forgeax/engine-input";
import { defineSystem } from "@forgeax/engine-ecs";
import { Update } from '@forgeax/engine-ecs';
import { GAMEPAD_FEEDBACK_KEY, INPUT_SNAPSHOT_RESOURCE_KEY } from '@forgeax/engine-input';
import { Camera, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { ExecutionBootstrapEntry } from '../src/execution/bootstrap-entry';

const entry: ExecutionBootstrapEntry = () => ({
  plugins: [{
    name: 'gamepad-feedback-browser-probe',
    inject: ['world', 'executionBootstrapHost'],
    apply(ctx) {
      const port = ctx.executionBootstrapHost.port;
      ctx.effect(() => {
        const camera = ctx.world.spawn({ component: Transform, data: { pos: [0, 0, 4] } },
          { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 }) }).unwrap();
        return () => ctx.world.despawn(camera);
      });
      let sent = false;
      let load: { mode: string; targets: number } | undefined;
      let loadTick = 0;
      if (port) port.onmessage = event => { load = event.data.kind === 'load' ? event.data : undefined; loadTick = 0; };
      ctx.effect(() => {
        const systemToken1 = defineSystem({
          name: 'gamepad-feedback-browser-probe', sets: [GamepadFeedbackProbeOrder], queries: [], after: [InputFrameStartScan],
          fn(world) {
            const tickStart = performance.now();
            const input = world.getResource(INPUT_SNAPSHOT_RESOURCE_KEY);
            const feedback = world.getResource(GAMEPAD_FEEDBACK_KEY);
            const target = input.gamepad(0).feedbackTarget;
            if (!sent && target) {
              sent = true;
              feedback.play(target, { durationMs: 120, strongMagnitude: 1, weakMagnitude: 0 });
              feedback.play(target, { durationMs: 80, strongMagnitude: 0, weakMagnitude: 1 });
              feedback.stop(target);
            }
            if (load && (load.mode === 'burst' || (load.mode === 'event' && loadTick % 60 === 0))) {
              const commands = load.mode === 'burst' ? 32 : load.targets;
              for (let n = 0; n < commands; n++) {
                const loadTarget = input.gamepad(n % load.targets).feedbackTarget;
                if (loadTarget) feedback.play(loadTarget, { durationMs: 120, strongMagnitude: 0.8, weakMagnitude: 0.2 });
              }
            }
            for (const result of feedback.readResults()) port?.postMessage({ kind: 'feedback-result', result });
            if (load) { loadTick++; port?.postMessage({ ...load, kind: 'load-frame', tickStart, producerMs: performance.now() - tickStart }); }
          },
        });
ctx.world.addSystem(Update, systemToken1).unwrap();
        return () => ctx.world.removeSystem(Update, systemToken1);
      });
    },
  }],
});
export default entry;
