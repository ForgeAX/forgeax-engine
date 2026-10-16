import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
  type MaterialShaderArtifact,
} from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import {
  collectGpuDrivenMaterialArtifacts,
  GpuDrivenMaterialProgramProjection,
  gpuDrivenMaterialProgramSelection,
} from '../gpu-driven/material-artifacts';
import type { PreparedGpuDrivenDraw } from '../gpu-driven/prepared-draw';
import type { RenderSystemInternals } from '../record/render-context';
import type { DispatchEntry, RenderableSnapshot } from '../render-system-extract';
import { defaultMaterialSnapshot } from '../render-system-extract';

const receipt = createStandardPbrArtifactReceipt();

function row(index: number) {
  const material = { ...defaultMaterialSnapshot(index + 1), materialShaderId: `material-${index}` };
  const prepared: PreparedGpuDrivenDraw = {
    identity: { material: material.materialShaderId, geometry: 'cube', deformation: 'rigid' },
    receiptGeneration: receipt.generation,
    receiptIdentity: receipt.receiptIdentity,
    directEntry: receipt.directEntry,
    sceneIndexEntry: receipt.sceneIndexEntry,
    materialRow: receipt.materialRow,
    resourceSlots: receipt.resourceSlots,
    uvSets: receipt.uvSets,
    vertexInputs: receipt.vertexInputs,
    alphaMask: receipt.alphaMask,
    skinPaletteAddress: receipt.skinPaletteAddress,
    topology: 'triangle-list',
    indexed: true,
    first: 0,
    count: 36,
    baseVertex: 0,
  };
  const source: RenderableSnapshot = {
    assetHandle: 1,
    worldId: 0,
    entityKey: index,
    transform: { world: new Float32Array(16) },
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: 36,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'pbr',
        materialResourceClass: '',
        prepared,
      },
    ],
  };
  return { source, renderableIndex: index };
}

function dispatch(index: number, id = `shadow-${index}`): DispatchEntry {
  return {
    entityIndex: index,
    materialHandle: index + 1,
    renderableIndex: index,
    passIndex: 0,
    queue: 2000,
    layer: 0,
    tags: { LightMode: 'ShadowCaster' },
    renderState: undefined,
    defines: undefined,
    paramSnapshot: undefined,
    materialShaderId: id,
    vertexEntry: `${id}_vs`,
    fragmentEntry: `${id}_fs`,
  };
}

function artifact(id: string): MaterialShaderArtifact {
  return {
    material: id,
    pass: 'Forward',
    program: createMaterialShaderProgram(''),
    layoutIdentity: receipt.reflection.layoutIdentity,
    bindings: [],
    deps: [],
    vertexInputs: [],
    receipt,
  };
}

function collect(rows: ReturnType<typeof row>[], shadowDispatch: DispatchEntry[]) {
  return collectGpuDrivenMaterialArtifacts({
    rows,
    dispatch: shadowDispatch,
    resolve: (id) => artifact(id),
    clustered: false,
    shadowViews: true,
    reflectionFallback: false,
  });
}

