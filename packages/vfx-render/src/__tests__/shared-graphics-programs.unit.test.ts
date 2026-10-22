import type { RenderFeatureWork } from '@forgeax/engine-render';
import { describe, expect, it, vi } from 'vitest';
import {
  ownVfxGraphicsProgram,
  shareVfxGraphicsPrograms,
} from '../feature/shared-graphics-programs';

type Program = Extract<RenderFeatureWork['resources'][number], { kind: 'graphics-program' }>;

function fixture(): {
  scope: RenderFeatureWork['scope'];
  resources: RenderFeatureWork['resources'][number][];
  passes: RenderFeatureWork['passes'][number][];
} {
  const program: Program['program'] = {
    shader: 'fixture::particles',
    vertexLayout: 'billboard-material-instance',
    colorFormats: ['rgba16float'],
    depthFormat: 'depth32float',
    sampleCount: 1,
    topology: 'triangle-list',
    renderState: { depthWriteEnabled: false, cullMode: 'none' },
  };
  return {
    scope: { view: 'main' },
    resources: ['one', 'two'].flatMap((name) => [
      { kind: 'graphics-program' as const, name, program: structuredClone(program) },
      { kind: 'graphics-bindings' as const, name: `${name}.bindings`, program: name, values: {} },
    ]),
    passes: ['one', 'two'].map((name) => ({
      kind: 'raster',
      name: `${name}.draw`,
      enabled: name === 'one',
      colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'store' }],
      draws: [
        {
          program: name,
          bindings: [`${name}.bindings`],
          vertexData: [],
          draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
        },
      ],
    })),
  };
}
const programs = (work: RenderFeatureWork) =>
  work.resources.filter((r): r is Program => r.kind === 'graphics-program');

