import { describe, expect, it } from 'vitest';
import { captureModels } from '../capture';
import { projectOverlay } from '../diagnostics';
import { decodeSnapshot } from '../fxem';
import { model } from '../model';
import { sel } from '../selectors';

function build() {
  const m = model();
  m.box({ size: [1, 1, 1], tag: 'body' });
  m.checkpoint('box');
  m.inset(sel.facing('+y'), { thickness: 0.1, region: 'merged', label: 'panel' });
  m.checkpoint('panel');
  m.markSharp(sel.edges.dihedral('>', 40));
  m.uv.project({ mode: 'box', scale: 1 });
  return m;
}

describe('diagnostic companion', () => {
  it('checkpoints are free outside a capture', () => {
    const m = build();
    expect(m.diagnostics().checkpoints).toEqual([]);
    expect(m.diagnostics().provenance).toBeUndefined();
  });

  it('a capture collects sessions, checkpoint snapshots and export provenance', async () => {
    const captured = await captureModels(() => {
      const m = build();
      const out = m.finish({ key: 'crate' });
      return out.ok;
    });
    if (!captured.ok) throw captured.error;
    expect(captured.value.value).toBe(true);
    expect(captured.value.sessions).toHaveLength(1);
    const diagnostics = captured.value.sessions[0]?.diagnostics();
    expect(diagnostics?.checkpoints.map((c) => [c.name, c.opIndex])).toEqual([
      ['box', 1],
      ['panel', 2],
    ]);
    const first = decodeSnapshot(diagnostics?.checkpoints[0]?.snapshot ?? new Uint8Array());
    expect(first.ok && first.value.faceCount).toBe(6);
    expect(diagnostics?.provenance?.triangleFace.length).toBe(20);
    expect(diagnostics?.validation.closed).toBe(true);
  });

  it('journal sources name the author line, also where stack frames are plain paths', async () => {
    // Vitest reports frames as plain paths and the kernel's own URL as file://.
    const captured = await captureModels(() => build());
    if (!captured.ok) throw captured.error;
    const journal = captured.value.sessions[0]?.journal ?? [];
    expect(journal[0]?.source?.path).toMatch(/diagnostics\.unit\.test\.ts$/);
    expect(journal.map((e) => e.source?.line)).toEqual([10, 12, 14, 15]);
  });

  it('a capture sees sessions made by a second kernel instance in the same realm', async () => {
    // Bundlers can load the kernel twice (a program-scoped copy and a shared one): the
    // built package is a second instance beside these source modules.
    const built = (await import('@forgeax/engine-modeling')) as {
      captureModels: typeof captureModels;
    };
    expect(built.captureModels).not.toBe(captureModels);
    const captured = await built.captureModels(() => build());
    if (!captured.ok) throw captured.error;
    expect(captured.value.sessions).toHaveLength(1);
  });

  it('captures are single-flight and end with their body', async () => {
    const outer = await captureModels(async () => {
      const inner = await captureModels(() => 1);
      return inner.ok;
    });
    expect(outer.ok && outer.value.value).toBe(false);
    const after = model();
    after.checkpoint('outside');
    expect(after.diagnostics().checkpoints).toEqual([]);
  });
});

describe('overlay projection', () => {
  it('tags, roles and element ids become vertex-colored triangles with a legend', () => {
    const mesh = build().editMesh;
    const tags = projectOverlay(mesh, 'tags');
    if (!tags.ok) throw tags.error;
    expect(tags.value.legend.map((l) => [l.label, l.faces])).toEqual([['body', 10]]);
    expect(tags.value.mesh.attributes.color).toBeDefined();
    const roles = projectOverlay(mesh, 'roles');
    if (!roles.ok) throw roles.error;
    expect(roles.value.legend.map((l) => [l.label, l.faces])).toEqual([
      ['panel.inner', 1],
      ['panel.rim', 4],
      ['(none)', 5],
    ]);
    const ids = projectOverlay(mesh, 'elementIds');
    expect(ids.ok && ids.value.legend).toHaveLength(10);
  });

  it('face overlays sit just above their faces so they do not depth-fight the subject', () => {
    const m = model();
    m.box({ size: [2, 2, 2], tag: 'shell' });
    const tags = projectOverlay(m.editMesh, 'tags');
    if (!tags.ok) throw tags.error;
    const positions = tags.value.mesh.attributes.position as Float32Array;
    const lift = Math.hypot(2, 2, 2) * 1e-3;
    for (let i = 0; i < positions.length; i += 3) {
      const extent = Math.max(...[0, 1, 2].map((k) => Math.abs(positions[i + k] as number)));
      expect(extent).toBeCloseTo(1 + lift, 5);
    }
  });

  it('sharp edges and normals become line lists; missing intent is reported', () => {
    const mesh = build().editMesh;
    const sharp = projectOverlay(mesh, 'sharp');
    if (!sharp.ok) throw sharp.error;
    expect(sharp.value.mesh.submeshes[0]?.topology).toBe('line-list');
    expect(sharp.value.legend[0]?.faces).toBe(12);
    const normals = projectOverlay(mesh, 'normals');
    expect(normals.ok && normals.value.legend[0]?.faces).toBe(10);
    const seams = projectOverlay(mesh, 'seams');
    expect(!seams.ok && seams.error.code).toBe('model-selection-empty');
  });
});
