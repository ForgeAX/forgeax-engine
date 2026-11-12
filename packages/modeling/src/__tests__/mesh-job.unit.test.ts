import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { type MeshAsset, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { captureModels } from '../capture';
import {
  type AssetsJob,
  assetsJobOutputs,
  assetsJobSources,
  createMeshJobCooker,
  type MeshJob,
  meshJobSources,
  type RigJob,
  rigJobOutputs,
  rigJobSources,
} from '../mesh-job';
import { model } from '../model';
import { rig } from '../rig';
import { sel } from '../selectors';

interface CrateParameters {
  readonly height: number;
  readonly lid: boolean;
}

const CRATE: MeshJob<CrateParameters> = {
  name: 'crate',
  build: (p) => {
    const m = model();
    m.box({ size: [1, p.height, 1] });
    if (p.lid) m.extrude(sel.facing('+y'), { distance: 0.25, region: 'merged', label: 'lid' });
    m.uv.project({ mode: 'box', scale: 1 });
    return m;
  },
  export: { normals: { mode: 'flat' } },
};

const BROKEN: MeshJob<{ readonly size: number }> = {
  name: 'broken',
  build: (p) => {
    const m = model();
    m.box({ size: [p.size, 1, 1] });
    return m;
  },
};

const GUID = '01900000-0000-7000-8000-00000000c0b5';

/** One face whose outline crosses itself: export cannot triangulate it. */
const BOW: MeshJob<Record<string, never>> = {
  name: 'bow',
  build: () => {
    const m = model();
    const mesh = m.editMesh;
    const points: [number, number, number][] = [
      [0, 0, 0],
      [1, 1, 0],
      [1, 0, 0],
      [0, 1, 0],
    ];
    mesh.addFace(points.map((p) => mesh.addVertex(...p)));
    m.uv.project({ mode: 'box', scale: 1 });
    return m;
  },
};

function direct(p: CrateParameters): MeshAsset {
  const out = CRATE.build(p).finish({ key: 'crate', normals: { mode: 'flat' } });
  if (!out.ok) throw out.error;
  return out.value['mesh/crate'] as MeshAsset;
}

describe('mesh jobs through PackCookSource + NativeCooker', () => {
  it('meshJobSources defers the job; the cooker publishes the same mesh bytes', async () => {
    const sources = meshJobSources(CRATE, { key: 'crate', params: { lid: true, height: 2 } });
    if (!sources.ok) throw sources.error;
    expect(Object.keys(sources.value)).toEqual(['mesh/crate']);
    const entry = sources.value['mesh/crate'];
    expect(entry).toEqual({
      kind: 'modeling-mesh-job',
      execution: 'cooked',
      source: { version: 1, job: 'crate', key: 'crate', params: { height: 2, lid: true } },
    });
    const registry = new NativeCookerRegistry();
    registry.register(createMeshJobCooker([CRATE, BROKEN]));
    const source = JSON.parse(JSON.stringify((entry as { source: unknown }).source));
    const draft = await registry.runDraft('modeling-mesh-job', { guid: GUID, source });
    if (!draft.ok) throw new Error(JSON.stringify(draft.error));
    const mesh = draft.value.payload as MeshAsset;
    const expected = direct({ height: 2, lid: true });
    expect(mesh.kind).toBe('mesh');
    expect(Array.from(mesh.vertices)).toEqual(Array.from(expected.vertices));
    expect(Array.from(mesh.indices ?? [])).toEqual(Array.from(expected.indices ?? []));
    expect(draft.value.guid).toBe(GUID);
    const other = await registry.runDraft('modeling-mesh-job', {
      guid: GUID,
      source: { ...source, params: { height: 3, lid: true } },
    });
    if (!other.ok) throw new Error(JSON.stringify(other.error));
    expect(other.value.inputFingerprint).not.toBe(draft.value.inputFingerprint);
    expect(createMeshJobCooker([CRATE]).cacheIdentity?.()).not.toBe(
      createMeshJobCooker([CRATE, BROKEN]).cacheIdentity?.(),
    );
  });

  it('editing a job body or its export options changes the cooker identity and the input fingerprint', async () => {
    const edited: MeshJob<CrateParameters> = {
      ...CRATE,
      build: (p) => {
        const m = CRATE.build({ ...p, height: p.height + 1 });
        return m;
      },
    };
    const reexport: MeshJob<CrateParameters> = {
      ...CRATE,
      export: { normals: { mode: 'smooth' } },
    };
    const identity = (job: MeshJob<CrateParameters>) =>
      createMeshJobCooker([job as MeshJob<never>]).cacheIdentity?.();
    expect(identity(edited)).not.toBe(identity(CRATE));
    expect(identity(reexport)).not.toBe(identity(CRATE));
    expect(identity(CRATE)).toBe(identity({ ...CRATE }));
    const fingerprint = async (job: MeshJob<CrateParameters>) => {
      const registry = new NativeCookerRegistry();
      registry.register(createMeshJobCooker([job as MeshJob<never>]));
      const draft = await registry.runDraft('modeling-mesh-job', {
        guid: GUID,
        source: { version: 1, job: 'crate', key: 'crate', params: { height: 2, lid: true } },
      });
      if (!draft.ok) throw new Error(JSON.stringify(draft.error));
      return draft.value.inputFingerprint;
    };
    expect(await fingerprint(edited)).not.toBe(await fingerprint(CRATE));
    expect(await fingerprint(reexport)).not.toBe(await fingerprint(CRATE));
    expect(await fingerprint(CRATE)).toBe(await fingerprint({ ...CRATE }));
  });

  it('an export failure names its output, and the cook its job, key and GUID', async () => {
    const direct = BOW.build({}).finish({ key: 'bow' });
    expect(direct).toMatchObject({
      ok: false,
      error: { code: 'model-degenerate', detail: { output: 'mesh/bow', face: 0 } },
    });
    const registry = new NativeCookerRegistry();
    registry.register(createMeshJobCooker([BOW]));
    const failed = await registry.runDraft('modeling-mesh-job', {
      guid: GUID,
      source: { version: 1, job: 'bow', key: 'bow', params: {} },
    });
    expect(failed).toMatchObject({ ok: false, error: { code: 'native-cook-failed' } });
    const text = failed.ok ? '' : JSON.stringify(failed.error.detail).replaceAll('\\"', '"');
    for (const name of [
      'model-degenerate',
      '"job":"bow"',
      `"guid":"${GUID}"`,
      '"output":"mesh/bow"',
      '"face":0',
    ])
      expect(text).toContain(name);
  });

  it('runs the job in place under a capture, so the tools see its session', async () => {
    const captured = await captureModels(() =>
      meshJobSources(CRATE, { key: 'crate', params: { height: 2, lid: true } }),
    );
    if (!captured.ok) throw captured.error;
    const built = captured.value.value;
    if (!built.ok) throw built.error;
    expect(Array.from((built.value['mesh/crate'] as MeshAsset).vertices)).toEqual(
      Array.from(direct({ height: 2, lid: true }).vertices),
    );
    expect(captured.value.sessions).toHaveLength(1);
    expect(captured.value.sessions[0]?.inspect().output).toBe('mesh/crate');
    expect(captured.value.sessions[0]?.inspect().journal.map((e) => e.op)).toEqual([
      'box',
      'extrude',
      'uv.project',
    ]);
  });

  it('rejects non-JSON parameters, bad names, unknown jobs and failed jobs', async () => {
    const bad = [
      meshJobSources(CRATE, { key: 'crate', params: { height: Number.NaN, lid: true } }),
      meshJobSources(CRATE, { key: 'Crate', params: { height: 1, lid: true } }),
      meshJobSources({ ...CRATE, name: 'a b' }, { key: 'crate', params: { height: 1, lid: true } }),
      meshJobSources({ ...CRATE, build: () => model() } as MeshJob<{ readonly at: number[] }>, {
        key: 'crate',
        params: { at: [1] },
      }),
    ];
    for (const result of bad) {
      expect(result).toMatchObject({ ok: false, error: { code: 'model-invalid-argument' } });
    }
    expect(() => createMeshJobCooker([CRATE, CRATE])).toThrow(/unique/);
    // Jobs outgrow the build timeout, so the cooker asks its host for a long cook bound.
    expect(createMeshJobCooker([CRATE]).timeoutMs).toBe(600_000);
    expect(createMeshJobCooker([CRATE], { timeoutMs: 1_800_000 }).timeoutMs).toBe(1_800_000);
    expect(() => createMeshJobCooker([CRATE], { timeoutMs: 0 })).toThrow(RangeError);
    const registry = new NativeCookerRegistry();
    registry.register(createMeshJobCooker([CRATE, BROKEN]));
    const run = (source: unknown) => registry.runDraft('modeling-mesh-job', { guid: GUID, source });
    const unknown = await run({ version: 1, job: 'barrel', key: 'crate', params: {} });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'native-cook-failed' } });
    expect(JSON.stringify(unknown)).toMatch(/barrel/);
    const extra = await run({ version: 1, job: 'crate', key: 'crate', params: {}, more: 1 });
    expect(extra).toMatchObject({ ok: false, error: { code: 'native-cook-failed' } });
    const failed = await run({ version: 1, job: 'broken', key: 'broken', params: { size: -1 } });
    expect(failed).toMatchObject({ ok: false, error: { code: 'native-cook-failed' } });
    expect(JSON.stringify(failed)).toMatch(/model-invalid-argument/);
    for (const name of [
      '"job":"broken"',
      '"key":"broken"',
      `"guid":"${GUID}"`,
      '"output":"mesh/broken"',
    ])
      expect(failed.ok ? '' : JSON.stringify(failed.error.detail).replaceAll('\\"', '"')).toContain(
        name,
      );
  });
});

