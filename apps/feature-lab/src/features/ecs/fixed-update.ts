import { FixedTime, FixedUpdate, Update, World } from '@forgeax/engine/ecs';
import { defineFeature } from '../../lab/feature';

function simulate(deltas: readonly number[]): { ticks: number[]; x: number } {
  const world = new World({ time: { fixedDeltaSeconds: 1 / 50 } });
  const state = { x: 0, v: 1 };
  const ticks: number[] = [];
  world.addSystem(FixedUpdate, {
    name: 'fl-fixed-integrate',
    queries: [],
    fn: (world) => {
      const dt = world.getResource(FixedTime).delta;
      state.v -= 9.8 * dt;
      state.x += state.v * dt;
    },
  });
  world.addSystem(Update, {
    name: 'fl-fixed-sample',
    queries: [],
    fn: (world) => void ticks.push(world.getResource(FixedTime).tick),
  });
  for (const d of deltas) world.update(d);
  return { ticks, x: state.x };
}

export default defineFeature({
  title: 'FixedUpdate determinism and catch-up',
  catalog: 'FixedUpdate schedule',
  kind: 'headless',
  summary:
    'FixedUpdate runs zero or more fixed steps per world.update under TimePolicy; steps are capped by maxStepsPerUpdate and dropped time is reported.',
  expect:
    'All checks pass: tick counts follow accumulated time, different frame splits give bit-identical simulation, and a long stall drops updates.',
  run(checks) {
    const world = new World();
    let steps = 0;
    world.addSystem(FixedUpdate, {
      name: 'fl-fixed-count',
      queries: [],
      fn: () => {
        steps += 1;
      },
    });
    const fixed = () => world.getResource(FixedTime);
    checks.near('default fixed delta', fixed().delta, 1 / 60);
    checks.equal('default max steps', fixed().maxStepsPerUpdate, 4);
    const ticks: number[] = [];
    for (const d of [0.01, 0.01, 2 / 60]) {
      world.update(d);
      ticks.push(fixed().tick);
    }
    checks.equal('ticks after 0.01, 0.01, 2/60', ticks, [0, 1, 3]);
    world.update(5);
    checks.equal('stall capped at maxStepsPerUpdate', fixed().tick, 7);
    checks.equal('one fixed system call per tick', steps, 7);
    checks.ok(
      'dropped updates recorded',
      fixed().droppedUpdates > 0,
      `dropped=${fixed().droppedUpdates}`,
    );
    const a = simulate(Array.from({ length: 50 }, () => 1 / 50));
    const b = simulate(Array.from({ length: 100 }, () => 1 / 100));
    checks.equal('same final tick count', a.ticks.at(-1), b.ticks.at(-1));
    checks.ok('bit-identical state across frame splits', a.x === b.x, `${a.x} vs ${b.x}`);
    const bad = new World().update(-1);
    checks.equal('negative delta rejected', bad.ok ? 'ok' : bad.error.code, 'time-delta-invalid');
    const tight = new World({
      time: { fixedDeltaSeconds: 0.05, maxStepsPerUpdate: 4, maxDeltaSeconds: 0.1 },
    });
    const cfg = tight.update(0.01);
    checks.equal(
      'maxDelta < (maxSteps+1)*fixed rejected',
      cfg.ok ? 'ok' : cfg.error.code,
      'time-config-invalid',
    );
  },
});
