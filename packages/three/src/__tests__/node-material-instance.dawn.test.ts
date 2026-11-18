import { it } from 'vitest';
import { dawnRendererFixture } from './dawn-renderer.fixture';
import {
  instanceModes,
  verifyInstanceBoundaries,
  verifyMaterialInstances,
} from './node-material-instance.fixture';

const getRenderer = dawnRendererFixture();
const getBoundaryRenderer = dawnRendererFixture();

it.each(instanceModes)('renders %s material instances and shared edits on Dawn', {
  timeout: 120000,
}, async (mode) => {
  const renderer = await getRenderer();
  await verifyMaterialInstances(renderer, mode, async () => {});
});

it('rejects unsupported instance boundaries before publication and recovers on Dawn', {
  timeout: 120000,
}, async () => {
  const renderer = await getBoundaryRenderer();
  await verifyInstanceBoundaries(renderer, async () => {});
});