describe('current-scope VFX graphics program declarations', () => {
  it('transfers only private draw and binding records with the same complete program result', () => {
    const borrowed = fixture();
    const owned = structuredClone(borrowed);
    const passes = owned.passes;
    const draw = owned.passes[0]?.kind === 'raster' ? owned.passes[0].draws[0] : undefined;
    const binding = owned.resources.find((entry) => entry.kind === 'graphics-bindings');
    const result = shareVfxGraphicsPrograms(owned, true);
    expect(result).toEqual(shareVfxGraphicsPrograms(borrowed));
    expect(result.passes).toBe(passes);
    expect(result.passes[0]?.kind === 'raster' && result.passes[0].draws[0]).toBe(draw);
    expect(result.resources.find((entry) => entry.kind === 'graphics-bindings')).toBe(binding);
  });

  it('keeps accessor-state rejection before consuming any private records', () => {
    const work = fixture();
    const second = programs(work)[1];
    if (second === undefined) throw new Error('Missing program');
    let reads = 0;
    Object.defineProperty(second.program.renderState, 'depthWriteEnabled', {
      enumerable: true,
      get() {
        reads++;
        return false;
      },
    });
    expect(shareVfxGraphicsPrograms(work, true)).toBe(work);
    expect(reads).toBe(0);
    expect(work.passes[0]?.kind === 'raster' && work.passes[0].draws[0]?.program).toBe('one');
    expect(work.resources.find((entry) => entry.kind === 'graphics-bindings')?.program).toBe('one');
  });

  it('removes duplicate declarations while preserving draw order, gates and bindings', () => {
    const work = fixture();
    const original = structuredClone(work);
    const result = shareVfxGraphicsPrograms(work);
    expect(programs(result)).toHaveLength(1);
    const name = programs(result)[0]?.name;
    expect(result.passes.map((pass) => [pass.name, pass.enabled])).toEqual([
      ['one.draw', true],
      ['two.draw', false],
    ]);
    for (const pass of result.passes) {
      if (pass.kind === 'raster') expect(pass.draws[0]?.program).toBe(name);
    }
    expect(
      result.resources.filter((r) => r.kind === 'graphics-bindings').map((r) => r.program),
    ).toEqual([name, name]);
    expect(work).toEqual(original);
  });

  it('keeps the live program name independent of Player birth, retirement and declaration order', () => {
    const work = fixture();
    const name = programs(shareVfxGraphicsPrograms(work))[0]?.name;
    work.resources.reverse();
    expect(programs(shareVfxGraphicsPrograms(work))[0]?.name).toBe(name);
    work.resources = work.resources.filter((r) => r.name !== 'one' && r.name !== 'one.bindings');
    work.passes = work.passes.filter((pass) => pass.name !== 'one.draw');
    expect(programs(shareVfxGraphicsPrograms(work))[0]?.name).toBe(name);
  });

  it('reads current mutable state afresh on the next frame, without retaining a template', () => {
    const work = fixture();
    const before = programs(shareVfxGraphicsPrograms(work))[0]?.name;
    for (const resource of programs(work)) {
      Object.assign(resource.program, {
        renderState: { depthWriteEnabled: true, cullMode: 'none' },
      });
    }
    const next = programs(shareVfxGraphicsPrograms(work));
    expect(next).toHaveLength(1);
    expect(next[0]?.name).not.toBe(before);
  });

  it('keeps every pipeline ABI field including wait state, lane count, mesh and attachments', () => {
    const differences: Partial<Program['program']>[] = [
      { shader: 'other::shader' },
      { preparePipelines: true },
      { vertexLayout: 'mesh-geometry-material-instance' },
      { particleInputLanes: 2 },
      { colorFormats: ['rgba8unorm'] },
      { depthFormat: 'depth24plus' },
      { sampleCount: 4 },
      { topology: 'line-list' },
      { indexFormat: 'uint32' },
      { renderState: { depthWriteEnabled: true } },
    ];
    for (const difference of differences) {
      const work = fixture();
      const second = programs(work)[1];
      if (second === undefined) throw new Error('Missing fixture program');
      Object.assign(second.program, difference);
      expect(programs(shareVfxGraphicsPrograms(work))).toHaveLength(2);
    }
  });

  it('keeps the entire source path when any state has a getter, without evaluating it', () => {
    const work = fixture();
    let reads = 0;
    const second = programs(work)[1];
    if (second === undefined) throw new Error('Missing fixture program');
    Object.defineProperty(second.program.renderState, 'depthWriteEnabled', {
      enumerable: true,
      get: () => {
        reads++;
        return false;
      },
    });
    expect(shareVfxGraphicsPrograms(work)).toBe(work);
    expect(reads).toBe(0);
  });

  it('does not evaluate nested getters or toJSON functions while deciding eligibility', () => {
    for (const property of ['nested', 'toJSON']) {
      const work = fixture();
      let reads = 0;
      const second = programs(work)[1];
      if (second === undefined) throw new Error('Missing fixture program');
      Object.assign(second.program.renderState ?? {}, {
        [property]:
          property === 'toJSON'
            ? () => {
                reads++;
                return {};
              }
            : {
                get value() {
                  reads++;
                  return 1;
                },
              },
      });
      expect(shareVfxGraphicsPrograms(work)).toBe(work);
      expect(reads).toBe(0);
    }
  });

  it('does not read material values or change any mesh upload bytes', () => {
    const work = fixture();
    let reads = 0;
    const data = new Float32Array([1, 2, 3]);
    work.resources.push(
      { kind: 'buffer', name: 'changing-mesh', size: 12, usage: ['vertex'], data },
      {
        kind: 'graphics-bindings',
        name: 'raw-values',
        program: 'one',
        values: {
          get material() {
            reads++;
            return 42;
          },
        },
      },
    );
    const result = shareVfxGraphicsPrograms(work);
    expect(reads).toBe(0);
    expect(result.resources.find((r) => r.name === 'changing-mesh')).toBe(work.resources[4]);
    expect(data).toEqual(new Float32Array([1, 2, 3]));
  });

  it('shares the pipeline while keeping distinct exact material handles and current values', () => {
    const work = fixture();
    const bindings = work.resources.filter((r) => r.kind === 'graphics-bindings');
    for (const [index, binding] of bindings.entries()) {
      Object.assign(binding.values, {
        material: { world: 0, guid: 'same-guid', assetHandle: 100 + index },
      });
    }
    const result = shareVfxGraphicsPrograms(work);
    expect(programs(result)).toHaveLength(1);
    const prepared = result.resources.filter((r) => r.kind === 'graphics-bindings');
    expect(prepared.map((r) => r.values)).toEqual(bindings.map((r) => r.values));
    expect(prepared[0]?.values).toBe(bindings[0]?.values);
    expect(prepared[1]?.values).toBe(bindings[1]?.values);
  });

  it('keeps shadow draw bindings and unmodified compute/copy commands', () => {
    const work = fixture();
    const raster = work.passes[0];
    if (raster?.kind !== 'raster') throw new Error('Missing raster fixture');
    const copy = { kind: 'copy' as const, name: 'copy', copies: [] };
    work.passes = [copy, { kind: 'shadow-caster', name: 'shadow', draws: raster.draws }];
    const result = shareVfxGraphicsPrograms(work);
    expect(result.passes[0]).toBe(copy);
    expect(result.passes[1]?.kind).toBe('shadow-caster');
    const shadow = result.passes[1];
    if (shadow?.kind === 'shadow-caster') {
      expect(shadow.draws[0]?.program).toBe(programs(result)[0]?.name);
      expect(shadow.draws[0]?.bindings).toBe(raster.draws[0]?.bindings);
    }
  });
});

