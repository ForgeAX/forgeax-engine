import { it } from 'vitest';
import { dawnRendererFixture } from './dawn-renderer.fixture';
import { primitiveInputModes, verifyPrimitiveNodeInputs } from './primitive-node-inputs.fixture';

const getRenderer = dawnRendererFixture();

it.each(primitiveInputModes)('renders and replays %s primitive node inputs on Dawn', {
  timeout: 120000,
}, async (mode) => {
  const renderer = await getRenderer();
  await verifyPrimitiveNodeInputs(renderer, mode, async () => {});
});
