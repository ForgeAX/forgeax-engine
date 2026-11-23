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
const core = process.env.FORGEAX_CI_CORE_VALIDATION === '1';
// Browser compares and replays all inputs against r187. Keep scalar, texture,
// override and two different primitive pipelines on the real Dawn carrier.
const materialInputs = core
  ? (['uniform', 'texture'] as const)
  : (['uniform', 'vec4', 'texture'] as const);
const primitiveInputs = core ? (['dashed', 'sprite'] as const) : nodeInputPrimitives;

it.each(materialInputs)('renders and replays live %s node inputs on Dawn', {
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

it.each(primitiveInputs)('renders and replays %s node uniforms on Dawn', {
  timeout: 120000,
}, async (kind) => {
  const renderer = await getRenderer();
  await verifyNodeInputPrimitive(renderer, kind, async () => {});
});