describe('owned VFX graphics program keys', () => {
  const owned = (renderState: Program['program']['renderState']) =>
    ownVfxGraphicsProgram<Program['program']>({
      shader: 'fixture::particles',
      vertexLayout: 'billboard-material-instance',
      colorFormats: ['rgba16float'],
      depthFormat: 'depth32float',
      sampleCount: 1,
      topology: 'triangle-list',
      ...(renderState === undefined ? {} : { renderState }),
    });
  const frame = (program: Program['program']): RenderFeatureWork => ({
    scope: { view: 'main' },
    resources: ['one', 'two'].flatMap((name) => [
      { kind: 'graphics-program' as const, name, program },
      { kind: 'graphics-bindings' as const, name: `${name}.bindings`, program: name, values: {} },
    ]),
    passes: [],
  });

  it('computes the sharing key of a reused immutable descriptor once', () => {
    const state = Object.freeze({ depthWriteEnabled: false, cullMode: 'none' as const });
    const program = owned(state);
    expect(Object.isFrozen(program)).toBe(true);
    const first = programs(shareVfxGraphicsPrograms(frame(program)));
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      const second = programs(shareVfxGraphicsPrograms(frame(program)));
      expect(stringify).not.toHaveBeenCalled();
      expect(second.map((row) => row.name)).toEqual(first.map((row) => row.name));
      expect(second).toHaveLength(1);
    } finally {
      stringify.mockRestore();
    }
  });

  it('keeps reading a mutable render state referenced by an owned descriptor', () => {
    const state = { depthWriteEnabled: false, cullMode: 'none' as const };
    const program = owned(state);
    const before = programs(shareVfxGraphicsPrograms(frame(program)))[0]?.name;
    state.depthWriteEnabled = true;
    const after = programs(shareVfxGraphicsPrograms(frame(program)))[0]?.name;
    expect(after).not.toBe(before);
  });

  it('keeps distinct descriptors with equal content on one shared program', () => {
    const state = Object.freeze({ depthWriteEnabled: false, cullMode: 'none' as const });
    const work = frame(owned(state));
    const second = work.resources[2];
    if (second?.kind !== 'graphics-program') throw new Error('Missing second program');
    work.resources[2] = { ...second, program: owned(state) };
    expect(programs(shareVfxGraphicsPrograms(work))).toHaveLength(1);
  });
});
