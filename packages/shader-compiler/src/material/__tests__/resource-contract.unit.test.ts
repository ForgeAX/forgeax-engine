import type { BindGroupLayoutDescriptor, MaterialProgram } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { validateMaterialProgramBindings } from '../resource-contract.js';

const depth: BindGroupLayoutDescriptor[] = [
  {
    entries: [{ binding: 1, visibility: 3, texture: { sampleType: 'depth', viewDimension: '2d' } }],
  },
];

it.each([
  'read-only',
  'before-pass',
] as const)('admits a declared depth version: %s', (sceneDepth) => {
  expect(
    validateMaterialProgramBindings(
      { module: 'game::depth', bindings: 'render-material-and-scene-depth', sceneDepth },
      depth,
    ),
  ).toBeUndefined();
});

it.each([
  { module: 'game::depth' },
  { module: 'game::depth', bindings: 'render-material-and-scene-depth' },
  { module: 'game::depth', bindings: 'render-material', sceneDepth: 'before-pass' },
  { module: 'game::depth', bindings: 'render-material-with-scene-depth', sceneDepth: 'read-only' },
] satisfies MaterialProgram[])('rejects an undeclared or mismatched depth interface: %j', (program) => {
  expect(validateMaterialProgramBindings(program, depth)).toMatchObject({
    code: 'shader-compile-failed',
  });
});

it('does not classify an unrelated shadow texture as the scene-depth input', () => {
  const shadow = [
    {
      entries: [
        {
          binding: 6,
          visibility: 2,
          texture: { sampleType: 'depth' as const, viewDimension: '2d-array' as const },
        },
      ],
    },
  ];
  expect(validateMaterialProgramBindings({ module: 'game::surface' }, shadow)).toBeUndefined();
});

it('rejects a View uniform inside a declared depth-only interface', () => {
  expect(
    validateMaterialProgramBindings(
      { module: 'game::depth', bindings: 'group-0-resource', sceneDepth: 'read-only' },
      [{ entries: [{ binding: 0, visibility: 3, buffer: { type: 'uniform' } }] }],
    ),
  ).toMatchObject({ code: 'shader-compile-failed' });
});
