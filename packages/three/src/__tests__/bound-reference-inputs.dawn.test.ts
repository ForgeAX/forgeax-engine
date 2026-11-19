import { it } from 'vitest';
import {
  boundModes,
  verifyBoundaries,
  verifyBoundReferences,
} from './bound-reference-inputs.fixture';
import { dawnRendererFixture } from './dawn-renderer.fixture';

const getRenderer = dawnRendererFixture();
const getBoundaryRenderer = dawnRendererFixture();

it.each(boundModes)('renders %s direct material references and per-material edits on Dawn', {
  timeout: 120000,
}, async (mode) => {
  const renderer = await getRenderer();
  await verifyBoundReferences(renderer, mode, async () => {});
});

it('rejects unsupported reference boundaries before publication and recovers on Dawn', {
  timeout: 120000,
}, async () => {
  const renderer = await getBoundaryRenderer();
  await verifyBoundaries(renderer, async () => {});
});
