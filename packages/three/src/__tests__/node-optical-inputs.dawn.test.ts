import { it } from 'vitest';
import { dawnRendererFixture } from './dawn-renderer.fixture';
import { verifyLitNodeInputs } from './lit-node-inputs.fixture';
import { opticalModes, verifyOpticalNodeInputs } from './optical-node-inputs.fixture';

const getRenderer = dawnRendererFixture();

it.each([false, true])('renders and replays lit uniforms and loaded=%s scenes on Dawn', {
  timeout: 120000,
}, async (loaded) => {
  const renderer = await getRenderer();
  await verifyLitNodeInputs(renderer, loaded, async () => {});
});

it.each(opticalModes)('renders and replays %s optical node uniforms on Dawn', {
  timeout: 120000,
}, async (mode) => {
  const renderer = await getRenderer();
  await verifyOpticalNodeInputs(renderer, mode, async () => {});
});
