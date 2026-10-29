import { describe, expect, it } from 'vitest';
import {
  createRenderFeatureTarget,
  logicalRenderFeatureTargets,
  resolveStandardRenderFeatureTargets,
} from '../features/targets';

function targets(
  tonemap: 'none' | 'aces-filmic',
  antialias: 'none' | 'fxaa' | 'msaa',
  storageBuffer: boolean,
) {
  return resolveStandardRenderFeatureTargets({
    tonemap,
    antialias,
    colorAttachmentFormat: 'bgra8unorm-srgb',
    storageBuffer,
    multisample: true,
  });
}

describe('urp render feature targets', () => {
  it('uses four immutable Standard definitions across equivalent configuration objects', () => {
    const definitions = new Set<unknown>();
    for (const tonemap of ['none', 'aces-filmic', 'agx', 'future-tonemap']) {
      for (const antialias of ['none', 'fxaa', 'msaa', 'taa', 'smaa', 'future-aa']) {
        for (const storageBuffer of [false, true]) {
          for (const multisample of [false, true]) {
            for (const cloudHistory of [false, true]) {
              for (const colorAttachmentFormat of [
                'bgra8unorm-srgb',
                'rgba8unorm',
                'rgba16float',
              ] as const) {
                const input = {
                  tonemap,
                  antialias,
                  storageBuffer,
                  multisample,
                  cloudHistory,
                  colorAttachmentFormat,
                };
                const targets = resolveStandardRenderFeatureTargets(input);
                expect(resolveStandardRenderFeatureTargets({ ...input })).toBe(targets);
                const logical = logicalRenderFeatureTargets(targets);
                expect(logicalRenderFeatureTargets(targets)).toBe(logical);
                expect(targets).toHaveLength(cloudHistory ? 13 : 7);
                expect(targets[0]?.format).toBe('rgba16float');
                expect(targets[1]?.format).toBe('depth32float-stencil8');
                expect(
                  targets
                    .slice(0, 3)
                    .every(
                      (target) =>
                        target.sampleCount === (antialias === 'msaa' && multisample ? 4 : 1),
                    ),
                ).toBe(true);
                expect(targets.slice(3).every((target) => target.sampleCount === 1)).toBe(true);
                expect(Object.isFrozen(targets)).toBe(true);
                expect(Object.isFrozen(logical)).toBe(true);
                expect(targets.every(Object.isFrozen)).toBe(true);
                expect(logical.every(Object.isFrozen)).toBe(true);
                definitions.add(targets);
              }
            }
          }
        }
      }
    }
    expect(definitions.size).toBe(4);
  });

  it('preserves live array methods and borrowed handle observations around Standard definitions', () => {
    const owned = targets('none', 'none', true);
    const fault = new Error('Borrowed roster read failed');
    const borrowed = new Proxy(owned, {
      get(owner, key, receiver) {
        if (key === 'map') throw fault;
        return Reflect.get(owner, key, receiver);
      },
    });
    expect(() => logicalRenderFeatureTargets(borrowed)).toThrow(fault);
    expect(logicalRenderFeatureTargets([...owned])).toEqual(logicalRenderFeatureTargets(owned));
    expect(logicalRenderFeatureTargets([...owned])).not.toBe(logicalRenderFeatureTargets(owned));
  });

  it('preserves current configuration getter evaluation and unusual format selection', () => {
    let reads = 0;
    const input = {
      get tonemap() {
        return ++reads === 1 ? 'aces-filmic' : 'none';
      },
      antialias: 'none',
      storageBuffer: true,
      multisample: true,
      colorAttachmentFormat: 'bgra8unorm-srgb' as const,
    };
    const publication = resolveStandardRenderFeatureTargets(input);
    expect(reads).toBe(2);
    expect(publication[0]?.format).toBe('bgra8unorm-srgb');
    expect(publication[2]?.format).toBe('bgra8unorm-srgb');
    expect(publication[3]?.format).toBe('bgra8unorm-srgb');
    expect(logicalRenderFeatureTargets(publication)[0]?.format).toBe('bgra8unorm-srgb');
  });

  it('keeps a logical row on its immutable target owner across independent rosters', () => {
    const input = {
      name: 'color',
      kind: 'scene-color' as const,
      format: 'rgba16float' as const,
      sampleCount: 1 as const,
    };
    const target = createRenderFeatureTarget(input);
    const first = logicalRenderFeatureTargets([target])[0];
    input.name = 'replacement';
    expect(logicalRenderFeatureTargets([target])[0]).toBe(first);
    expect(first?.name).toBe('color');
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.keys(target)).toEqual(['name', 'kind', 'format', 'sampleCount']);
    const replacement = createRenderFeatureTarget(input);
    expect(logicalRenderFeatureTargets([replacement])[0]?.name).toBe('replacement');
    expect(logicalRenderFeatureTargets([replacement])[0]).not.toBe(first);
    const equivalent = createRenderFeatureTarget({ ...target });
    expect(logicalRenderFeatureTargets([equivalent])[0]).toEqual(first);
    expect(logicalRenderFeatureTargets([equivalent])[0]).not.toBe(first);
    const copied = { ...target };
    expect(logicalRenderFeatureTargets([copied])[0]).toEqual(first);
    expect(logicalRenderFeatureTargets([copied])[0]).not.toBe(first);
  });

  it('does not forward an owned projection through a borrowed proxy', () => {
    const target = createRenderFeatureTarget({
      name: 'color',
      kind: 'scene-color',
      format: 'rgba16float',
      sampleCount: 1,
    });
    const fault = new Error('Borrowed format read failed');
    const borrowed = new Proxy(target, {
      get(owner, key, receiver) {
        if (key === 'format') throw fault;
        return Reflect.get(owner, key, receiver);
      },
    });
    expect(() => logicalRenderFeatureTargets([borrowed])).toThrow(fault);
  });

  it('projects current attachment facts and preserves detached rosters', () => {
    const input = {
      tonemap: 'none',
      antialias: 'none',
      storageBuffer: true,
      multisample: true,
      colorAttachmentFormat: 'bgra8unorm-srgb' as const,
      cloudHistory: false,
    };
    const first = resolveStandardRenderFeatureTargets(input);
    expect(resolveStandardRenderFeatureTargets({ ...input })).toEqual(first);
    const logical = logicalRenderFeatureTargets(first);
    expect(logicalRenderFeatureTargets(first)).toEqual(logical);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.every(Object.isFrozen)).toBe(true);
    input.antialias = 'msaa';
    const msaa = resolveStandardRenderFeatureTargets(input);
    expect(msaa).not.toBe(first);
    expect(msaa[0]?.sampleCount).toBe(4);
    expect(logicalRenderFeatureTargets(msaa)[0]?.sampleCount).toBe(4);
    expect(logical[0]?.sampleCount).toBe(1);
    expect(first[0]?.sampleCount).toBe(1);
    input.multisample = false;
    const noMsaa = resolveStandardRenderFeatureTargets(input);
    expect(noMsaa[0]?.sampleCount).toBe(1);
    input.cloudHistory = true;
    const cloud = resolveStandardRenderFeatureTargets(input);
    expect(cloud).toHaveLength(first.length + 6);
    expect(first).toHaveLength(7);
    expect(resolveStandardRenderFeatureTargets(input)).toEqual(cloud);
  });

  it('keeps borrowed target getters and in-place edits observable', () => {
    let format: 'rgba16float' | 'bgra8unorm-srgb' = 'rgba16float';
    let reads = 0;
    const borrowed = [
      {
        name: 'color',
        kind: 'scene-color' as const,
        sampleCount: 1 as const,
        get format() {
          reads++;
          return format;
        },
      },
    ] as unknown as Parameters<typeof logicalRenderFeatureTargets>[0];
    const first = logicalRenderFeatureTargets(borrowed);
    format = 'bgra8unorm-srgb';
    const second = logicalRenderFeatureTargets(borrowed);
    expect(reads).toBe(2);
    expect(first[0]?.format).toBe('rgba16float');
    expect(second[0]?.format).toBe('bgra8unorm-srgb');
  });

  it('keeps the storage-buffer no-tonemap no-FXAA path in a linear target', () => {
    expect(targets('none', 'none', true)?.[0]).toMatchObject({
      kind: 'scene-color',
      format: 'rgba16float',
      sampleCount: 1,
    });
  });

  it('publishes a float target for no-tonemap FXAA before the OETF boundary', () => {
    expect(targets('none', 'fxaa', true)?.[0]).toMatchObject({
      kind: 'scene-color',
      format: 'rgba16float',
      sampleCount: 1,
    });
  });

  it('publishes the MSAA linear-LDR target with the graph sample count', () => {
    expect(targets('none', 'msaa', true)?.[0]).toMatchObject({
      kind: 'scene-color',
      format: 'rgba16float',
      sampleCount: 4,
    });
  });

  it('publishes a float target for non-storage-buffer LDR frames', () => {
    expect(targets('none', 'none', false)?.[0]).toMatchObject({
      kind: 'scene-color',
      format: 'rgba16float',
      sampleCount: 1,
    });
  });

  it('keeps a linear target when MSAA is unavailable on a storage-buffer lane', () => {
    expect(
      resolveStandardRenderFeatureTargets({
        tonemap: 'none',
        antialias: 'msaa',
        colorAttachmentFormat: 'bgra8unorm-srgb',
        storageBuffer: true,
        multisample: false,
      })[0],
    ).toMatchObject({
      kind: 'scene-color',
      format: 'rgba16float',
      sampleCount: 1,
    });
  });
});
