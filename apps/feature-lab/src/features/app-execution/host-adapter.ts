import { Time, Update } from '@forgeax/engine/ecs';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'App Host adapter frame order',
  catalog: 'App Host adapter',
  kind: 'probe',
  summary:
    'Each Host frame measures one delta, calls world.update(delta) and then renderer.draw(world); the World owns Time.',
  expect:
    'All checks pass: one update per submitted frame, update runs before that frame is submitted, Time.delta is finite and clamped.',
  setup({ app, world, frames }) {
    spawnStage(world);
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.9, 0.3, 0.2, 1] }), {
      pos: [0, 0.5, 0],
    });
    let submitted = 0;
    app.renderer.subscribe((event) => {
      if (event.kind === 'frame-submitted') submitted += 1;
    });
    const samples: { submitted: number; delta: number; elapsed: number; max: number }[] = [];
    world.addSystem(Update, {
      name: 'fl-host-adapter-sample',
      queries: [],
      fn: (world) => {
        const time = world.getResource(Time);
        samples.push({
          submitted,
          delta: time.delta,
          elapsed: time.elapsed,
          max: time.maxDeltaSeconds,
        });
      },
    });
    return {
      async checks() {
        samples.length = 0;
        await frames(12);
        const s = samples.slice(1, -1);
        const c = new CheckList();
        const push = (name: string, ok: boolean, detail?: string) => c.ok(name, ok, detail);
        push('updates observed', s.length >= 8, `samples=${samples.length}`);
        const steps = s
          .slice(1)
          .map((v, i) => v.submitted - (s[i] as (typeof s)[number]).submitted);
        push(
          'exactly one submitted frame between consecutive updates',
          steps.every((d) => d === 1),
          steps.join(','),
        );
        push(
          'Time.delta finite and positive',
          s.every((v) => Number.isFinite(v.delta) && v.delta > 0),
        );
        push(
          'Time.delta <= maxDeltaSeconds',
          s.every((v) => v.delta <= v.max + 1e-9),
        );
        const grows = s.slice(1).every((v, i) => v.elapsed > (s[i] as (typeof s)[number]).elapsed);
        push('Time.elapsed strictly increases', grows);
        push('World identity unchanged', app.world === world);
        return c.items;
      },
    };
  },
});
