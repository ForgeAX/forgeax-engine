import { it } from 'vitest';
import { dawnRendererFixture } from './dawn-renderer.fixture';
import {
  referenceModes,
  verifyMaterialReferences,
  verifyReferenceBoundaries,
} from './material-reference-inputs.fixture';

const getRenderer = dawnRendererFixture();
const getBoundaryRenderer = dawnRendererFixture();

it.each(referenceModes)('renders %s direct material references and per-material edits on Dawn', {
  timeout: 120000,
}, async (mode) => {
  const renderer = await getRenderer();
  await verifyMaterialReferences(renderer, mode, async () => {});
});

it('rejects unsupported reference boundaries before publication and recovers on Dawn', {
  timeout: 120000,
}, async () => {
  const renderer = await getBoundaryRenderer();
  await verifyReferenceBoundaries(renderer, async () => {});
});
