import type { FrameReceipt } from '@forgeax/engine/render';
import { PointLight } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnGrid } from './support/scene';

function nextReceipt(
  subscribe: (listener: (event: { kind: string; receipt?: FrameReceipt }) => void) => () => void,
) {
  return new Promise<FrameReceipt>((resolve) => {
    const stop = subscribe((event) => {
      if (event.kind !== 'frame-submitted' || event.receipt === undefined) return;
      stop();
      resolve(event.receipt);
    });
  });
}

export default defineFeature({
  title: 'Deferred membership timing',
  catalog: 'Deferred membership timing',
  kind: 'probe',
  summary:
    'App forwards the opt-in gpuPassTiming configuration to Render; observing a submitted frame receipt returns bounded GPU pass timing that includes the Cluster membership producer pass of the deferred light path.',
  expect:
    "All checks pass: the frame schedules a cluster membership pass, observe(receipt, { include: ['timings'] }) returns a closed status, and on a timestamp-capable device the membership pass is 'measured' with a non-negative duration (otherwise the status is 'unavailable' with the capability).",
  appOptions: { gpuPassTiming: {} },
  async setup({ app, world, frames }) {
    spawnGrid(world);
    const colors: [number, number, number][] = [
      [1, 0.3, 0.2],
      [0.2, 1, 0.4],
      [0.3, 0.5, 1],
      [1, 0.9, 0.2],
    ];
    colors.forEach((color, index) => {
      world
        .spawn(
          { component: Transform, data: { pos: [(index - 1.5) * 2, 1.5, 0] } as never },
          { component: PointLight, data: { color, intensity: 6, range: 6 } as never },
        )
        .unwrap();
    });
    await frames(10);
    return {
      async checks() {
        const checks = new CheckList();
        const passes = app.renderer.inspect().perFramePassNames;
        const membershipPass = passes.find((name) => name.includes('membership'));
        checks.ok(
          'frame schedules a cluster membership pass',
          membershipPass !== undefined,
          passes.filter((name) => name.includes('cluster')).join(','),
        );

        const receipt = await nextReceipt((listener) => app.renderer.subscribe(listener as never));
        const observed = await app.renderer.observe(receipt, { include: ['timings'] });
        checks.ok(
          'observe(receipt) ok',
          observed.ok,
          observed.ok ? undefined : observed.error.code,
        );
        if (!observed.ok) return checks.items;
        const timings = observed.value.timings;
        checks.ok('timings present', timings !== undefined);
        if (timings === undefined) return checks.items;
        const caps = app.renderer.inspect().capabilities;
        switch (timings.status) {
          case 'complete':
          case 'partial': {
            const entry = timings.frame.passes.find((pass) => pass.passName.includes('membership'));
            checks.ok(
              'membership pass timed',
              entry !== undefined,
              timings.frame.passes.map((pass) => pass.passName).join(','),
            );
            checks.ok(
              'membership pass measured on GPU',
              entry?.status === 'measured' && entry.durationNanoseconds >= 0,
              JSON.stringify(entry),
            );
            checks.ok(
              'frame reports backend + capacity',
              timings.frame.passCapacity > 0,
              `backend=${timings.frame.backendKind} measured=${timings.frame.measuredPassCount}/${timings.frame.executedPassCount}`,
            );
            break;
          }
          case 'unavailable':
            checks.equal(
              'unavailable only without timestamp capability',
              caps.timestampQuery,
              false,
            );
            checks.ok(
              'unavailable carries capability data',
              timings.capability.timestampQuery === false,
              JSON.stringify(timings.reason),
            );
            break;
          case 'failed':
            checks.ok('timing capture did not fail', false, JSON.stringify(timings.error));
            break;
        }
        return checks.items;
      },
    };
  },
});