interface ArmParameters {
  readonly length: number;
}

let armBuilds = 0;
const ARM: RigJob<ArmParameters> = {
  kind: 'rig',
  name: 'arm',
  build: (p) => {
    armBuilds++;
    const m = model();
    m.box({ size: [0.1, 0.1, 0.1], tag: 'base' });
    m.box({ size: [p.length, 0.05, 0.05], center: [p.length / 2 + 0.05, 0, 0], tag: 'arm' });
    m.uv.project({ mode: 'box', scale: 1 });
    const r = rig(m, {
      joints: [
        { name: 'root', parent: null, position: [0, 0, 0] },
        { name: 'elbow', parent: 'root', position: [0.05, 0, 0], kind: 'revolute', axis: 'z' },
      ],
    });
    r.bindRigid(sel.tag('base'), 'root', { part: 'base' });
    r.bindRigid(sel.tag('arm'), 'elbow', { part: 'arm' });
    return {
      rig: r,
      finish: {
        path: {
          keys: [
            { u: 0, pose: { elbow: 0 } },
            { u: 1, pose: { elbow: 90 } },
          ],
        },
        duration: 2,
      },
    };
  },
};

const PACKAGE = definePackageId('01900000-0000-7000-8000-00000000c0b6');

describe('rig jobs through PackCookSource + NativeCooker (S7 route)', () => {
  it('one cooker build of the rig publishes every output, equal to finish()', async () => {
    const outputs = rigJobOutputs(ARM, { key: 'arm', params: { length: 0.3 } });
    if (!outputs.ok) throw outputs.error;
    expect(outputs.value).toEqual([
      'animation-clip/arm',
      'mesh/arm.arm',
      'mesh/arm.base',
      'scene/arm',
    ]);
    const sources = rigJobSources(ARM, {
      key: 'arm',
      packageId: PACKAGE,
      params: { length: 0.3 },
      outputs: outputs.value,
    });
    if (!sources.ok) throw sources.error;
    expect(Object.keys(sources.value).sort()).toEqual([...outputs.value]);
    const registry = new NativeCookerRegistry();
    registry.register(createMeshJobCooker([CRATE, ARM]));
    const direct = ARM.build({ length: 0.3 });
    const finished = direct.rig.finish({ ...direct.finish, key: 'arm', packageId: PACKAGE });
    if (!finished.ok) throw finished.error;
    expect(Object.keys(finished.value).sort()).toEqual([...outputs.value]);
    armBuilds = 0;
    for (const [key, entry] of Object.entries(sources.value)) {
      const guid = AssetGuid.format(AssetGuid.derive(PACKAGE, key));
      const source = JSON.parse(JSON.stringify((entry as { source: unknown }).source));
      const draft = await registry.runDraft('modeling-mesh-job', { guid, source });
      if (!draft.ok) throw new Error(JSON.stringify(draft.error));
      expect(draft.value.guid).toBe(guid);
      const expected = finished.value[key] as { kind: string };
      expect((draft.value.payload as { kind: string }).kind).toBe(expected.kind);
      expect(
        JSON.stringify(draft.value.payload, (_k, v) =>
          ArrayBuffer.isView(v) ? Array.from(v as Float32Array) : v,
        ),
      ).toBe(
        JSON.stringify(expected, (_k, v) =>
          ArrayBuffer.isView(v) ? Array.from(v as Float32Array) : v,
        ),
      );
    }
    expect(armBuilds).toBe(1);
  });

  it('a stale outputs list fails the cook; job kinds do not mix; captures run in place', async () => {
    const registry = new NativeCookerRegistry();
    registry.register(createMeshJobCooker([CRATE, ARM]));
    const stale = rigJobSources(ARM, {
      key: 'arm',
      packageId: PACKAGE,
      params: { length: 0.3 },
      outputs: ['mesh/arm.arm', 'scene/arm'],
    });
    if (!stale.ok) throw stale.error;
    const entry = stale.value['scene/arm'] as { source: unknown };
    const failed = await registry.runDraft('modeling-mesh-job', {
      guid: AssetGuid.format(AssetGuid.derive(PACKAGE, 'scene/arm')),
      source: entry.source,
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(JSON.stringify(failed.error)).toContain('rigJobOutputs');
    const asMesh = await registry.runDraft('modeling-mesh-job', {
      guid: GUID,
      source: { version: 1, job: 'arm', key: 'arm', params: { length: 0.3 } },
    });
    expect(asMesh.ok).toBe(false);
    expect(
      rigJobSources(ARM, { key: 'arm', packageId: PACKAGE, params: { length: 0.3 }, outputs: [] })
        .ok,
    ).toBe(false);
    const captured = await captureModels(() =>
      rigJobSources(ARM, {
        key: 'arm',
        packageId: PACKAGE,
        params: { length: 0.3 },
        outputs: ['animation-clip/arm', 'mesh/arm.arm', 'mesh/arm.base', 'scene/arm'],
      }),
    );
    if (!captured.ok) throw captured.error;
    expect(captured.value.value.ok).toBe(true);
    expect(captured.value.sessions.length).toBeGreaterThan(0);
    const capturedStale = await captureModels(() =>
      rigJobSources(ARM, {
        key: 'arm',
        packageId: PACKAGE,
        params: { length: 0.3 },
        outputs: ['scene/arm'],
      }),
    );
    if (!capturedStale.ok) throw capturedStale.error;
    expect(capturedStale.value.value.ok).toBe(false);
  });
});

let lidBuilds = 0;
/** An assets job: two meshes from one session, keyed under the Pack's packageId. */
const LID: AssetsJob<{ readonly depth: number }> = {
  kind: 'assets',
  name: 'lid',
  build: async (p, { packageId }) => {
    lidBuilds++;
    expect(packageId).toEqual(PACKAGE);
    const m = model();
    m.box({ size: [0.2, p.depth, 0.2] });
    m.uv.project({ mode: 'box', scale: 1 });
    const body = m.finish({ key: 'lid' });
    if (!body.ok) return body;
    const thin = model();
    thin.box({ size: [0.2, p.depth / 4, 0.2] });
    thin.uv.project({ mode: 'box', scale: 1 });
    const cap = thin.finish({ key: 'lid.cap' });
    if (!cap.ok) return cap;
    return ok({ ...body.value, ...cap.value });
  },
};

describe('assets jobs through PackCookSource + NativeCooker (S6 group route)', () => {
  it('one cooker build publishes every listed output, equal to the job', async () => {
    const outputs = await assetsJobOutputs(LID, {
      key: 'lid',
      packageId: PACKAGE,
      params: { depth: 0.04 },
    });
    if (!outputs.ok) throw outputs.error;
    expect(outputs.value).toEqual(['mesh/lid', 'mesh/lid.cap']);
    const sources = await assetsJobSources(LID, {
      key: 'lid',
      packageId: PACKAGE,
      params: { depth: 0.04 },
      outputs: outputs.value,
    });
    if (!sources.ok) throw sources.error;
    expect(Object.keys(sources.value).sort()).toEqual([...outputs.value]);
    const direct = await LID.build({ depth: 0.04 }, { packageId: PACKAGE });
    if (!direct.ok) throw direct.error;
    const registry = new NativeCookerRegistry();
    registry.register(createMeshJobCooker([CRATE, ARM, LID]));
    lidBuilds = 0;
    for (const [key, entry] of Object.entries(sources.value)) {
      const guid = AssetGuid.format(AssetGuid.derive(PACKAGE, key));
      const source = JSON.parse(JSON.stringify((entry as { source: unknown }).source));
      const draft = await registry.runDraft('modeling-mesh-job', { guid, source });
      if (!draft.ok) throw new Error(JSON.stringify(draft.error));
      const bytes = (v: unknown) =>
        JSON.stringify(v, (_k, x) => (ArrayBuffer.isView(x) ? Array.from(x as Float32Array) : x));
      expect(bytes(draft.value.payload)).toBe(bytes(direct.value[key]));
    }
    expect(lidBuilds).toBe(1);
  });

  it('a stale outputs list fails the cook and the capture; captures run in place', async () => {
    const registry = new NativeCookerRegistry();
    registry.register(createMeshJobCooker([LID]));
    const stale = await assetsJobSources(LID, {
      key: 'lid',
      packageId: PACKAGE,
      params: { depth: 0.04 },
      outputs: ['mesh/lid'],
    });
    if (!stale.ok) throw stale.error;
    const failed = await registry.runDraft('modeling-mesh-job', {
      guid: AssetGuid.format(AssetGuid.derive(PACKAGE, 'mesh/lid')),
      source: (stale.value['mesh/lid'] as { source: unknown }).source,
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(JSON.stringify(failed.error)).toContain('assetsJobOutputs');
    const asMesh = await registry.runDraft('modeling-mesh-job', {
      guid: GUID,
      source: { version: 1, job: 'lid', key: 'lid', params: { depth: 0.04 } },
    });
    expect(asMesh.ok).toBe(false);
    const captured = await captureModels(() =>
      assetsJobSources(LID, {
        key: 'lid',
        packageId: PACKAGE,
        params: { depth: 0.04 },
        outputs: ['mesh/lid', 'mesh/lid.cap'],
      }),
    );
    if (!captured.ok) throw captured.error;
    expect(captured.value.value.ok).toBe(true);
    if (captured.value.value.ok)
      expect((captured.value.value.value['mesh/lid'] as { kind: string }).kind).toBe('mesh');
    const capturedStale = await captureModels(() =>
      assetsJobSources(LID, {
        key: 'lid',
        packageId: PACKAGE,
        params: { depth: 0.04 },
        outputs: ['mesh/lid'],
      }),
    );
    if (!capturedStale.ok) throw capturedStale.error;
    expect(capturedStale.value.value.ok).toBe(false);
  });
});
