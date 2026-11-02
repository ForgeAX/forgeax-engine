import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createModelingTools,
  defaultCaptureHeapMb,
  MODEL_VALIDATE_REPORT_SCHEMA,
  MODELING_OPERATION_IDS,
  runCapture,
} from '@forgeax/engine-modeling/tools';
import { toolJsonSchema } from '@forgeax/engine-tool-runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
let directory = '';
let source = '';

const PACK = `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { model, sel } from '@forgeax/engine-modeling';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000a0e0'),
  parameters: [{ name: 'height', type: 'f32', default: 1, minimum: 0.1, maximum: 4 }],
  build({ values }) {
    const m = model();
    m.box({ size: [1, values.height, 1], tag: 'shell' });
    m.checkpoint('box');
    m.inset(sel.facing('+y'), { thickness: 0.1, region: 'merged', label: 'panel' });
    m.markSharp(sel.edges.dihedral('>', 40));
    m.uv.project({ mode: 'box', scale: 1 });
    return m.finish({ key: 'crate' });
  },
});
`;

// A helper session built first, appended into the output session built second.
const PARTS = (
  finishBoth: boolean,
) => `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { model, sel } from '@forgeax/engine-modeling';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000a0e1'),
  build() {
    const knob = model();
    knob.cylinder({ radiusTop: 0.1, radiusBottom: 0.1, height: 0.2, radialSegments: 6, tag: 'knob' });
    knob.uv.project({ mode: 'box', scale: 1 });
    const extra = ${finishBoth ? "knob.finish({ key: 'knob' })" : '{ ok: true, value: {} }'};
    if (!extra.ok) return extra;
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'body' });
    m.append(knob, { translate: [0, 0.6, 0] });
    m.uv.project({ mode: 'box', scale: 1 });
    const out = m.finish({ key: 'radio' });
    return out.ok ? { ok: true, value: { ...out.value, ...extra.value } } : out;
  },
});
`;
let parts = '';
let ambiguous = '';
let broken = '';
// The helper finishes, then the main session fails before its finish().
const BROKEN = `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { model, sel } from '@forgeax/engine-modeling';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000a0e2'),
  build() {
    const knob = model();
    knob.box({ size: [0.2, 0.2, 0.2] });
    knob.uv.project({ mode: 'box', scale: 1 });
    const helper = knob.finish({ key: 'knob' });
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.extrude(sel.tag('missing'), { distance: 1, region: 'merged' });
    return helper.ok ? m.finish({ key: 'main' }) : helper;
  },
});
`;
let open = '';
let rigged = '';
// A helper session, then the rig's source session: the rig's scene marks its session.
const RIGGED = `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { model, rig, sel } from '@forgeax/engine-modeling';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000a0e6'),
  build({ packageId }) {
    const helper = model();
    helper.box({ size: [0.1, 0.1, 0.1] });
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'body' });
    m.uv.project({ mode: 'box', scale: 1 });
    const r = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
    r.bindRigid(sel.tag('body'), 'root', { part: 'body' });
    return r.finish({ key: 'rigged', packageId });
  },
});
`;
let uvless = '';
// uv-missing counts the 6 faces of the box without uv0, and face slot 6 is dead (B11 D2).
const UVLESS = `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { model, sel } from '@forgeax/engine-modeling';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000a0e7'),
  build() {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'shell' });
    m.uv.project({ mode: 'box', scale: 1 });
    m.box({ size: [0.2, 0.2, 0.2], center: [3, 0, 0], tag: 'gone' });
    m.box({ size: [0.2, 0.2, 0.2], center: [-3, 0, 0], tag: 'plain' });
    m.delete(sel.tag('gone'));
    return m.finish({ key: 'uvless' });
  },
});
`;
let slow = '';
// uv1 is written on the top face only at the 'decal' checkpoint, then completed.
const DECAL = `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { model, sel } from '@forgeax/engine-modeling';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000a0e5'),
  build() {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'shell' });
    m.uv.project({ mode: 'box', scale: 1 });
    m.uv.project({ mode: 'planar', axis: 'y', scale: 1, channel: 'uv1', faces: sel.facing('+y') });
    m.checkpoint('decal');
    m.uv.project({ mode: 'box', scale: 1, channel: 'uv1' });
    return m.finish({ key: 'decal' });
  },
});
`;
// A build that outlasts a short capture budget.
const SLOW = `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { model } from '@forgeax/engine-modeling';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000a0e4'),
  build() {
    const until = Date.now() + 2500;
    while (Date.now() < until) {}
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'shell' });
    m.uv.project({ mode: 'box', scale: 1 });
    return m.finish({ key: 'slow' });
  },
});
`;

