import * as naga from '@forgeax/engine-naga';
import { createParticleEffectInstance, createVfxEffectContract } from '@forgeax/engine-vfx';
import { describe, expect, it, vi } from 'vitest';
import {
  cookParticleCodeEffect,
  cookParticleCodeProgram,
  createParticleCodeNativeCooker,
} from '../code-program.js';

const source = {
  schemaVersion: 3,
  emitters: [
    {
      id: 'custom-billboard',
      capacity: 8,
      backend: { required: 'gpu' as const },
      space: 'world' as const,
      bounds: { kind: 'sphere' as const, center: [0, 0, 0], radius: 4 },
      schedule: { rate: 1 },
      program: { module: 'custom.vfx.wgsl' },
      renderers: [
        {
          kind: 'billboard' as const,
          material: 'material',
          sorting: 'view-depth' as const,
          attributes: {
            sort: { source: 'custom' as const, name: 'sortKey' },
          },
          materialInputs: ['heat'],
        },
      ],
    },
  ],
};

const module = {
  entry: `
#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
struct VfxParameters { intensity: f32, }
struct VfxCustom { sortKey: f32, heat: f32, }
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>, custom: ptr<function, VfxCustom>) {
  (*custom).sortKey = f32(ctx.particleId);
  (*custom).heat = 0.5;
  (*particle).position = vec3<f32>(0.0);
  (*particle).velocity = vec3<f32>(0.0, 1.0, 0.0);
  (*particle).lifetime = 2.0;
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>, custom: ptr<function, VfxCustom>) {
  (*custom).sortKey += ctx.delta;
  (*particle).position += (*particle).velocity * ctx.delta;
}
`,
};

const sourceEmitter = source.emitters[0];
if (sourceEmitter === undefined) throw new Error('Missing source emitter fixture');
const sourceRenderer = sourceEmitter.renderers[0];
if (sourceRenderer === undefined) throw new Error('Missing source renderer fixture');

