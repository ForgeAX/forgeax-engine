import type { MaterialRenderState } from '@forgeax/engine-types';
import {
  AlwaysStencilFunc,
  DecrementStencilOp,
  DecrementWrapStencilOp,
  EqualStencilFunc,
  GreaterEqualStencilFunc,
  GreaterStencilFunc,
  IncrementStencilOp,
  IncrementWrapStencilOp,
  InvertStencilOp,
  KeepStencilOp,
  LessEqualStencilFunc,
  LessStencilFunc,
  type Material,
  NeverStencilFunc,
  NotEqualStencilFunc,
  ReplaceStencilOp,
  ZeroStencilOp,
} from 'three/src/Three.Core.js';
import { invalid } from './errors';

const comparisons: Readonly<Record<number, GPUCompareFunction>> = {
  [AlwaysStencilFunc]: 'always',
  [NeverStencilFunc]: 'never',
  [LessStencilFunc]: 'less',
  [LessEqualStencilFunc]: 'less-equal',
  [GreaterStencilFunc]: 'greater',
  [GreaterEqualStencilFunc]: 'greater-equal',
  [EqualStencilFunc]: 'equal',
  [NotEqualStencilFunc]: 'not-equal',
};
const operations: Readonly<Record<number, GPUStencilOperation>> = {
  [KeepStencilOp]: 'keep',
  [ZeroStencilOp]: 'zero',
  [ReplaceStencilOp]: 'replace',
  [IncrementStencilOp]: 'increment-clamp',
  [DecrementStencilOp]: 'decrement-clamp',
  [IncrementWrapStencilOp]: 'increment-wrap',
  [DecrementWrapStencilOp]: 'decrement-wrap',
  [InvertStencilOp]: 'invert',
};

export function projectStencil(material: Material): Partial<MaterialRenderState> {
  if (!material.stencilWrite) return {};
  const compare = comparisons[material.stencilFunc],
    failOp = operations[material.stencilFail],
    depthFailOp = operations[material.stencilZFail],
    passOp = operations[material.stencilZPass];
  if (
    compare === undefined ||
    failOp === undefined ||
    depthFailOp === undefined ||
    passOp === undefined ||
    ![material.stencilRef, material.stencilFuncMask, material.stencilWriteMask].every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff,
    )
  )
    return invalid('Material stencil state', material.uuid).unwrap();
  return {
    stencil: { compare, failOp, depthFailOp, passOp },
    stencilReadMask: material.stencilFuncMask,
    stencilWriteMask: material.stencilWriteMask,
  };
}