const OPEN = `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { model, sel } from '@forgeax/engine-modeling';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000a0e3'),
  build() {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'shell' });
    m.uv.project({ mode: 'box', scale: 1 });
    m.extrude(sel.facing('+y'), { distance: 0.2, region: 'merged', label: 'lip' });
    m.uv.project({ mode: 'planar', axis: 'y', scale: 1, faces: sel.createdBy('lip', 'side') });
    return m.finish({ key: 'open' });
  },
});
`;

beforeAll(async () => {
  directory = await mkdtemp(join(root, '.isolation-tools-'));
  await writeFile(join(directory, 'crate.pack.ts'), PACK);
  await writeFile(join(directory, 'radio.pack.ts'), PARTS(false));
  await writeFile(join(directory, 'twin.pack.ts'), PARTS(true));
  await writeFile(join(directory, 'broken.pack.ts'), BROKEN);
  broken = relative(root, join(directory, 'broken.pack.ts'));
  await writeFile(join(directory, 'open.pack.ts'), OPEN);
  source = relative(root, join(directory, 'crate.pack.ts'));
  parts = relative(root, join(directory, 'radio.pack.ts'));
  ambiguous = relative(root, join(directory, 'twin.pack.ts'));
  open = relative(root, join(directory, 'open.pack.ts'));
  await writeFile(join(directory, 'slow.pack.ts'), SLOW);
  await writeFile(join(directory, 'rigged.pack.ts'), RIGGED);
  rigged = relative(root, join(directory, 'rigged.pack.ts'));
  await writeFile(join(directory, 'decal.pack.ts'), DECAL);
  slow = relative(root, join(directory, 'slow.pack.ts'));
  await writeFile(join(directory, 'uvless.pack.ts'), UVLESS);
  uvless = relative(root, join(directory, 'uvless.pack.ts'));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function tools(timeoutMs?: number) {
  const byId = new Map(
    createModelingTools({
      projectRoot: root,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }).map((t) => [t.descriptor.id, t]),
  );
  return (id: string, args: Record<string, unknown>) => {
    const contribution = byId.get(id);
    if (contribution === undefined) throw new Error(id);
    return contribution.execute(args as never, {} as never) as Promise<{
      ok: boolean;
      value?: Record<string, unknown>;
      error?: { code: string };
    }>;
  };
}

describe('model.* tools', () => {
  it('derive CLI paths from their operation ids', () => {
    const contributions = createModelingTools({ projectRoot: root });
    expect(contributions.map((t) => t.descriptor.id)).toEqual([...MODELING_OPERATION_IDS]);
    expect(contributions.map((t) => t.descriptor.path?.join(' '))).toEqual([
      'model inspect',
      'model select',
      'model validate',
      'model overlay',
      'model history',
      'model diff',
      'model pose',
      'model interference',
      'model synthesize',
      'model bake',
    ]);
  });

  it('inspect re-runs the build in a capture Worker and reports sessions', {
    timeout: 60000,
  }, async () => {
    const result = await tools()('model.inspect', { source, values: { height: 2 } });
    expect(result.ok).toBe(true);
    const value = result.value as {
      build: { ok: boolean; outputs: string[] };
      sessions: {
        faces: number;
        tags: string[];
        checkpoints: { name: string; opIndex: number; faces: number; source?: unknown }[];
        labels: unknown[];
        operations: number;
      }[];
    };
    expect(value.build).toEqual({ ok: true, outputs: ['mesh/crate'] });
    expect(value.sessions).toHaveLength(1);
    expect(value.sessions[0]?.faces).toBe(10);
    expect(value.sessions[0]?.tags).toEqual(['shell']);
    expect(value.sessions[0]?.checkpoints).toEqual([
      {
        name: 'box',
        opIndex: 1,
        faces: 6,
        vertices: 8,
        source: { path: `${directory.slice(root.length)}/crate.pack.ts`, line: 10, column: 7 },
      },
    ]);
    expect(value.sessions[0]?.operations).toBe(4);
    expect(value.sessions[0]?.labels).toEqual([{ label: 'panel', roles: { inner: 1, rim: 4 } }]);
  });

  it('select evaluates a sel.* expression, also at a checkpoint', { timeout: 60000 }, async () => {
    const call = tools();
    const final = await call('model.select', { source, selector: "sel.createdBy('panel', 'rim')" });
    expect(final.value?.selected).toMatchObject({ domain: 'face', count: 4 });
    const atBox = await call('model.select', { source, selector: 'sel.all()', checkpoint: 'box' });
    expect(atBox.value?.selected).toMatchObject({ count: 6, checkpoint: 'box' });
    const bad = await call('model.select', { source, selector: 'process.exit(1)' });
    expect(bad.ok).toBe(false);
  });

  it('only validate pays for exact validation; every report carries capture timing', {
    timeout: 60000,
  }, async () => {
    const inspected = await runCapture({ sourcePath: join(directory, 'crate.pack.ts') });
    if (!inspected.ok) throw new Error(inspected.error.code);
    expect(inspected.value.sessions.every((s) => s.validation === undefined)).toBe(true);
    expect(inspected.value.timing.validateMs).toBe(0);
    expect(inspected.value.timing.totalMs).toBeGreaterThanOrEqual(inspected.value.timing.buildMs);
    const validated = await runCapture({
      sourcePath: join(directory, 'crate.pack.ts'),
      validate: {},
    });
    if (!validated.ok) throw new Error(validated.error.code);
    expect(validated.value.sessions.every((s) => s.validation !== undefined)).toBe(true);
    expect(validated.value.timing.validateMs).toBeGreaterThan(0);
    const tool = await tools()('model.inspect', { source });
    expect(tool.value?.timing).toMatchObject({ validateMs: 0 });
  });

  it('validate returns the versioned report its schema admits', { timeout: 60000 }, async () => {
    const result = await tools()('model.validate', { source, values: { height: 2 } });
    expect(result.ok).toBe(true);
    expect(toolJsonSchema(MODEL_VALIDATE_REPORT_SCHEMA).parse(result.value).ok).toBe(true);
    const report = result.value as {
      schema: string;
      status: string;
      values: unknown;
      sessions: { status: string; mesh: { closed: boolean; volume: number } }[];
    };
    expect(report).toMatchObject({ schema: 'forgeax.model.validate/2', status: 'pass' });
    expect(report.values).toEqual({ height: 2 });
    expect(report.sessions[0]?.mesh.closed).toBe(true);
    expect(report.sessions[0]?.mesh.volume).toBeCloseTo(2, 9);
  });

  it('validate locates issues whose detail counts faces without reading dead slots (B11 D2)', {
    timeout: 60000,
  }, async () => {
    const result = await tools()('model.validate', { source: uvless });
    expect(result.ok).toBe(true);
    const report = result.value as {
      sessions: { issues: { code: string; location: { faces?: number[] } }[] }[];
    };
    const issue = report.sessions[0]?.issues.find((i) => i.code === 'uv-missing');
    expect(issue).toBeDefined();
    expect(issue?.location.faces).toBeUndefined();
  });

  it('validate runs the opt-in thickness and unique-UV checks only when asked', {
    timeout: 60000,
  }, async () => {
    const codes = async (args: Record<string, unknown>) => {
      const result = await tools()('model.validate', { source, ...args });
      expect(toolJsonSchema(MODEL_VALIDATE_REPORT_SCHEMA).parse(result.value).ok).toBe(true);
      const report = result.value as { sessions: { issues: { code: string }[] }[] };
      return new Set(report.sessions[0]?.issues.map((issue) => issue.code));
    };
    const plain = await codes({});
    expect(plain.has('thin-wall') || plain.has('uv-overlap')).toBe(false);
    const checked = await codes({ minThickness: 2, uniqueUv: true });
    expect(checked.has('thin-wall')).toBe(true);
    expect(checked.has('uv-overlap')).toBe(true);
    // Flat export normals make every edge hard; the fixture's continuous uv0 crosses them.
    expect(plain.has('bake')).toBe(false);
    expect((await codes({ bake: { normals: { mode: 'flat' } } })).has('bake')).toBe(true);
  });

  it('validate locates issues on faces and on the source line that created them', {
    timeout: 60000,
  }, async () => {
    const result = await tools()('model.validate', { source: open });
    const report = result.value as {
      status: string;
      sessions: {
        issues: {
          code: string;
          certainty: string;
          location: { faces?: number[]; point?: number[]; createdBy?: unknown; source?: unknown };
        }[];
      }[];
    };
    const uv = report.sessions[0]?.issues.find((issue) => issue.code === 'uv-degenerate');
    expect(uv?.certainty).toBe('confirmed');
    expect(uv?.location.faces?.length).toBeGreaterThan(0);
    expect(uv?.location.point).toHaveLength(3);
    expect(uv?.location.createdBy).toEqual({ label: 'lip', role: 'side' });
    expect(uv?.location.source).toEqual({
      path: `${directory.slice(root.length)}/open.pack.ts`,
      line: 10,
      column: 7,
    });
    expect(report.status).toBe('warn');
  });

  it('history lists every operation with arguments and source lines', {
    timeout: 60000,
  }, async () => {
    const result = await tools()('model.history', { source });
    const sessions = result.value?.sessions as {
      steps: {
        op: string;
        label?: string;
        args: unknown;
        source?: { line: number };
        faces: number;
      }[];
      checkpoints: { name: string }[];
    }[];
    const steps = sessions[0]?.steps ?? [];
    expect(steps.map((step) => [step.op, step.source?.line])).toEqual([
      ['box', 9],
      ['inset', 11],
      ['markSharp', 12],
      ['uv.project', 13],
    ]);
    expect(steps[1]).toMatchObject({
      label: 'panel',
      faces: 10,
      args: { selector: 'facing(+y, 1)', thickness: 0.1, region: 'merged', label: 'panel' },
    });
    expect(sessions[0]?.checkpoints.map((c) => c.name)).toEqual(['box']);
  });

  it('render exports the target state with the selection in the highlight slot', {
    timeout: 60000,
  }, async () => {
    const response = await runCapture({
      sourcePath: join(directory, 'crate.pack.ts'),
      render: true,
      selector: "sel.createdBy('panel', 'rim')",
      overlays: ['sharp', 'tags'],
    });
    if (!response.ok) throw new Error(response.error.code);
    const render = response.value.render;
    expect(render?.mesh.materialSlots.map((slot) => slot.slotName)).toEqual([
      'Default',
      'highlight',
    ]);
    expect(render?.mesh.attributes.position).toBeInstanceOf(Float32Array);
    expect(render).toMatchObject({ session: 0, faces: 10, uvProjected: false });
    expect(response.value.overlays?.map((o) => o.kind)).toEqual(['sharp', 'tags']);
    const atBox = await runCapture({
      sourcePath: join(directory, 'crate.pack.ts'),
      render: true,
      checkpoint: 'box',
    });
    if (!atBox.ok) throw new Error(atBox.error.code);
    expect(atBox.value.render).toMatchObject({ checkpoint: 'box', faces: 6, uvProjected: true });
    // A checkpoint between UV writes: uv0 complete, uv1 on the top face only.
    const decal = await runCapture({
      sourcePath: join(directory, 'decal.pack.ts'),
      render: true,
      checkpoint: 'decal',
    });
    if (!decal.ok) throw new Error(decal.error.code);
    expect(decal.value.render).toMatchObject({ checkpoint: 'decal', faces: 6, uvProjected: true });
  });

  it('overlay returns preview geometry with a legend', { timeout: 60000 }, async () => {
    const result = await tools()('model.overlay', { source, overlay: 'sharp' });
    const overlay = result.value?.overlay as {
      topology: string;
      positions: number[];
      colors: number[];
    };
    expect(overlay.topology).toBe('line-list');
    expect(overlay.positions.length / 6).toBe(12);
    expect(overlay.colors.length / 4).toBe(overlay.positions.length / 3);
  });

  it('select and overlay default to the session that produced the output', {
    timeout: 60000,
  }, async () => {
    const call = tools();
    const inspected = await call('model.inspect', { source: parts });
    const sessions = inspected.value?.sessions as { index: number; output?: string }[];
    expect(sessions.map((s) => s.output ?? null)).toEqual([null, 'mesh/radio']);
    const selected = await call('model.select', { source: parts, selector: "sel.tag('body')" });
    expect(selected.value?.selected).toMatchObject({ session: 1, count: 6 });
    const helper = await call('model.select', {
      source: parts,
      session: 0,
      selector: "sel.tag('knob')",
    });
    expect(helper.value?.selected).toMatchObject({ session: 0, count: 8 });
    const overlay = await call('model.overlay', { source: parts, overlay: 'tags' });
    expect(overlay.value?.session).toBe(1);
    const unclear = await call('model.select', { source: ambiguous, selector: 'sel.all()' });
    expect(unclear.error?.code).toBe('tool-invalid-args');
    expect((unclear.error as { detail?: unknown }).detail).toEqual({
      sessions: [
        { index: 0, output: 'mesh/knob', faces: 8 },
        { index: 1, output: 'mesh/radio', faces: 14 },
      ],
    });
  });

  it('a failed build does not default to a helper that finished (review N7)', {
    timeout: 60000,
  }, async () => {
    const call = tools();
    const unclear = await call('model.select', { source: broken, selector: 'sel.all()' });
    expect(unclear.error?.code).toBe('tool-invalid-args');
    const named = await call('model.select', { source: broken, selector: 'sel.all()', session: 1 });
    expect(named.value?.selected).toMatchObject({ session: 1, count: 6 });
    const fractional = await call('model.select', {
      source: broken,
      selector: 'sel.all()',
      session: 0.5,
    });
    expect(fractional.ok).toBe(false);
  });

  it('sizes the capture heap per call and reports exhaustion as a work budget', {
    timeout: 120000,
  }, async () => {
    expect(defaultCaptureHeapMb()).toBeGreaterThanOrEqual(1024);
    const hog = join(directory, 'hog.pack.ts');
    await writeFile(
      hog,
      `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000a0e9'),
  build() {
    const held: number[][] = [];
    for (let i = 0; i < 4096; i++) held.push(new Array(1 << 16).fill(i));
    return { ok: true, value: { 'mesh/none': held.length } };
  },
});
`,
    );
    const starved = await runCapture({ sourcePath: hog, heapMb: 256 });
    expect(starved.ok).toBe(false);
    if (!starved.ok)
      expect(starved.error).toMatchObject({ code: 'model-work-budget', detail: { heapMb: 256 } });
    const caller = join(directory, 'heap-caller.mjs');
    await writeFile(
      caller,
      `
import { runCapture } from ${JSON.stringify(new URL('../../dist/tools/index.mjs', import.meta.url).href)};
const good = await runCapture({ sourcePath: ${JSON.stringify(join(root, source))}, heapMb: 256 });
const bad = await runCapture({ sourcePath: ${JSON.stringify(hog)}, heapMb: 256 });
process.stdout.write(JSON.stringify({ good: good.ok, goodError: good.ok ? undefined : good.error, bad }));
`,
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--max-old-space-size=4096', caller],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: process.allowedNodeEnvironmentFlags.has('--max-old-space-size-percentage')
            ? '--max-old-space-size-percentage=90'
            : '--max-old-space-size=8192',
        },
      },
    );
    const inherited = JSON.parse(stdout);
    expect(inherited.good, JSON.stringify(inherited.goodError)).toBe(true);
    expect(inherited.bad).toMatchObject({
      ok: false,
      error: { code: 'model-work-budget', detail: { heapMb: 256 } },
    });
    const invalid = await tools()('model.inspect', { source, heapMb: 64 });
    expect(invalid.error?.code).toBe('tool-invalid-args');
  });

  it('rejects sources outside the project', async () => {
    const result = await tools()('model.inspect', { source: '../outside.pack.ts' });
    expect(result.error?.code).toBe('tool-invalid-args');
  });

  it('timeoutMs bounds each rebuild of one call', { timeout: 60000 }, async () => {
    const call = tools(1000);
    const short = await call('model.inspect', { source: slow });
    expect(short.error).toMatchObject({
      code: 'model-work-budget',
      expected: 'the capture finishes within 1000 ms',
    });
    const raised = await call('model.inspect', { source: slow, timeoutMs: 30000 });
    expect(raised.ok).toBe(true);
    const diff = await call('model.diff', { source: slow, against: {}, timeoutMs: 1000 });
    expect(diff.error?.code).toBe('model-work-budget');
    for (const timeoutMs of [999, 600001, 1500.5]) {
      const rejected = await call('model.inspect', { source: slow, timeoutMs });
      expect(rejected.error?.code).toBe('tool-invalid-args');
    }
    const synthesize = createModelingTools({ projectRoot: root }).find(
      (t) => t.descriptor.id === 'model.synthesize',
    );
    expect(
      (synthesize?.descriptor.inputSchema as { properties?: Record<string, unknown> }).properties
        ?.timeoutMs,
    ).toBeDefined();
  });

  it("a rig's scene marks its source session as the output session", {
    timeout: 60000,
  }, async () => {
    const call = tools();
    const inspected = await call('model.inspect', { source: rigged });
    const sessions = (inspected.value as { sessions: { index: number; output?: string }[] })
      .sessions;
    expect(sessions.map((s) => s.output ?? null)).toEqual([null, 'scene/rigged']);
    const selected = await call('model.select', { source: rigged, selector: "sel.tag('body')" });
    expect(selected.value?.selected).toMatchObject({ session: 1, count: 6 });
  });
});
