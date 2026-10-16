import { CheckList, defineFeature } from '../../lab/feature';
import { inspect, mainChannel, spawnGrid } from './support/scene';

export default defineFeature({
  title: 'GPU view culling',
  catalog: 'GPU view culling',
  kind: 'probe',
  summary:
    'A compute kernel frustum-culls eligible rigid objects for the main view. Twenty cubes sit in front of the camera and six magenta cubes behind it.',
  expect:
    "All checks pass: the main view runs on lane 'gpu' with reason 'none', the frame schedules the gpu-driven frustum-compact pass, and frustum stats cull at least the six hidden cubes while all 20 visible cubes stay on screen.",
  async setup({ app, world, frames }) {
    spawnGrid(world, 6);
    await frames(20);
    return {
      checks() {
        const checks = new CheckList();
        const state = inspect(app);
        const main = mainChannel(app);
        checks.equal('main view lane', main?.lane, 'gpu');
        checks.equal('main view lane reason', main?.reason, 'none');
        checks.ok(
          'frame schedules gpu-driven frustum culling',
          state.passes.some((name) => name.includes('gpu-driven') && name.includes('frustum')),
          state.passes.filter((name) => name.includes('gpu-driven')).join(','),
        );
        checks.ok(
          'hidden cubes culled',
          state.frustum.culled >= 6,
          `culled=${state.frustum.culled} total=${state.frustum.total}`,
        );
        checks.ok(
          'visible cubes kept',
          state.frustum.total - state.frustum.culled >= 20,
          `culled=${state.frustum.culled} total=${state.frustum.total}`,
        );
        return checks.items;
      },
    };
  },
});
