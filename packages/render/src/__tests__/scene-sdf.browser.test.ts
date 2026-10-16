import { it } from 'vitest';
import { verifySceneSdf, verifySceneSdfContactGradient } from './scene-sdf.fixture';

it('composes and shares a managed field, bounds swept collision and replays exact results on fresh WebGPU', async () => {
  await verifySceneSdf();
}, 120000);

it('releases the captured floor/wall contact and replays it on fresh native WebGPU', async () => {
  await verifySceneSdfContactGradient();
}, 120000);
