import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureRequest, type RenderPayload, runCapture } from '@forgeax/engine-modeling/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
let directory = '';

// A hollow tube (nested section outlines), a lid and a pin: three tagged parts.
const PACK = `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { type Drawing, model, sel } from '@forgeax/engine-modeling';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000a0e9'),
  build() {
    const m = model();
    const sheet: Drawing = {
      name: 'tube sheet',
      views: [{ id: 'front', ortho: 'front' }, { id: 'plan', ortho: 'top' }],
      items: [
        { id: 'outline', view: 'front', role: 'silhouette', kind: 'curve', closed: true, curve: { kind: 'polyline', points: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] } },
        { id: 'base', view: 'front', role: 'package', kind: 'point', at: [0.6, -0.5] },
        { id: 'top', view: 'front', role: 'package', kind: 'point', at: [0.6, 0.5] },
        { id: 'height', view: 'front', role: 'package', kind: 'dimension', measure: 'distance', refs: ['base', 'top'], value: 1, basis: 'estimate' },
        { id: 'lid', view: 'plan', role: 'construction', kind: 'curve', closed: true, curve: { kind: 'spline', points: [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]] }, tolerance: 0.01 },
      ],
    };
    m.drawing(sheet);
    m.cylinder({ radiusTop: 0.5, radiusBottom: 0.5, height: 1, radialSegments: 24, tag: 'tube' });
    m.shell(sel.tag('tube'), { thickness: 0.1, open: sel.tag('tube').and(sel.facing('+y')) });
    m.extrudeContour(sheet, 'lid', { depth: [0.7, 0.8], tag: 'lid' });
    m.box({ size: [0.1, 0.1, 0.4], center: [0, 0.2, 0.75], tag: 'pin' });
    m.uv.project({ mode: 'box', scale: 1 });
    return m.finish({ key: 'tube' });
  },
});
`;

beforeAll(async () => {
  directory = await mkdtemp(join(root, '.drawing-tools-'));
  await writeFile(join(directory, 'tube.pack.ts'), PACK);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function capture(extra: Record<string, unknown>) {
  const request = captureRequest(directory, { source: 'tube.pack.ts' });
  if ('ok' in request) throw new Error(JSON.stringify(request.error));
  return runCapture({ ...request, render: true, ...extra });
}

function render(response: Awaited<ReturnType<typeof capture>>): RenderPayload {
  if (!response.ok) throw new Error(JSON.stringify(response.error));
  return response.value.render as RenderPayload;
}

// Each test runs several capture Workers in sequence; a loaded runner needs more than 5 s.
describe('engineering views through the capture Worker', { timeout: 60_000 }, () => {
  it('carries the design drawing and contours with every render', async () => {
    const payload = render(await capture({}));
    expect(payload.drawing.drawings[0]?.curves[0]?.view).toBe('front');
    expect(payload.drawing.drawings[0]?.dimensions[0]?.to).toEqual([0.6, 0.5]);
    expect(payload.drawing.contours.map((c) => c.view)).toEqual(['top']);
  });

  it('sections a hollow part with an even-odd cap', async () => {
    const payload = render(await capture({ section: { point: [0, 0, 0], normal: [0, 0, 1] } }));
    const section = payload.section;
    if (section === undefined) throw new Error('no section');
    // The tube's U-shaped wall (about 1 x 1 - 0.8 x 0.9) plus the lid's slab (about
    // 0.6 x 0.1); filling the hole would add about 0.72 m2.
    expect(section.area).toBeGreaterThan(0.28);
    expect(section.area).toBeLessThan(0.45);
    expect(section.hatch.length).toBeGreaterThan(0);
    expect(payload.bounds[5]).toBeLessThanOrEqual(1e-6);
    const missed = await capture({ section: { point: [0, 0, 9], normal: [0, 0, 1] } });
    expect(missed.ok ? '' : missed.error.code).toBe('model-op-no-effect');
  });

  it('explodes tagged parts and marks the X-ray shell', async () => {
    const exploded = render(await capture({ explode: { by: 'tag', distance: 0.4 } }));
    expect(exploded.explode?.parts.map((p) => p.name)).toEqual(['lid', 'pin', 'tube']);
    const stepped = render(
      await capture({ explode: { by: 'tag', distance: 0.4, order: [['pin'], ['lid']] } }),
    );
    const steps = Object.fromEntries((stepped.explode?.parts ?? []).map((p) => [p.name, p.order]));
    expect(steps).toEqual({ lid: 2, pin: 1, tube: 0 });
    const xray = render(await capture({ xray: "sel.tag('tube')" }));
    expect(xray.xray?.faces).toBeGreaterThan(0);
    expect(xray.mesh.materialSlots.map((s) => s.slotName)).toContain('xray');
    const both = await capture({
      explode: { by: 'tag', distance: 1 },
      section: { point: [0, 0, 0], normal: [0, 0, 1] },
    });
    expect(both.ok ? '' : both.error.code).toBe('tool-invalid-args');
  });

  it('replays the build step by step', { timeout: 60000 }, async () => {
    const response = await capture({ render: false, replay: [1, 2, 3, 4] });
    if (!response.ok) throw new Error(JSON.stringify(response.error));
    const replay = response.value.replay;
    expect(replay?.operations).toBe(6);
    expect(replay?.frames.map((f) => f.op)).toEqual(['cylinder', 'shell', 'extrudeContour', 'box']);
    const faces = replay?.frames.map((f) => f.faces) ?? [];
    expect(faces[1]).toBeGreaterThan(faces[0] as number);
    expect(replay?.frames[0]?.source?.line).toBeGreaterThan(0);
    const step = render(await capture({ step: 1 }));
    expect(step.faces).toBe(faces[0]);
    const before = await capture({ step: 0 });
    expect(before.ok ? '' : before.error.code).toBe('model-selection-empty');
    const all = await capture({ render: false, replay: 'all' });
    expect(all.ok && all.value.replay?.frames.map((f) => f.opIndex)).toEqual([1, 2, 3, 4, 5]);
    const out = await capture({ render: false, replay: [99] });
    expect(out.ok ? '' : out.error.code).toBe('model-selection-empty');
  });
});
