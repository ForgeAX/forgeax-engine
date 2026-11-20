import { describe, expect, it, vi } from 'vitest';
import {
  createFullscreenRenderFeature,
  fullscreenRenderFeatureDeclaration,
} from '../features/fullscreen';
import {
  cloneRenderFeaturePlanSignatureSnapshot,
  type RenderFeatureFullscreenProgramDeclaration,
  renderFeaturePlanSignature,
  renderFeaturePlanSignatureSnapshotEquals,
  validateRenderFeaturePlan,
} from '../features/plan';
import {
  type PostProcessShaderEntry,
  postProcessShaderEntrySignature,
  postProcessShaderModuleLabel,
  postProcessShaderPipelineLabel,
} from '../fullscreen-post-process-pass';

describe('fullscreen RenderFeature plan', () => {
  it('validates frame uniforms without including them in graph or shader identity', () => {
    const source = 'fn fs_main() -> vec4f { return vec4f(1); }';
    const defaults = new Uint8Array(16);
    const program = {
      kind: 'fullscreen-program',
      chain: true,
      name: 'test-ray',
      source,
      params: { byteSize: 16, defaultValue: defaults },
    } as const;
    const plan = (program: RenderFeatureFullscreenProgramDeclaration) => ({
      resources: [program],
      passes: [],
    });
    const first = { ...program, frameParams: new Uint8Array(16).fill(1) };
    const second = { ...program, frameParams: new Uint8Array(16).fill(2) };
    const snapshot = cloneRenderFeaturePlanSignatureSnapshot(plan(first));
    expect(validateRenderFeaturePlan('rays', plan(first), []).ok).toBe(true);
    expect(validateRenderFeaturePlan('rays', plan(second), []).ok).toBe(true);
    expect(
      validateRenderFeaturePlan('rays', plan({ ...second, frameParams: new Uint8Array(4) }), []).ok,
    ).toBe(false);
    expect(
      validateRenderFeaturePlan(
        'rays',
        plan({
          ...second,
          chain: undefined,
        } as unknown as RenderFeatureFullscreenProgramDeclaration),
        [],
      ).ok,
    ).toBe(false);
    expect(renderFeaturePlanSignatureSnapshotEquals(plan(second), snapshot)).toBe(true);
    expect(renderFeaturePlanSignatureSnapshotEquals(plan(program), snapshot)).toBe(true);
    expect(renderFeaturePlanSignature(plan(first))).toBe(renderFeaturePlanSignature(plan(second)));
    expect(postProcessShaderEntrySignature(first)).toBe(postProcessShaderEntrySignature(second));
    const changedDefaults = {
      ...second,
      params: { byteSize: 16, defaultValue: second.frameParams },
    };
    expect(renderFeaturePlanSignatureSnapshotEquals(plan(changedDefaults), snapshot)).toBe(false);
  });
  it('preserves a scene effect stage through the frozen Worker declaration and plan', () => {
    const feature = createFullscreenRenderFeature({
      identity: 'test::temporal-depth',
      source: 'shader',
      stage: 'before-temporal',
      reads: ['sceneColor', { key: 'depth', sampleType: 'depth' }],
    });
    expect(fullscreenRenderFeatureDeclaration(feature)?.stage).toBe('before-temporal');
    const plan = feature
      .plan(undefined, { caps: {} as never, frame: { frameNumber: 1 }, generation: 1, views: [] })
      .unwrap();
    expect(plan.work[0]?.resources[0]).toMatchObject({ stage: 'before-temporal' });
    expect(
      postProcessShaderEntrySignature({ source: 'shader', stage: 'before-temporal' }),
    ).not.toBe(postProcessShaderEntrySignature({ source: 'shader' }));
  });
  it('keeps hot graph and pipeline signatures independent of WGSL size', () => {
    const source = `${'// shader padding\n'.repeat(10_000)}fn fs_main() {}`;
    const entry = { source };
    const signature = postProcessShaderEntrySignature(entry);
    expect(signature.length).toBeLessThan(256);
    const scan = vi.spyOn(String.prototype, 'charCodeAt');
    const serialize = vi.spyOn(JSON, 'stringify');
    try {
      for (let frame = 0; frame < 300; frame += 1) {
        expect(postProcessShaderEntrySignature(entry)).toBe(signature);
      }
      expect(scan).not.toHaveBeenCalled();
      // Unchanged declarations reuse the derived string itself.
      expect(serialize).not.toHaveBeenCalled();
    } finally {
      scan.mockRestore();
      serialize.mockRestore();
    }
  });

  it('shares the admitted source digest with module and pipeline labels', () => {
    const entry = { source: `${'// padding\n'.repeat(10_000)}fn fs_main() {}` };
    const signature = postProcessShaderEntrySignature(entry);
    const moduleLabel = postProcessShaderModuleLabel(entry.source);
    const pipelineLabel = postProcessShaderPipelineLabel('test::digest', entry.source);
    const scan = vi.spyOn(String.prototype, 'charCodeAt');
    try {
      for (let frame = 0; frame < 300; frame++) {
        expect(postProcessShaderModuleLabel(entry)).toBe(moduleLabel);
        expect(postProcessShaderPipelineLabel('test::digest', entry)).toBe(pipelineLabel);
        expect(postProcessShaderEntrySignature(entry)).toBe(signature);
      }
      expect(scan).not.toHaveBeenCalled();
    } finally {
      scan.mockRestore();
    }
  });

  it('updates labels on same-length source replacement and ignores non-source changes', () => {
    const entry = {
      source: 'fn fs_main() { let value = 1; }',
      params: { byteSize: 16, defaultValue: new Uint8Array(16) },
      reads: ['scene-color'],
    };
    const before = postProcessShaderModuleLabel(entry);
    entry.source = 'fn fs_main() { let value = 2; }';
    const after = postProcessShaderModuleLabel(entry);
    expect(after).not.toBe(before);
    expect(after).toBe(postProcessShaderModuleLabel(entry.source));
    expect(postProcessShaderModuleLabel({ source: entry.source })).toBe(after);
    const signature = postProcessShaderEntrySignature(entry);
    entry.params.defaultValue[0] = 1;
    entry.reads[0] = 'other-color';
    const scan = vi.spyOn(String.prototype, 'charCodeAt');
    try {
      expect(postProcessShaderModuleLabel(entry)).toBe(after);
      expect(postProcessShaderEntrySignature(entry)).not.toBe(signature);
      expect(postProcessShaderModuleLabel(entry)).toBe(after);
      expect(scan).not.toHaveBeenCalled();
    } finally {
      scan.mockRestore();
    }
  });

  it('invalidates source and nested declaration changes without relying on object identity', () => {
    const entry = {
      source: 'fn fs_main() { let value = 1; }',
      params: { byteSize: 16, defaultValue: new Uint8Array(16) },
      reads: [{ key: 'scene-color' }],
      storageBindings: [3],
      usesView: false,
    };
    let previous = postProcessShaderEntrySignature(entry);
    const checkChanged = () => {
      const next = postProcessShaderEntrySignature(entry);
      expect(next).not.toBe(previous);
      previous = next;
    };
    entry.source = 'fn fs_main() { let value = 2; }';
    checkChanged();
    entry.params.defaultValue[0] = 1;
    checkChanged();
    const read = entry.reads[0];
    if (read === undefined) throw new Error('missing test read');
    read.key = 'other-color';
    checkChanged();
    entry.storageBindings[0] = 4;
    checkChanged();
    entry.usesView = true;
    checkChanged();
    expect(postProcessShaderEntrySignature({ ...entry })).toBe(previous);
  });

  it('invalidates a fullscreen declaration when its hardware depth output changes in place', () => {
    const entry: { source: string; depthOutput?: PostProcessShaderEntry['depthOutput'] } = {
      source: 'shader',
    };
    const colorOnly = postProcessShaderEntrySignature(entry);
    entry.depthOutput = 'depth32float-stencil8';
    const depth = postProcessShaderEntrySignature(entry);
    expect(depth).not.toBe(colorOnly);
    expect(postProcessShaderEntrySignature({ ...entry })).toBe(depth);
    entry.depthOutput = 'depth32float';
    expect(postProcessShaderEntrySignature(entry)).not.toBe(depth);
    delete entry.depthOutput;
    expect(postProcessShaderEntrySignature(entry)).toBe(colorOnly);
  });

  it('keeps the cooked effect on the Standard post-stage owner', () => {
    const feature = createFullscreenRenderFeature({
      identity: 'test::fullscreen',
      source: '@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }',
      params: { byteSize: 4, defaultValue: new Uint8Array([1, 0, 0, 0]) },
    });
    const planned = feature.plan(undefined, {
      caps: {} as never,
      frame: { frameNumber: 1 },
      generation: 1,
      views: [],
    });

    expect(feature.requiredFullscreenPostProcesses).toEqual([
      {
        identity: 'test::fullscreen',
        source: '@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }',
      },
    ]);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const plannedWork = planned.value.work[0];
    if (plannedWork === undefined) throw new Error('planned work missing');
    expect(
      validateRenderFeaturePlan(feature.identity, plannedWork, [
        { name: 'scene-color', kind: 'color', format: 'rgba16float', sampleCount: 1 },
      ]).ok,
    ).toBe(true);
    const program = plannedWork.resources[0];
    expect(program).toMatchObject({
      kind: 'fullscreen-program',
      source: '@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }',
    });
    if (program?.kind !== 'fullscreen-program') throw new Error('fullscreen program missing');
    const prewarm = feature.requiredFullscreenPostProcesses?.[0];
    if (prewarm === undefined) throw new Error('fullscreen prewarm missing');
    expect(program.name).not.toBe(prewarm.identity);
    expect(postProcessShaderModuleLabel(program.source)).toBe(
      postProcessShaderModuleLabel(prewarm.source),
    );
    expect(postProcessShaderPipelineLabel(program.name, program.source)).not.toBe(
      postProcessShaderPipelineLabel(prewarm.identity, prewarm.source),
    );
    expect(plannedWork.passes).toEqual([]);
  });

  it('treats source, params, and reads as one cached declaration identity', () => {
    const base = {
      source: 'fn fs_main() -> vec4f { return vec4f(1); }',
      params: { byteSize: 16, defaultValue: new Uint8Array(16) },
      reads: ['scene-color'],
    } as const;
    expect(postProcessShaderEntrySignature(base)).not.toBe(
      postProcessShaderEntrySignature({ ...base, source: `${base.source}\n// next` }),
    );
    expect(postProcessShaderEntrySignature(base)).not.toBe(
      postProcessShaderEntrySignature({
        ...base,
        params: { byteSize: 16, defaultValue: new Uint8Array([1, ...new Uint8Array(15)]) },
      }),
    );
    expect(postProcessShaderEntrySignature(base)).not.toBe(
      postProcessShaderEntrySignature({ ...base, reads: ['other-color'] }),
    );
    expect(postProcessShaderEntrySignature(base)).not.toBe(
      postProcessShaderEntrySignature({ ...base, fragmentEntryPoint: 'fs_tone_only' }),
    );
    expect(postProcessShaderModuleLabel(base.source)).not.toBe(
      postProcessShaderModuleLabel(`${base.source}\n// next`),
    );
    expect(postProcessShaderPipelineLabel('test::fullscreen', base.source)).not.toBe(
      postProcessShaderPipelineLabel('test::fullscreen', `${base.source}\n// next`),
    );
  });
});

