import { it } from 'vitest';
import { dawnRendererFixture } from './dawn-renderer.fixture';
import { prepareThreeNodeInputMaterials } from './node-inputs.commands';
import {
  nodeInputPrimitives,
  verifyNodeInputPrimitive,
  verifyNodeInputs,
  verifyNodeOverride,
} from './node-inputs.fixture';

const getRenderer = dawnRendererFixture();
const preparedRenderer = dawnRendererFixture(async () => [await prepareThreeNodeInputMaterials()]);

it.each([
  'uniform',
  'vec4',
  'texture',
] as const)('renders and replays live %s node inputs on Dawn', {
  timeout: 120000,
}, async (mode) => {
  const renderer = await preparedRenderer();
  await verifyNodeInputs(renderer, mode, async () => {});
});

it('retains node input precedence through async override rendering on Dawn', {
  timeout: 120000,
}, async () => {
  const renderer = await getRenderer();
  await verifyNodeOverride(renderer, async () => {});
});

it.each(nodeInputPrimitives)('renders and replays %s node uniforms on Dawn', {
  timeout: 120000,
}, async (kind) => {
  const renderer = await getRenderer();
  await verifyNodeInputPrimitive(renderer, kind, async () => {});
});