describe('Program v3 compiler', () => {
  it('validates two emitters and reuses real composition across cooks', async () => {
    const compile = vi.spyOn(naga, 'composeShader');
    try {
      const cooked = await cookParticleCodeProgram(
        { ...source, emitters: [sourceEmitter, { ...sourceEmitter, id: 'second', capacity: 16 }] },
        { 'custom.vfx.wgsl': module },
        { material: [{ name: 'heat', type: 'f32', visibility: 'fragment', lane: 0 }] },
      );
      if (!cooked.ok) throw cooked.error;
      expect(
        cooked.value.program.emitters.map((emitter) => [emitter.id, emitter.capacity]),
      ).toEqual([
        ['custom-billboard', 8],
        ['second', 16],
      ]);
      expect(compile).toHaveBeenCalledTimes(1);
      const distinct = await cookParticleCodeProgram(
        {
          ...source,
          emitters: [
            sourceEmitter,
            { ...sourceEmitter, id: 'second', capacity: 16, program: { module: 'other.vfx.wgsl' } },
          ],
        },
        {
          'custom.vfx.wgsl': module,
          'other.vfx.wgsl': {
            entry: module.entry.replace('(*custom).heat = 0.5;', '(*custom).heat = 0.25;'),
          },
        },
        { material: [{ name: 'heat', type: 'f32', visibility: 'fragment', lane: 0 }] },
      );
      if (!distinct.ok) throw distinct.error;
      expect(compile).toHaveBeenCalledTimes(2);
      expect(distinct.value.program.emitters[0]?.wgsl).toBe(cooked.value.program.emitters[0]?.wgsl);
      expect(distinct.value.program.emitters[1]?.wgsl).not.toBe(
        cooked.value.program.emitters[0]?.wgsl,
      );
    } finally {
      compile.mockRestore();
    }
  });
  it('preserves authored defaults through ordinary cook and instance creation while ignoring commented declarations', async () => {
    const entry = module.entry.replace(
      'struct VfxParameters { intensity: f32, }',
      `// forgeax-vfx-default intensity = 0.5
// forgeax-vfx-default position = vec3<f32>(-1.5, 1.5, 0.0)
/*
struct VfxParameters { fake: f32, }
#import forgeax_vfx::data::scene_depth
*/
struct VfxParameters { intensity: f32, position: vec3<f32>, }`,
    );
    const cooked = await cookParticleCodeEffect(
      source,
      { 'custom.vfx.wgsl': { entry } },
      { material: [{ name: 'heat', type: 'f32', visibility: 'fragment', lane: 0 }] },
    );
    if (!cooked.ok) throw cooked.error;
    const emitter = cooked.value.artifact.program.emitters[0];
    if (emitter === undefined) throw new Error('Missing cooked emitter');
    const instance = createParticleEffectInstance(
      createVfxEffectContract(emitter.reflection.layout),
    );
    expect(instance.values).toMatchObject({ intensity: 0.5, position: [-1.5, 1.5, 0] });
    expect(emitter.reflection.dataInterfaces).toEqual([]);
    expect(emitter.reflection.layout.parameters.fields.map((field) => field.name)).toEqual([
      'intensity',
      'position',
    ]);
  });
  it('preserves material reflection and artifact identity through payload and native cook adapters', async () => {
    const modules = { 'custom.vfx.wgsl': module };
    const materials = {
      material: [{ name: 'heat', type: 'f32', visibility: 'fragment', lane: 0 }],
    } as const;
    const program = await cookParticleCodeProgram(source, modules, materials);
    const effect = await cookParticleCodeEffect(source, modules, materials);
    if (!program.ok) throw program.error;
    if (!effect.ok) throw effect.error;
    const native = await createParticleCodeNativeCooker(modules, materials).cook({
      guid: 'effect',
      source,
    });
    expect(effect.value.artifact.bytes).toEqual(program.value.bytes);
    expect(native.artifacts[program.value.artifactKey]?.bytes).toEqual(program.value.bytes);
    expect(native.inputFingerprint).toBe(program.value.fingerprint);
    expect(native.payload).toEqual(effect.value.asset);
    expect(native.refs).toEqual(['material']);
    expect(
      program.value.program.emitters[0]?.reflection.renderers[0]?.materialInputDefinitions,
    ).toEqual(materials.material);
  });

  it('derives Core, Parameters, Custom and typed renderer resources from one cook', async () => {
    const cooked = await cookParticleCodeProgram(
      source,
      { 'custom.vfx.wgsl': module },
      { material: [{ name: 'heat', type: 'f32', visibility: 'fragment', lane: 0 }] },
    );
    expect(cooked.ok).toBe(true);
    if (!cooked.ok) return;
    const emitter = cooked.value.program.emitters[0];
    expect(emitter?.reflection.layout).toMatchObject({
      version: 3,
      core: { stride: 112 },
      customLayout: { stride: 8, lanes: 1 },
    });
    expect(emitter?.reflection.bindings[0]?.entries.map((entry) => entry.binding)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 10, 11,
    ]);
    expect(emitter?.reflection.resources).toEqual(expect.arrayContaining(['parameters', 'custom']));
    expect(emitter?.reflection.resources).not.toContain('channel');
    expect(emitter?.reflection.renderers[0]).toMatchObject({
      attributes: { sort: { source: 'custom', name: 'sortKey' } },
      materialInputs: ['heat'],
      materialInputDefinitions: [{ name: 'heat', lane: 0 }],
    });
  });

  it('uses vec4 byte stride for every material-input projection topology', async () => {
    const cooked = await cookParticleCodeProgram(
      source,
      { 'custom.vfx.wgsl': module },
      { material: [{ name: 'heat', type: 'f32', visibility: 'fragment', lane: 0 }] },
    );
    expect(cooked.ok).toBe(true);
    if (!cooked.ok) return;
    const wgsl = cooked.value.program.emitters[0]?.wgsl ?? '';
    const billboardStride = /31u \+ \(materialLanes(?:_\d+)? \* 4u\)/gu;
    const meshStride = /18u \+ \(materialLanes(?:_\d+)? \* 4u\)/gu;
    const topologyStride = /12u \+ \(materialLanes(?:_\d+)? \* 4u\)/gu;
    expect(wgsl.match(billboardStride)).toHaveLength(2);
    expect(wgsl.match(meshStride)).toHaveLength(2);
    expect(wgsl.match(topologyStride)).toHaveLength(3);
    expect(wgsl).not.toMatch(/(?:31u|18u|12u) \+ \(materialLanes(?:_\d+)?\)/u);
  });

  it('rejects a custom semantic that points to an unknown field', async () => {
    const invalid = structuredClone(source);
    const renderer = invalid.emitters[0]?.renderers[0];
    if (renderer === undefined) throw new Error('Missing renderer fixture');
    renderer.attributes = {
      sort: { source: 'custom', name: 'missing' },
    };
    const cooked = await cookParticleCodeProgram(
      invalid,
      {
        'custom.vfx.wgsl': module,
      },
      { material: [{ name: 'heat', type: 'f32', visibility: 'fragment', lane: 0 }] },
    );
    expect(cooked.ok).toBe(false);
    if (!cooked.ok) expect(cooked.error.code).toBe('vfx-renderer-invalid');
  });

  it('rejects missing and incompatible material particle inputs before code generation', async () => {
    const missing = structuredClone(source);
    const missingRenderer = missing.emitters[0]?.renderers[0];
    if (missingRenderer === undefined) throw new Error('Missing renderer fixture');
    missingRenderer.materialInputs = ['missing'];
    const missingResult = await cookParticleCodeProgram(
      missing,
      { 'custom.vfx.wgsl': module },
      { material: [{ name: 'heat', type: 'f32', visibility: 'fragment', lane: 0 }] },
    );
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) {
      expect(missingResult.error.code).toBe('vfx-renderer-invalid');
      expect(missingResult.error.detail).toMatchObject({
        path: 'renderers[0].materialInputs[0]',
      });
    }

    const incompatibleResult = await cookParticleCodeProgram(
      source,
      { 'custom.vfx.wgsl': module },
      { material: [{ name: 'heat', type: 'vec3<f32>', visibility: 'fragment', lane: 0 }] },
    );
    expect(incompatibleResult.ok).toBe(false);
    if (!incompatibleResult.ok) expect(incompatibleResult.error.code).toBe('vfx-renderer-invalid');
  });

  it('merges default mappings and emits topology-aware custom attribute accessors', async () => {
    const mappedSource = {
      ...source,
      emitters: [
        {
          ...sourceEmitter,
          renderers: [
            {
              ...sourceRenderer,
              attributes: {
                position: { source: 'custom' as const, name: 'emitPosition' },
                size: { source: 'custom' as const, name: 'emitSize' },
                subImage: { source: 'custom' as const, name: 'frameIndex' },
                visibility: { source: 'custom' as const, name: 'visibleFlag' },
              },
            },
          ],
        },
      ],
    };
    const mappedModule = {
      entry: module.entry.replace(
        'struct VfxCustom { sortKey: f32, heat: f32, }',
        'struct VfxCustom { sortKey: f32, heat: f32, emitPosition: vec3<f32>, emitSize: vec2<f32>, frameIndex: f32, visibleFlag: f32, }',
      ),
    };
    const cooked = await cookParticleCodeProgram(
      mappedSource,
      { 'custom.vfx.wgsl': mappedModule },
      { material: [{ name: 'heat', type: 'f32', visibility: 'fragment', lane: 0 }] },
    );
    expect(cooked.ok).toBe(true);
    if (!cooked.ok) return;
    const renderer = cooked.value.program.emitters[0]?.reflection.renderers[0];
    expect(renderer?.attributes).toMatchObject({
      position: { source: 'custom', name: 'emitPosition' },
      size: { source: 'custom', name: 'emitSize' },
      subImage: { source: 'custom', name: 'frameIndex' },
      visibility: { source: 'custom', name: 'visibleFlag' },
      color: { source: 'core', name: 'color' },
    });
    expect(cooked.value.program.emitters[0]?.wgsl).toMatch(
      /forgeax_vfx_custom\[index(?:_\d+)?\]\.emitPosition/,
    );
    expect(cooked.value.program.emitters[0]?.wgsl).toContain('forgeax_vfx_renderer_position');
    expect(cooked.value.program.emitters[0]?.wgsl).toContain('forgeax_vfx_renderer_subImage');
    expect(cooked.value.program.emitters[0]?.wgsl).toContain('forgeax_vfx_zero_billboard_instance');
  });

  it('cooks and dispatches a reflected VfxCustom sort key', async () => {
    const customSort = {
      ...source,
      emitters: [
        {
          ...sourceEmitter,
          renderers: [{ ...sourceRenderer, sorting: 'custom-ascending' as const }],
        },
      ],
    };
    const cooked = await cookParticleCodeProgram(
      customSort,
      { 'custom.vfx.wgsl': module },
      { material: [{ name: 'heat', type: 'f32', visibility: 'fragment', lane: 0 }] },
    );
    expect(cooked.ok).toBe(true);
    if (!cooked.ok) return;
    expect(cooked.value.program.emitters[0]?.reflection.renderers[0]).toMatchObject({
      sorting: 'custom-ascending',
      attributes: { sort: { source: 'custom', name: 'sortKey' } },
    });
    expect(cooked.value.program.emitters[0]?.wgsl).toMatch(/forgeax_vfx_custom\[[^\]]+\]\.sortKey/);
  });

  it('allocates only the declared camera, single-sample depth and noise bindings', async () => {
    const diSource = {
      ...source,
      emitters: [
        {
          ...sourceEmitter,
          id: 'di-billboard',
          program: { module: 'di.vfx.wgsl' },
        },
      ],
    };
    const cooked = await cookParticleCodeProgram(
      diSource,
      {
        'di.vfx.wgsl': {
          entry: `
#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
#import forgeax_vfx::data::camera
#import forgeax_vfx::data::scene_depth
#import forgeax_vfx::data::noise
struct VfxCustom { sortKey: f32, heat: f32, }
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>, custom: ptr<function, VfxCustom>) {
  (*particle).position = vec3<f32>(0.0);
  (*particle).lifetime = 1.0;
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>, custom: ptr<function, VfxCustom>) {}
`,
        },
      },
      { material: [{ name: 'heat', type: 'f32', visibility: 'fragment', lane: 0 }] },
    );
    expect(cooked.ok).toBe(true);
    if (!cooked.ok) return;
    const emitter = cooked.value.program.emitters[0];
    if (emitter === undefined) throw new Error('Missing cooked emitter');
    expect(emitter.reflection.dataInterfaces).toMatchObject([
      { kind: 'camera', binding: 12 },
      { kind: 'scene-depth', binding: 13, sampleCount: 1 },
      { kind: 'noise', binding: 14 },
    ]);
    expect(emitter.reflection.bindings[0]?.entries.map((entry) => entry.binding)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 11, 12, 13, 14,
    ]);
    expect(emitter.reflection.resources).toEqual(
      expect.arrayContaining(['camera', 'scene-depth', 'noise']),
    );
  });
});
