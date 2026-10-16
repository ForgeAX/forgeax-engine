import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveMaterialShaderVariantSet } from '../assembly/material-shader-policy';
import {
  createPbrSkinMeshBindGroupEntries,
  pbrSkinMeshDynamicOffsets,
  SHADOW_CASTER_SHADER_ID,
  shadowCasterVariantSet,
} from '../pbr-pipeline.js';
import { shadowShaderMap } from '../record/shadow-pass.js';

describe('skinned shadow caster', () => {
  it('preserves distinct canonical define text for all 32 capability selections', () => {
    const identities = new Set<string>();
    for (let mask = 0; mask < 32; mask++) {
      const storage = (mask & 1) !== 0;
      const skin = (mask & 2) !== 0;
      const sceneIndex = (mask & 4) !== 0;
      const alpha = (mask & 8) !== 0;
      const color = (mask & 16) !== 0;
      const defines: Record<string, boolean> = {
        ALPHA_MASK: alpha,
        GPU_DRIVEN_SCENE_INDEX_AVAILABLE: sceneIndex,
        GPU_DRIVEN_SCENE_INDEX_EXPLICIT: false,
        SKINNING_DISABLED: !skin,
        STORAGE_BUFFER_AVAILABLE: storage,
      };
      if (color) defines.VERTEX_COLOR_AVAILABLE = true;
      const expected = Object.entries(defines)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, value]) => `${name}=${String(value)}`)
        .join('+');
      const identity = shadowCasterVariantSet(storage, skin, sceneIndex, alpha, color);
      expect(identity).toBe(expected);
      identities.add(identity);
    }
    expect(identities.size).toBe(32);
  });

  it('derives closed capability variants without changing the shader identity', () => {
    expect(shadowCasterVariantSet(true, false)).toBe(
      'ALPHA_MASK=false+GPU_DRIVEN_SCENE_INDEX_AVAILABLE=false+GPU_DRIVEN_SCENE_INDEX_EXPLICIT=false+SKINNING_DISABLED=true+STORAGE_BUFFER_AVAILABLE=true',
    );
    expect(shadowCasterVariantSet(false, true)).toBe(
      'ALPHA_MASK=false+GPU_DRIVEN_SCENE_INDEX_AVAILABLE=false+GPU_DRIVEN_SCENE_INDEX_EXPLICIT=false+SKINNING_DISABLED=false+STORAGE_BUFFER_AVAILABLE=false',
    );
    expect(shadowCasterVariantSet(true, true)).toBe(
      'ALPHA_MASK=false+GPU_DRIVEN_SCENE_INDEX_AVAILABLE=false+GPU_DRIVEN_SCENE_INDEX_EXPLICIT=false+SKINNING_DISABLED=false+STORAGE_BUFFER_AVAILABLE=true',
    );
  });

  it('uses the animated palette in WGSL and binds the same slice in the shadow pass', () => {
    const shader = readFileSync(
      fileURLToPath(new URL('../../../shader/src/shadow_caster.wgsl', import.meta.url)),
      'utf8',
    );
    const record = readFileSync(
      fileURLToPath(new URL('../record/shadow-pass.ts', import.meta.url)),
      'utf8',
    );
    const builder = readFileSync(
      fileURLToPath(new URL('../pipeline-builder.ts', import.meta.url)),
      'utf8',
    );
    expect(shader).toContain('#pragma variant_axis SKINNING_DISABLED');
    expect(shader).toContain('#pragma variant_axis ALPHA_MASK');
    expect(shader).toContain('#pragma variant_axis VERTEX_COLOR_AVAILABLE');
    expect(shader).toContain('#pragma material_slot surface');
    expect(shader).toContain('#import forgeax_material::parameters::{material}');
    expect(shader).toContain('@group(1) @binding(46)');
    expect(shader).toContain('evaluate_standard_surface(input, material)');
    expect(shader).toContain('discard;');
    expect(shader).toContain('@group(2) @binding(1)');
    expect(shader).toContain('let skinMatrix = palette[');
    expect(shader).toContain('let materialIndex = visible.y;');
    expect(shader).toContain('let paletteBase = visible.z;');
    expect(shader).not.toContain('meshes[meshIndex]');
    expect(shader).toContain('@location(13) color : vec4<f32>');
    expect(shader).toContain('out.color = in.color;');
    expect(record).toContain('entry.source.skin.byteOffset');
    expect(record).toContain("'shadow-pbr-skin-mesh'");
    expect(builder).toContain('buffers: [...ctx.vertexBuffers]');
  });

  it('keeps the optional scene-material binding out of the WebGL2 shadow singleton', () => {
    const record = readFileSync(
      fileURLToPath(new URL('../record/shadow-pass.ts', import.meta.url)),
      'utf8',
    );
    const singleton = record.slice(
      record.indexOf('function ensureSpotShadowMaterialBg'),
      record.indexOf('function ensureGpuDrivenAlphaMaskMaterialBg'),
    );
    expect(singleton).toContain('if (runtime.device.caps.storageBuffer)');
    expect(singleton).toContain('binding: 46');
    const sceneMaterialEntry = singleton.slice(singleton.lastIndexOf('binding: 46'));
    expect(singleton).toContain('c.gpuDrivenStandardPbrFrameResources?.sceneMaterialBuffer');
    expect(singleton).toContain('meshSsboBufferBinding(pipelineState.meshStorageBuffer, 0).buffer');
    expect(singleton).not.toContain('pipelineState.meshStorageBuffer.buffer');
    expect(sceneMaterialEntry).not.toContain('pipelineState.materialUniformBuffer.buffer');
    expect(singleton.indexOf('if (runtime.device.caps.storageBuffer)')).toBeLessThan(
      singleton.indexOf('binding: 46'),
    );
  });

  it('keeps mixed static and skinned shadow draws on matching variants and bindings', () => {
    const recordSource = readFileSync(
      fileURLToPath(new URL('../record/shadow-pass.ts', import.meta.url)),
      'utf8',
    );
    const variants = [
      {
        defines: {
          SKINNING_DISABLED: true,
          STORAGE_BUFFER_AVAILABLE: false,
        },
      },
      {
        defines: {
          SKINNING_DISABLED: false,
          STORAGE_BUFFER_AVAILABLE: false,
        },
      },
    ];
    const staticVariant = resolveMaterialShaderVariantSet(
      shadowCasterVariantSet(false, false),
      variants,
      'wgpu-webgl2',
      false,
    );
    const skinnedVariant = resolveMaterialShaderVariantSet(
      shadowCasterVariantSet(false, true),
      variants,
      'wgpu-webgl2',
      false,
    );

    expect(staticVariant).toBe('SKINNING_DISABLED=true+STORAGE_BUFFER_AVAILABLE=false');
    expect(skinnedVariant).toBe('SKINNING_DISABLED=false+STORAGE_BUFFER_AVAILABLE=false');
    expect(recordSource).toContain('entry.mesh.layoutProjection');
    expect(recordSource).toContain("skinned ? 'pbr-skin' : 'pbr'");
    expect(recordSource).toContain('createPbrSkinMeshBindGroupEntries(');
    expect(recordSource).toContain('pbrSkinMeshDynamicOffsets(');

    const meshBuffer = {} as never;
    const paletteBuffer = {} as never;
    const entries = createPbrSkinMeshBindGroupEntries(meshBuffer, 64, paletteBuffer, 128);
    expect(entries.map((entry) => entry.binding)).toEqual([0, 1, 2]);
    expect(entries[1]?.resource).toEqual(entries[2]?.resource);
    expect(pbrSkinMeshDynamicOffsets(256, 512)).toEqual([256, 512, 512]);
  });

  it('keeps low-limit shadow view bindings paired with the optional projector layout', () => {
    const recordSource = readFileSync(
      fileURLToPath(new URL('../record/shadow-pass.ts', import.meta.url)),
      'utf8',
    );

    // A 16-sampled-texture device removes bindings 11/12 from pbr-view-bgl.
    // The shadow-view helper must use the same capability bit as the main
    // view helper or it recreates the browser-only bind-group mismatch.
    expect(recordSource).toContain(
      'const projectorAvailable = pipelineState.projectorAvailable !== false;',
    );
    expect(recordSource).toContain(
      '...(extendedLighting\n          ? extendedLightingCacheKeys\n          : projectorAvailable\n            ? [pipelineState.defaultWhiteTextureView, pipelineState.defaultSampler]',
    );
    expect(recordSource).toContain(
      '...(!extendedLighting && projectorAvailable\n              ? [\n                  {\n                    binding: 11,',
    );
    expect(recordSource).toContain('binding: 12');
  });

  it('keeps shadow view bind groups complete when cloud transport extends the shared layout', () => {
    const recordSource = readFileSync(
      fileURLToPath(new URL('../record/shadow-pass.ts', import.meta.url)),
      'utf8',
    );
    const shadowViewHelper = recordSource.slice(
      recordSource.indexOf('function ensureTypedShadowViewBg'),
      recordSource.indexOf('interface ShadowDispatch'),
    );
    expect(shadowViewHelper).toContain('binding: 16');
    expect(shadowViewHelper).toContain('binding: 17');
    expect(shadowViewHelper).toContain('pipelineState.defaultWhiteTextureView');
    expect(shadowViewHelper).toContain('pipelineState.defaultSampler');
  });

  it('uses the visible scene index for multi-batch capable shadows', () => {
    const shader = readFileSync(
      fileURLToPath(new URL('../../../shader/src/shadow_caster.wgsl', import.meta.url)),
      'utf8',
    );
    const recordSource = readFileSync(
      fileURLToPath(new URL('../record/shadow-pass.ts', import.meta.url)),
      'utf8',
    );
    expect(shadowCasterVariantSet(true, false, true)).toBe(
      'ALPHA_MASK=false+GPU_DRIVEN_SCENE_INDEX_AVAILABLE=true+GPU_DRIVEN_SCENE_INDEX_EXPLICIT=false+SKINNING_DISABLED=true+STORAGE_BUFFER_AVAILABLE=true',
    );
    expect(shadowCasterVariantSet(true, false, true, false, true)).toContain(
      'VERTEX_COLOR_AVAILABLE=true',
    );
    expect(shader).toContain('@group(3) @binding(2) var<storage, read> visibleItems');
    expect(shader).toContain('#pragma variant_axis GPU_DRIVEN_SCENE_INDEX_EXPLICIT');
    expect(shader).toContain('let sceneDraw = sceneIndexDraw(visible.x);');
    expect(shader).not.toContain('meshes[meshIndex]');
    expect(recordSource).toContain('gpuDrivenShadowBatchProjections?.get');
    expect(recordSource).toContain('for (const batch of viewSubmission.plan.batches)');
    const capableRecord = recordSource.slice(
      recordSource.indexOf('function recordGpuDrivenShadowIfPublished'),
      recordSource.indexOf('export function encodeDirectionalShadowPass'),
    );
    expect(capableRecord).not.toContain('validatedOrdered');
    expect(recordSource).toContain(
      'const offset = raster.indirectOffset + level * GPU_DRIVEN_INDIRECT_COMMAND_BYTES;',
    );
    expect(recordSource).toContain('pass.drawIndexedIndirect(indirect, offset)');
    expect(recordSource).toContain("batch.key.admission === 'alpha-mask'");
    expect(recordSource).toContain('ensureGpuDrivenAlphaMaskMaterialBg');
    const shadowBootVariants = [
      {
        defines: {
          ALPHA_MASK: false,
          GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
          GPU_DRIVEN_SCENE_INDEX_EXPLICIT: false,
          SKINNING_DISABLED: true,
          STORAGE_BUFFER_AVAILABLE: false,
        },
      },
      {
        defines: {
          ALPHA_MASK: true,
          GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
          GPU_DRIVEN_SCENE_INDEX_EXPLICIT: false,
          SKINNING_DISABLED: true,
          STORAGE_BUFFER_AVAILABLE: false,
        },
      },
    ];
    expect(
      resolveMaterialShaderVariantSet(undefined, shadowBootVariants, 'wgpu-webgl2', false, 0),
    ).toBe(
      'ALPHA_MASK=false+GPU_DRIVEN_SCENE_INDEX_AVAILABLE=false+GPU_DRIVEN_SCENE_INDEX_EXPLICIT=false+SKINNING_DISABLED=true+STORAGE_BUFFER_AVAILABLE=false',
    );
  });

  it('keeps the dispatch material handle, snapshot, and frame slot together', () => {
    const paramSnapshot = { alphaClipThreshold: 0.4 };
    const context = {
      dispatch: [
        {
          renderableIndex: 4,
          materialHandle: 42,
          materialShaderId: 'forgeax::default-standard-pbr',
          paramSnapshot,
          tags: { LightMode: 'ShadowCaster' },
        },
      ],
      validatedOrdered: [{ renderableIndex: 4 }],
      materialSlotIndices: [[3, 7]],
      materialSlots: Array.from({ length: 8 }, (_, slot) => ({
        materialHandle: slot === 7 ? 42 : 11,
      })),
    } as never;
    const bindings = shadowShaderMap(context);
    expect(bindings.get(4)?.get(42)?.[0]).toMatchObject({
      materialHandle: 42,
      materialShaderId: SHADOW_CASTER_SHADER_ID,
      materialSlot: 7,
      paramSnapshot,
    });
  });

  it('keeps each submesh material associated with its selected shadow program and entries', () => {
    const context = {
      dispatch: [
        {
          renderableIndex: 4,
          materialHandle: 42,
          materialShaderId: 'forgeax::default-standard-pbr',
          tags: { LightMode: 'ShadowCaster' },
        },
        {
          renderableIndex: 4,
          materialHandle: 43,
          materialShaderId: 'custom::cutout',
          vertexEntry: 'vs_displaced',
          fragmentEntry: 'fs_cutout',
          tags: { LightMode: 'ShadowCaster' },
        },
      ],
    } as never;
    const bindings = shadowShaderMap(context);
    expect(bindings.get(4)?.get(42)?.[0]?.materialShaderId).toBe(SHADOW_CASTER_SHADER_ID);
    expect(bindings.get(4)?.get(43)?.[0]).toMatchObject({
      materialShaderId: 'custom::cutout',
      vertexEntry: 'vs_displaced',
      fragmentEntry: 'fs_cutout',
    });
  });
});