describe('GPU-driven material artifact selection', () => {
  it('fills one collection-owned selection without retaining mutable input or stale declined values', () => {
    const r = row(0);
    const draw = r.source.gpuDrivenDraws?.[0]?.prepared;
    if (draw === undefined) throw Error('expected prepared draw');
    const out = {
      logicalMaterialShaderId: '',
      sceneIndexProgramKey: undefined as string | undefined,
      materialShaderId: '',
    };
    const reference = gpuDrivenMaterialProgramSelection(
      r.source.material,
      draw,
      'forward',
      undefined,
    );
    expect(
      gpuDrivenMaterialProgramSelection(r.source.material, draw, 'forward', undefined, out),
    ).toBe(out);
    expect(out).toEqual(reference);
    const shadow = gpuDrivenMaterialProgramSelection(
      r.source.material,
      draw,
      'shadow',
      { materialShaderId: 'caster' },
      out,
    );
    expect(shadow).toBe(out);
    expect(out.materialShaderId).toBe('caster');
    const before = { ...out };
    expect(
      gpuDrivenMaterialProgramSelection(
        { ...r.source.material, materialSceneIndexProgramKeys: {} },
        draw,
        'shadow',
        undefined,
        out,
      ),
    ).toBeUndefined();
    expect(out).toEqual(before);
  });

  it.each([
    1, 3,
  ])('allocates material lookup maps only for overflow with %i materials on the last receiver', (materialCount) => {
    const shared = row(0);
    const materials = Array.from({ length: materialCount }, (_, index) => row(index));
    const rows = Array.from({ length: 1024 }, (_, renderableIndex) => ({
      ...shared,
      renderableIndex,
    }));
    rows[1023] = {
      ...shared,
      renderableIndex: 1023,
      source: {
        ...shared.source,
        materials: materials.map(({ source }) => source.material),
        gpuDrivenDraws: materials.flatMap(({ source }, materialSlot) =>
          (source.gpuDrivenDraws ?? []).map((draw) => ({ ...draw, materialSlot })),
        ),
      },
    };
    const entries = rows.flatMap(({ renderableIndex, source }) =>
      source.materials.flatMap((_material, materialIndex) =>
        ['Forward', 'ShadowCaster'].map((LightMode) => ({
          ...dispatch(materialIndex, `material-${materialIndex}`),
          renderableIndex,
          tags: { LightMode },
        })),
      ),
    );
    const published = materials.map((_material, index) => artifact(`material-${index}`));
    const NativeMap = Map;
    let allocations = 0;
    let lookups = 0;
    class CountedMap<K, V> extends NativeMap<K, V> {
      constructor(entries?: Iterable<readonly [K, V]> | null) {
        super(entries);
        allocations++;
      }
      override get(key: K): V | undefined {
        lookups++;
        return super.get(key);
      }
    }
    let result: ReturnType<typeof collectGpuDrivenMaterialArtifacts>;
    let observed: { allocations: number; lookups: number };
    vi.stubGlobal('Map', CountedMap);
    try {
      allocations = 0;
      lookups = 0;
      result = collectGpuDrivenMaterialArtifacts({
        rows,
        dispatch: entries,
        resolve: (id) => published[Number(id.slice('material-'.length))],
        clustered: false,
        shadowViews: true,
        reflectionFallback: false,
      });
      observed = { allocations, lookups };
    } finally {
      vi.unstubAllGlobals();
    }
    expect(result.materialArtifacts.size).toBe(materialCount);
    expect(result.shadowMaterialArtifacts.size).toBe(materialCount);
    // Two target maps and one selected-request map per pass remain. Only the
    // final multi-material receiver needs another map, regardless of its width.
    expect(observed.allocations).toBe(4 + Number(materialCount > 1));
    if (materialCount === 1) expect(observed.lookups).toBe(2);
  });

  it('preserves raw dispatch reads for first, repeated, overflow and ignored entries', () => {
    const trace: string[] = [];
    const entries = [0, 0, 1, 2].map((material, index) => {
      const LightMode = index === 3 ? 'DepthOnly' : 'Forward';
      return new Proxy(
        {
          ...dispatch(material),
          renderableIndex: 17,
          tags: {
            get LightMode() {
              trace.push(`${index}:LightMode`);
              return LightMode;
            },
          },
        },
        {
          get(target, key, receiver) {
            trace.push(`${index}:${String(key)}`);
            return Reflect.get(target, key, receiver);
          },
        },
      );
    });
    collectGpuDrivenMaterialArtifacts({
      rows: [],
      dispatch: entries,
      resolve: undefined,
      clustered: false,
      shadowViews: true,
      reflectionFallback: false,
    });
    expect(trace).toEqual([
      '0:tags',
      '0:LightMode',
      '0:materialShaderId',
      '0:renderableIndex',
      '0:renderableIndex',
      '0:materialHandle',
      '0:materialHandle',
      '1:tags',
      '1:LightMode',
      '1:materialShaderId',
      '1:renderableIndex',
      '1:materialHandle',
      '2:tags',
      '2:LightMode',
      '2:materialShaderId',
      '2:renderableIndex',
      '2:materialHandle',
      '2:materialHandle',
      '3:tags',
      '3:LightMode',
      '3:materialShaderId',
    ]);
  });

  it.each([
    'renderableIndex',
    'materialHandle',
  ] as const)('preserves the second raw %s getter failure before later observations', (field) => {
    const failure = new Error(`second ${field} read failed`);
    const trace: string[] = [];
    let reads = 0;
    const entry = new Proxy(dispatch(0), {
      get(target, key, receiver) {
        trace.push(String(key));
        if (key === field && ++reads === 2) throw failure;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => collect([], [entry])).toThrow(failure);
    expect(trace).toEqual([
      'tags',
      'materialShaderId',
      'renderableIndex',
      'renderableIndex',
      ...(field === 'materialHandle' ? ['materialHandle', 'materialHandle'] : []),
    ]);
  });

  it('uses the insertion observation when a raw material handle changes after lookup', () => {
    const trace: number[] = [];
    const entry = {
      ...dispatch(1, 'selected'),
      tags: { LightMode: 'Forward' },
      get materialHandle() {
        const handle = trace.length === 0 ? 1 : 2;
        trace.push(handle);
        return handle;
      },
    };
    const selected = collect([row(1)], [entry]);
    expect(trace).toEqual([1, 2]);
    expect([...selected.materialArtifacts.values()][0]?.vertexEntry).toBe('selected_vs');
  });

  it('does not serialize repeated material requests when shared programs alternate', () => {
    const shared = [row(0), row(1)] as const;
    const rows = Array.from({ length: 2300 }, (_, renderableIndex) => ({
      ...(renderableIndex % 2 === 0 ? shared[0] : shared[1]),
      renderableIndex,
    }));
    const entries = rows.flatMap(({ renderableIndex }) =>
      ['Forward', 'ShadowCaster'].map((LightMode) => ({
        ...dispatch(renderableIndex % 2, `material-${renderableIndex % 2}`),
        renderableIndex,
        tags: { LightMode },
      })),
    );
    const published = [artifact('material-0'), artifact('material-1')];
    const serializations = vi.spyOn(JSON, 'stringify');
    try {
      const result = collectGpuDrivenMaterialArtifacts({
        rows,
        dispatch: entries,
        resolve: (id) => published[id === 'material-0' ? 0 : 1],
        clustered: false,
        shadowViews: true,
        reflectionFallback: false,
      });
      expect(result.materialArtifacts.size).toBe(2);
      expect(result.shadowMaterialArtifacts.size).toBe(2);
      expect(
        serializations.mock.calls.filter(([value]) => Array.isArray(value) && value.length === 8),
      ).toHaveLength(0);
    } finally {
      serializations.mockRestore();
    }
  });

  it('keeps first Forward and last Shadow entries separate when one row has multiple materials', () => {
    const first = row(0).source;
    const second = row(1).source;
    const secondDraw = second.gpuDrivenDraws?.[0];
    if (secondDraw === undefined) throw new Error('missing second material draw');
    const rows = [
      {
        renderableIndex: 17,
        source: {
          ...first,
          materials: [first.material, second.material],
          gpuDrivenDraws: [...(first.gpuDrivenDraws ?? []), { ...secondDraw, materialSlot: 1 }],
        },
      },
    ];
    const entries = [0, 1].flatMap((index) => [
      {
        ...dispatch(index, `forward-${index}`),
        renderableIndex: 17,
        tags: { LightMode: 'Forward' },
      },
      {
        ...dispatch(index, `ignored-${index}`),
        renderableIndex: 17,
        tags: { LightMode: 'Forward' },
      },
      { ...dispatch(index, `old-shadow-${index}`), renderableIndex: 17 },
      { ...dispatch(index, `shadow-${index}`), renderableIndex: 17 },
    ]);
    const selected = collect(rows, entries);
    expect([...selected.materialArtifacts.values()].map((value) => value.vertexEntry)).toEqual([
      'forward-0_vs',
      'forward-1_vs',
    ]);
    expect(
      [...selected.shadowMaterialArtifacts.values()].map((value) => value.vertexEntry),
    ).toEqual(['shadow-0_vs', 'shadow-1_vs']);
  });

  it('preserves program-selection getter order and does not read the Shadow identity for Forward', () => {
    const source = row(0).source;
    const prepared = source.gpuDrivenDraws?.[0]?.prepared;
    if (prepared === undefined) throw new Error('missing prepared draw');
    const trace: string[] = [];
    const material = {
      ...source.material,
      get materialShaderId() {
        trace.push('logical');
        return 'logical';
      },
      get materialSceneIndexProgramKeys() {
        trace.push('scene');
        return undefined;
      },
    };
    const shadow = {
      get materialShaderId() {
        trace.push('shadow');
        return 'shadow';
      },
    };
    gpuDrivenMaterialProgramSelection(material, prepared, 'forward', shadow);
    expect(trace).toEqual(['logical', 'scene']);
    trace.length = 0;
    gpuDrivenMaterialProgramSelection(material, prepared, 'shadow', shadow);
    expect(trace).toEqual(['logical', 'scene', 'shadow', 'shadow']);
    trace.length = 0;
    const error = new Error('logical identity failed');
    expect(() =>
      gpuDrivenMaterialProgramSelection(
        {
          ...material,
          get materialShaderId(): string {
            trace.push('failed-logical');
            throw error;
          },
        },
        prepared,
        'shadow',
        shadow,
      ),
    ).toThrow(error);
    // The spread above reads the original getters before the new call.
    expect(trace.slice(-1)).toEqual(['failed-logical']);
    expect(trace).not.toContain('shadow');
  });

  it('does not resolve shadow programs without a light view and restores them when enabled', () => {
    const resolve = vi.fn((id: string) => artifact(id));
    const input = {
      rows: [row(0)],
      dispatch: [dispatch(0)],
      resolve,
      clustered: false,
      shadowViews: true,
      reflectionFallback: false,
    };
    for (const shadowViews of [true, false, true]) {
      resolve.mockClear();
      const result = collectGpuDrivenMaterialArtifacts({ ...input, shadowViews });
      expect(result.materialArtifacts.size).toBe(1);
      expect(result.shadowMaterialArtifacts.size).toBe(shadowViews ? 1 : 0);
      expect(resolve.mock.calls).toHaveLength(shadowViews ? 2 : 1);
    }
  });

  it('preserves authored Forward entries and observes their replacement', () => {
    const rows = [row(0)];
    const forward = {
      ...dispatch(0, 'material-0'),
      tags: { LightMode: 'Forward' },
      vertexEntry: 'vs_authored',
      fragmentEntry: 'fs_authored',
    };
    const before = collect(rows, [forward, dispatch(0)]);
    const selected = [...before.materialArtifacts.values()][0];
    expect(selected?.vertexEntry).toBe('vs_authored');
    expect(selected?.fragmentEntry).toBe('fs_authored');
    const after = collect(rows, [{ ...forward, fragmentEntry: 'fs_replacement' }, dispatch(0)]);
    expect([...after.materialArtifacts.values()][0]?.fragmentEntry).toBe('fs_replacement');
  });

  it('resolves a shared program once per request for retained receivers in both passes', () => {
    const shared = row(0);
    const rows = Array.from({ length: 300 }, (_, renderableIndex) => ({
      ...shared,
      renderableIndex,
    }));
    const resolve = vi.fn((id: string) => artifact(id));
    const result = collectGpuDrivenMaterialArtifacts({
      rows,
      dispatch: [],
      resolve,
      clustered: false,
      shadowViews: true,
      reflectionFallback: false,
    });
    expect(result.materialArtifacts.size).toBe(1);
    expect(result.shadowMaterialArtifacts.size).toBe(1);
    expect(resolve.mock.calls).toHaveLength(2);
  });

  it('derives shared vertex color and shadow admission once per pass in each collection', () => {
    const shared = row(0);
    const prepared = shared.source.gpuDrivenDraws?.[0]?.prepared;
    if (prepared === undefined) throw new Error('missing prepared draw');
    const actual = [...prepared.vertexInputs];
    const required = [...receipt.vertexInputs];
    Object.assign(prepared, { vertexInputs: actual });
    const rows = Array.from({ length: 1024 }, (_, renderableIndex) => ({
      ...shared,
      renderableIndex,
    }));
    const entries = rows.flatMap(({ renderableIndex }) =>
      ['Forward', 'ShadowCaster'].map((LightMode) => ({
        ...dispatch(0, 'material-0'),
        renderableIndex,
        tags: { LightMode },
      })),
    );
    const resolve = vi.fn((id: string) => ({
      ...artifact(id),
      receipt: { ...receipt, vertexInputs: required },
    }));
    const checks = vi.spyOn(required, 'every');
    const inputScans = vi.spyOn(actual, 'some');
    try {
      for (let frame = 0; frame < 4; frame++) {
        checks.mockClear();
        inputScans.mockClear();
        resolve.mockClear();
        const result = collectGpuDrivenMaterialArtifacts({
          rows,
          dispatch: entries,
          resolve,
          clustered: false,
          shadowViews: true,
          reflectionFallback: false,
        });
        expect(result.materialArtifacts.size).toBe(1);
        expect(result.shadowMaterialArtifacts.size).toBe(1);
        expect(resolve).toHaveBeenCalledTimes(2);
        expect(checks).toHaveBeenCalledTimes(1);
        // Two color selections, plus one actual-input scan per shadow requirement.
        expect(inputScans).toHaveBeenCalledTimes(2 + required.length);
      }
    } finally {
      checks.mockRestore();
      inputScans.mockRestore();
    }
  });

  it('still reads raw program identities and propagates failure for repeated accepted draws', () => {
    const shared = row(0);
    const failure = new Error('program identity unavailable');
    let reads = 0;
    const material = {
      ...shared.source.material,
      get materialShaderId() {
        reads += 1;
        if (reads === 3) throw failure;
        return 'material-0';
      },
    };
    const source = { ...shared.source, material, materials: [material] };
    const resolve = vi.fn((id: string) => artifact(id));
    expect(() =>
      collectGpuDrivenMaterialArtifacts({
        rows: Array.from({ length: 3 }, (_, renderableIndex) => ({ source, renderableIndex })),
        dispatch: [],
        resolve,
        clustered: false,
        shadowViews: true,
        reflectionFallback: false,
      }),
    ).toThrow(failure);
    expect(reads).toBe(3);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a scene-index identity overlay when its key equals the direct identity', () => {
    const legacy = row(0);
    const material = {
      ...legacy.source.material,
      materialProgramKeys: { forward: 'material-0' },
      materialSceneIndexProgramKeys: {
        forward: { pass: 'forward' as const, specializationKey: 'material-0' },
      },
    };
    const modern = {
      renderableIndex: 1,
      source: { ...legacy.source, material, materials: [material] },
    };
    for (const rows of [
      [modern, legacy],
      [legacy, modern],
    ]) {
      const resolve = vi.fn((id: string) => artifact(id));
      const result = collectGpuDrivenMaterialArtifacts({
        rows,
        dispatch: [],
        resolve,
        clustered: false,
        shadowViews: false,
        reflectionFallback: false,
      });
      expect(resolve).toHaveBeenCalledTimes(2);
      expect([...result.materialArtifacts.values()][0]?.specializationKey).toBe(
        rows[1] === modern ? 'material-0' : undefined,
      );
    }
  });

  it('rechecks a changed input table and retains acceptance across an invalid receiver', () => {
    const shared = row(0);
    const draw = shared.source.gpuDrivenDraws?.[0];
    const prepared = draw?.prepared;
    if (draw === undefined || prepared === undefined) throw new Error('missing prepared draw');
    const required = [...receipt.vertexInputs];
    const checks = vi.spyOn(required, 'every');
    const invalidPrepared: PreparedGpuDrivenDraw = { ...prepared, vertexInputs: [] };
    const invalid = {
      ...shared,
      renderableIndex: 1,
      source: {
        ...shared.source,
        gpuDrivenDraws: [{ ...draw, prepared: invalidPrepared }],
      },
    };
    const rows = [shared, invalid, { ...shared, renderableIndex: 2 }];
    const resolve = vi.fn((id: string) => ({
      ...artifact(id),
      receipt: { ...receipt, vertexInputs: required },
    }));
    try {
      const result = collectGpuDrivenMaterialArtifacts({
        rows,
        dispatch: [],
        resolve,
        clustered: false,
        shadowViews: true,
        reflectionFallback: false,
      });
      expect(checks.mock.results.map((result) => result.value)).toEqual([true, false]);
      expect(result.shadowMaterialArtifacts.size).toBe(1);
      // A new collection must inspect the replacement table, even though the
      // prepared material/receipt identity and the resolved program are unchanged.
      checks.mockClear();
      Object.assign(invalidPrepared, {
        vertexInputs: [...prepared.vertexInputs],
      });
      const recovered = collectGpuDrivenMaterialArtifacts({
        rows: [invalid],
        dispatch: [],
        resolve,
        clustered: false,
        shadowViews: true,
        reflectionFallback: false,
      });
      expect(checks.mock.results.map((result) => result.value)).toEqual([true]);
      expect(recovered.shadowMaterialArtifacts.size).toBe(1);
    } finally {
      checks.mockRestore();
    }
  });

  it('keeps skin and vertex-color variants distinct when receivers share a shader', () => {
    const shared = row(0);
    const draw = shared.source.gpuDrivenDraws?.[0];
    if (draw?.prepared === undefined) throw new Error('missing prepared test draw');
    const prepared = draw.prepared;
    const rows = (['rigid', 'skin'] as const).flatMap((deformation) =>
      [false, true].map((color) => {
        const variant = createStandardPbrArtifactReceipt(deformation === 'skin', color);
        return {
          ...shared,
          source: {
            ...shared.source,
            gpuDrivenDraws: [
              {
                ...draw,
                prepared: {
                  ...prepared,
                  identity: { ...prepared.identity, deformation },
                  receiptIdentity: variant.receiptIdentity,
                  vertexInputs: variant.vertexInputs,
                },
              },
            ],
          },
        };
      }),
    );
    const resolve = vi.fn<NonNullable<RenderSystemInternals['getMaterialShaderArtifact']>>(
      (id, request) => {
        if (typeof request !== 'object') throw new Error('expected structured material request');
        return {
          ...artifact(id),
          receipt: createStandardPbrArtifactReceipt(
            request.deformation === 'skin',
            request.vertexColorAvailable,
          ),
        };
      },
    );
    const result = collectGpuDrivenMaterialArtifacts({
      rows,
      dispatch: [],
      resolve,
      clustered: true,
      shadowViews: true,
      reflectionFallback: true,
    });
    expect(result.materialArtifacts.size).toBe(4);
    expect(result.shadowMaterialArtifacts.size).toBe(4);
    expect(resolve.mock.calls).toHaveLength(8);
  });

  it('keeps entry selection independent and rechecks admission for every receiver', () => {
    const shared = row(0);
    const draw = shared.source.gpuDrivenDraws?.[0];
    const prepared = draw?.prepared;
    const materialHandle = shared.source.material.materialHandle;
    if (draw === undefined || prepared === undefined || materialHandle === undefined)
      throw new Error('missing prepared test draw');
    const rows = [0, 1, 2].map((renderableIndex) => ({ ...shared, renderableIndex }));
    const invalid = {
      source: {
        ...shared.source,
        gpuDrivenDraws: [
          {
            ...draw,
            prepared: { ...prepared, receiptGeneration: receipt.generation + 1, vertexInputs: [] },
          },
        ],
      },
      renderableIndex: 3,
    };
    const entries = [0, 1, 2, 3].map((index) => ({
      ...dispatch(index, 'shared-shadow'),
      materialHandle,
      fragmentEntry: index === 1 ? 'fs_alternate' : 'fs_main',
    }));
    const resolve = vi.fn((id: string) => artifact(id));
    const result = collectGpuDrivenMaterialArtifacts({
      rows: [...rows, invalid],
      dispatch: entries,
      resolve,
      clustered: false,
      shadowViews: true,
      reflectionFallback: false,
    });
    expect(result.materialArtifacts.size).toBe(1);
    expect(result.shadowMaterialArtifacts.size).toBe(1);
    expect([...result.shadowMaterialArtifacts.values()][0]?.fragmentEntry).toBe('fs_main');
    // One main request and two distinct selected shadow entries. The invalid
    // receiver shares a program, but cannot bypass its own ABI/input checks.
    expect(resolve.mock.calls).toHaveLength(3);
  });

  it('caches missing publications only for the current collection', () => {
    const shared = row(0);
    const rows = Array.from({ length: 50 }, (_, renderableIndex) => ({
      ...shared,
      renderableIndex,
    }));
    const resolve = vi.fn<(id: string) => MaterialShaderArtifact | undefined>(() => undefined);
    const input = {
      rows,
      dispatch: [],
      resolve,
      clustered: false,
      shadowViews: true,
      reflectionFallback: false,
    };
    expect(collectGpuDrivenMaterialArtifacts(input).materialArtifacts.size).toBe(0);
    expect(resolve.mock.calls).toHaveLength(2);
    resolve.mockImplementation((id) => ({
      ...artifact(id),
      program: createMaterialShaderProgram('new publication'),
    }));
    const recovered = collectGpuDrivenMaterialArtifacts(input);
    expect([...recovered.materialArtifacts.values()][0]?.program.source).toBe('new publication');
    expect(resolve.mock.calls).toHaveLength(4);
  });

  it('observes in-place artifact replacement and receipt changes in the next collection', () => {
    const published = artifact('material-0');
    const input = {
      rows: [row(0)],
      dispatch: [],
      resolve: () => published,
      clustered: false,
      shadowViews: true,
      reflectionFallback: false,
    };
    expect(collectGpuDrivenMaterialArtifacts(input).firstArtifact?.program.source).toBe('');
    Object.assign(published, { program: createMaterialShaderProgram('replaced publication') });
    expect(collectGpuDrivenMaterialArtifacts(input).firstArtifact?.program.source).toBe(
      'replaced publication',
    );
    Object.assign(published, { receipt: { ...receipt, generation: receipt.generation + 1 } });
    expect(collectGpuDrivenMaterialArtifacts(input).materialArtifacts.size).toBe(0);
    Object.assign(published, { receipt });
    expect(collectGpuDrivenMaterialArtifacts(input).materialArtifacts.size).toBe(1);
  });

  it('keeps adjacent entry changes, invalid receipts and missing programs independent', () => {
    const shared = row(0);
    const draw = shared.source.gpuDrivenDraws?.[0];
    if (draw?.prepared === undefined) throw new Error('missing prepared test draw');
    const prepared = draw.prepared;
    const rows = Array.from({ length: 6 }, (_, renderableIndex) => {
      const missing = renderableIndex >= 4;
      const material = missing
        ? { ...shared.source.material, materialShaderId: 'unpublished' }
        : shared.source.material;
      return {
        renderableIndex,
        source: {
          ...shared.source,
          material,
          materials: [material],
          gpuDrivenDraws: [
            {
              ...draw,
              prepared:
                renderableIndex === 3
                  ? { ...prepared, receiptGeneration: receipt.generation + 1, vertexInputs: [] }
                  : prepared,
            },
          ],
        },
      };
    });
    const entries = rows.map((_, index) => ({
      ...dispatch(index, index >= 4 ? 'unpublished' : 'shared-shadow'),
      materialHandle: 1,
      vertexEntry: 'vs_main',
      fragmentEntry: index === 2 ? 'fs_alternate' : 'fs_main',
    }));
    const resolve = vi.fn((id: string) => (id === 'unpublished' ? undefined : artifact(id)));
    const input = {
      rows,
      dispatch: entries,
      resolve,
      clustered: false,
      shadowViews: true,
      reflectionFallback: false,
    };
    const before = collectGpuDrivenMaterialArtifacts(input);
    expect(before.materialArtifacts.size).toBe(1);
    expect(before.shadowMaterialArtifacts.size).toBe(1);
    expect([...before.shadowMaterialArtifacts.values()][0]?.fragmentEntry).toBe('fs_alternate');

    const firstRow = rows[0];
    const firstEntry = entries[0];
    if (firstRow === undefined || firstEntry === undefined) throw new Error('missing first row');
    rows.push({ ...firstRow, renderableIndex: 6 });
    entries.push({ ...firstEntry, renderableIndex: 6 });
    const after = collectGpuDrivenMaterialArtifacts(input);
    expect(after.materialArtifacts.size).toBe(1);
    expect(after.shadowMaterialArtifacts.size).toBe(1);
    expect([...after.shadowMaterialArtifacts.values()][0]?.fragmentEntry).toBe('fs_main');
  });

  it('indexes shadow dispatch once instead of rescanning it for each prepared draw', () => {
    const count = 64;
    const rows = Array.from({ length: count }, (_, index) => row(index));
    let tagReads = 0;
    const entries = rows.map((_, index) => ({
      ...dispatch(index),
      tags: {
        get LightMode() {
          tagReads += 1;
          return 'ShadowCaster';
        },
      },
    }));
    const result = collect(rows, entries);
    expect(result.shadowMaterialArtifacts.size).toBe(count);
    for (const [index, selected] of [...result.shadowMaterialArtifacts.values()].entries()) {
      expect(selected.material).toBe(`shadow-${index}`);
      expect(selected.vertexEntry).toBe(`shadow-${index}_vs`);
      expect(selected.fragmentEntry).toBe(`shadow-${index}_fs`);
    }
    expect(tagReads).toBeLessThanOrEqual(count * 2);
  });

  it('keeps entry points with the selected last shadow program for a repeated draw key', () => {
    const first = dispatch(0, 'first');
    const last = { ...dispatch(0, 'last'), passIndex: 1 };
    const selected = [...collect([row(0)], [first, last]).shadowMaterialArtifacts.values()][0];
    expect(selected?.material).toBe('last');
    expect(selected?.vertexEntry).toBe('last_vs');
    expect(selected?.fragmentEntry).toBe('last_fs');
  });

  it('selects each material within its own receiver and preserves pass precedence', () => {
    const first = row(0);
    const second = row(1);
    const secondDraw = second.source.gpuDrivenDraws?.[0];
    if (secondDraw === undefined) throw new Error('missing second material draw');
    const combined = {
      ...first,
      source: {
        ...first.source,
        materials: [first.source.material, second.source.material],
        gpuDrivenDraws: [
          ...(first.source.gpuDrivenDraws ?? []),
          { ...secondDraw, materialSlot: 1 },
        ],
      },
    };
    const entries: DispatchEntry[] = [0, 1].flatMap((materialIndex) =>
      ['first', 'last'].flatMap((order) =>
        ['Forward', 'ShadowCaster'].map((LightMode) => ({
          ...dispatch(materialIndex, `material-${materialIndex}`),
          renderableIndex: 0,
          tags: { LightMode },
          vertexEntry: `${LightMode}_${materialIndex}_${order}`,
        })),
      ),
    );
    // A separate receiver using the same material handle must not replace
    // this receiver's selected entries.
    entries.push({ ...dispatch(0, 'unrelated'), renderableIndex: 11 });
    const result = collect([combined], entries);
    expect([...result.materialArtifacts.values()].map((value) => value.vertexEntry)).toEqual([
      'Forward_0_first',
      'Forward_1_first',
    ]);
    expect([...result.shadowMaterialArtifacts.values()].map((value) => value.vertexEntry)).toEqual([
      'ShadowCaster_0_last',
      'ShadowCaster_1_last',
    ]);
  });

  it('selects programs in the retained index domain despite validation holes and row order', () => {
    const indices = [17, 2, 41];
    const rows = indices.map((renderableIndex, materialIndex) => ({
      ...row(materialIndex),
      renderableIndex,
    }));
    const entries = rows
      .map((entry, materialIndex) => ({
        ...dispatch(materialIndex),
        renderableIndex: entry.renderableIndex,
      }))
      .reverse();
    const selected = collect(rows, entries);
    expect([...selected.shadowMaterialArtifacts.values()].map((value) => value.material)).toEqual([
      'shadow-0',
      'shadow-1',
      'shadow-2',
    ]);
    // A dispatch-only receiver cannot replace any surviving receiver's entry.
    entries.push({ ...dispatch(0, 'filtered-out'), renderableIndex: 0 });
    expect([...collect(rows, entries).shadowMaterialArtifacts.entries()]).toEqual([
      ...selected.shadowMaterialArtifacts.entries(),
    ]);
  });

  it('re-reads dispatch and program entries on the next collection', () => {
    const rows = [row(0)];
    const entries = [dispatch(0, 'before')];
    const before = collect(rows, entries);
    entries[0] = dispatch(0, 'after');
    const after = collect(rows, entries);
    expect([...before.shadowMaterialArtifacts.values()][0]?.vertexEntry).toBe('before_vs');
    expect([...after.shadowMaterialArtifacts.values()][0]?.vertexEntry).toBe('after_vs');
  });
});

it('reuses only the producer dispatch program index while resolving current shader artifacts', () => {
  const r = row(0);
  let tagReads = 0;
  let overlayReads = 0;
  const entries = [
    {
      ...dispatch(0),
      get defines() {
        overlayReads++;
        return { VERTEX_COLOR_AVAILABLE: '1' };
      },
      tags: {
        get LightMode() {
          tagReads++;
          return 'ShadowCaster';
        },
      },
    },
  ];
  const projection = new GpuDrivenMaterialProgramProjection();
  const programs = projection.project(entries);
  expect(projection.project(entries)).toBe(programs);
  expect(tagReads).toBe(1);
  expect(overlayReads).toBe(0);
  const overlays = programs.overlays;
  expect(overlays.values.get(0)?.variantSet).toBe('VERTEX_COLOR_AVAILABLE=1');
  expect(programs.overlays).toBe(overlays);
  expect(overlayReads).toBe(1);
  let ready = false;
  const resolve = vi.fn((id: string) => (ready ? artifact(id) : undefined));
  const input = {
    rows: [r],
    dispatch: entries,
    programs,
    resolve,
    clustered: false,
    reflectionFallback: false,
    shadowViews: true,
  };
  expect(collectGpuDrivenMaterialArtifacts(input).shadowMaterialArtifacts.size).toBe(0);
  ready = true;
  for (let frame = 0; frame < 20; frame++) {
    const selected = [
      ...collectGpuDrivenMaterialArtifacts(input).shadowMaterialArtifacts.values(),
    ][0];
    expect(selected?.fragmentEntry).toBe('shadow-0_fs');
  }
  expect(tagReads).toBe(1);
  expect(resolve).toHaveBeenCalledTimes(42);
  const changed = [{ ...dispatch(0), fragmentEntry: 'changed_fs' }];
  const replacement = projection.project(changed);
  expect(replacement).not.toBe(programs);
  expect(replacement.overlays).not.toBe(overlays);
  const result = collectGpuDrivenMaterialArtifacts({
    ...input,
    dispatch: changed,
    programs: replacement,
  });
  expect([...result.shadowMaterialArtifacts.values()][0]?.fragmentEntry).toBe('changed_fs');
  // A mismatched index must use the ordinary mutable-input path.
  const fallback = collectGpuDrivenMaterialArtifacts({ ...input, dispatch: changed });
  expect([...fallback.shadowMaterialArtifacts.values()][0]?.fragmentEntry).toBe('changed_fs');
  projection.clear();
  expect(projection.project(changed)).not.toBe(replacement);
  expect(projection.project(changed).overlays).not.toBe(replacement.overlays);
});

it('uses only explicit hidden preparation passes for the accepted scene-index program pair', () => {
  const r = row(0);
  const caster = dispatch(0, 'hidden-direct-caster');
  const forward = { ...caster, tags: { LightMode: 'Forward' }, materialShaderId: 'material-0' };
  const material = {
    ...r.source.material,
    materialProgramKeys: { color: 'material-0', shadow: 'hidden-direct-caster' },
    materialSceneIndexProgramKeys: {
      color: { pass: 'forward' as const, specializationKey: 'hidden-scene-color' },
      shadow: { pass: 'shadow' as const, specializationKey: 'hidden-scene-caster' },
    },
  };
  const source = {
    ...r.source,
    authorVisible: false,
    material,
    materials: [material],
    pipelinePreparation: [forward, caster],
  };
  const input = {
    rows: [{ ...r, source }],
    dispatch: [],
    resolve: (id: string) => artifact(id),
    clustered: false,
    shadowViews: true,
    reflectionFallback: false,
  };
  const hidden = collectGpuDrivenMaterialArtifacts(input);
  expect([...hidden.materialArtifacts.values()][0]?.specializationKey).toBe('hidden-scene-color');
  expect([...hidden.shadowMaterialArtifacts.values()][0]?.specializationKey).toBe(
    'hidden-scene-caster',
  );
  expect([...hidden.shadowMaterialArtifacts.values()][0]?.vertexEntry).toBe(caster.vertexEntry);
  expect(input.dispatch).toEqual([]);
  expect(source.authorVisible).toBe(false);
  // A stale preparation roster on an ordinary visible row cannot replace dispatch ownership.
  expect(
    collectGpuDrivenMaterialArtifacts({
      ...input,
      rows: [{ ...r, source: { ...source, authorVisible: true } }],
    }).shadowMaterialArtifacts.size,
  ).toBe(0);
});
