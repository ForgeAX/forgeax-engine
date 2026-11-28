import { expect, it } from 'vitest';
import {
  isPreparedMaterialVertexLayout,
  materialPipelineVertexAttributes,
} from '../webgpu-vertex-layouts';

it('selects the prepared material ABI for a vertex-index producer without inventing mesh attributes', () => {
  // A streamless optical producer binds only View and its material. Treating it
  // as an ordinary mesh adds an unbound mesh group and rejects the GPU submit.
  expect(isPreparedMaterialVertexLayout('none')).toBe(true);
  expect(materialPipelineVertexAttributes(undefined, 'none')).toEqual({});
  expect(isPreparedMaterialVertexLayout(undefined)).toBe(false);
});