it('extracts source enable state while exposing only the detached fullscreen declaration', () => {
  let enabled = false;
  const defaults = new Uint8Array([1, 2, 3, 4]);
  const feature = createFullscreenRenderFeature({
    identity: 'game::worker-overlay',
    source: 'fn fs_main() {}',
    reads: ['sceneColor', { key: 'sceneDepth', sampleType: 'depth' }],
    params: { byteSize: 4, defaultValue: defaults },
    enabled: () => enabled,
  });
  defaults[0] = 9;
  const declaration = fullscreenRenderFeatureDeclaration(feature);
  expect(declaration?.params?.defaultValue[0]).toBe(1);
  expect(structuredClone(declaration)).toEqual(declaration);
  expect(declaration).not.toHaveProperty('enabled');
  expect(fullscreenRenderFeatureDeclaration({ ...feature })).toBeUndefined();
  if (declaration === undefined) throw new Error('Missing fullscreen declaration');
  const consumer = createFullscreenRenderFeature(structuredClone(declaration));
  for (const next of [false, true, false, true]) {
    enabled = next;
    const data = feature.extract({} as never).unwrap();
    const source = feature.plan(data, {} as never).unwrap();
    const received = consumer.plan(structuredClone(data), {} as never).unwrap();
    expect(received).toEqual(source);
    expect(received.work).toHaveLength(next ? 1 : 0);
  }
});
