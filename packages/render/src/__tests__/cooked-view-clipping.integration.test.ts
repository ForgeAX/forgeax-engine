import {
  createMaterialProgramArtifactReceipt,
  ShaderRegistry,
  STANDARD_SURFACE_DISCARD_VIEW_CLIPPING,
} from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { resolveMaterialShaderArtifact } from '../assembly/material/assembly';
import {
  manifestVariantShaderEntry,
  resolveMaterialPipelineVariantSet,
  resolveMaterialShaderVariantSet,
} from '../assembly/material-shader-policy';
import {
  applySurfaceDiscardAxis,
  effectiveStandardSurfaceDiscards,
  materialAbiRasterConstants,
} from '../material-stage-constants';

it('selects the cooked clipping entry after the record-to-PSO seam normalizes its all-true key', () => {
  const shaders = new ShaderRegistry({ manifestUrl: undefined });
  const receipt = createMaterialProgramArtifactReceipt({
    schema: [],
    directEntry: 'vs_main',
    vertexInputs: [],
  });
  const input = (clipped: boolean) => ({
    source: `@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0); } @fragment fn fs_main() -> @location(0) vec4f { ${clipped ? 'discard;' : ''} return vec4f(1); }`,
    paramSchema: [],
    receipt,
    entryPoints: [
      {
        name: 'fs_main',
        stage: 'fragment' as const,
        bindings: [],
        effects: {
          mayDiscard: clipped,
          writesDepth: false,
          writesSampleMask: false,
          writesStorage: false,
        },
      },
    ],
  });
  shaders.installMaterialArtifact('game::plain', {
    ...input(false),
    variantReferences: [
      { identifier: 'game::plain', defines: { CLIPPING_PLANES: false } },
      { identifier: 'game::clipped', defines: { CLIPPING_PLANES: true } },
    ],
  });
  shaders.installMaterialArtifact('game::clipped', input(true));
  const ordinary = resolveMaterialShaderArtifact('game::plain', shaders);
  expect(ordinary?.variantSet).toBe('CLIPPING_PLANES=false');
  expect(
    resolveMaterialShaderArtifact('game::plain', shaders, {
      variantSet:
        'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+PROBE_BLEND_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
    })?.program,
  ).toBe(ordinary?.program);
  const manifest = shaders.materialShaderManifestEntry('game::plain');
  if (manifest === undefined) throw Error('Missing cooked family');
  for (const mask of [0, STANDARD_SURFACE_DISCARD_VIEW_CLIPPING, 0]) {
    const effectiveMask = effectiveStandardSurfaceDiscards(ordinary, mask);
    expect(effectiveMask).toBe(mask);
    const request = applySurfaceDiscardAxis(
      undefined,
      materialAbiRasterConstants(undefined, effectiveMask),
    );
    expect(request.constants).toBeUndefined();
    const capabilityRequest = resolveMaterialShaderVariantSet(
      request.variantSet,
      manifest,
      'webgpu',
      true,
    );
    const variantSet = resolveMaterialPipelineVariantSet(
      capabilityRequest,
      manifest,
      'game::plain',
      true,
    );
    expect(variantSet).toBe(mask === 0 ? 'CLIPPING_PLANES=false' : '');
    if (variantSet === undefined) throw Error('Missing variant key');
    const selected = resolveMaterialShaderArtifact('game::plain', shaders, { variantSet });
    expect(selected?.program.entryPoints?.[0]?.effects?.mayDiscard).toBe(mask !== 0);
    const pipeline = manifestVariantShaderEntry(
      shaders,
      'game::plain',
      variantSet,
      shaders.findMaterialArtifact('game::plain').unwrap(),
    );
    expect(pipeline.program).toBe(selected?.program);
    expect(pipeline.receipt).toBeDefined();
  }
});

it('completes a record-stage partial coverage request before native PSO source lookup', () => {
  const shaders = new ShaderRegistry({ manifestUrl: undefined });
  const receipt = createMaterialProgramArtifactReceipt({
    schema: [],
    directEntry: 'vs_main',
    vertexInputs: [],
  });
  for (const mask of [0, 1, 2, 3])
    shaders.installMaterialArtifact(`game::coverage-${mask}`, {
      source: `// coverage-${mask}\n@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0); } @fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`,
      paramSchema: [],
      receipt,
      ...(mask !== 0
        ? {}
        : {
            variantReferences: [0, 1, 2, 3].map((mask) => ({
              identifier: `game::coverage-${mask}`,
              defines: { CLIPPING_PLANES: (mask & 2) !== 0, LOD_DITHER: (mask & 1) !== 0 },
            })),
          }),
    });
  const manifest = shaders.materialShaderManifestEntry('game::coverage-0');
  if (manifest === undefined) throw Error('Missing four-state family');
  for (const mask of [0, 1, 2, 3]) {
    const request = applySurfaceDiscardAxis(
      'STORAGE_BUFFER_AVAILABLE=true',
      materialAbiRasterConstants(undefined, mask),
    );
    const normalized = resolveMaterialShaderVariantSet(
      request.variantSet,
      manifest,
      'webgpu',
      true,
    );
    const key = resolveMaterialPipelineVariantSet(normalized, manifest, 'game::coverage-0', true);
    const pipeline = manifestVariantShaderEntry(
      shaders,
      'game::coverage-0',
      key,
      shaders.findMaterialArtifact('game::coverage-0').unwrap(),
    );
    expect(pipeline.source, `mask ${mask}, key ${key}`).toContain(`coverage-${mask}`);
  }
});
