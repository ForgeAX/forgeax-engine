import { fileURLToPath } from 'node:url';
import { bakeMaps, createBakeCooker, type Model, model, type Rig } from '@forgeax/engine-modeling';
import { PackageId } from '@forgeax/engine-pack/guid';
import { executePackBuild } from '@forgeax/engine-pack/source';
import { skinVertexPosition } from '@forgeax/engine-skinning';
import type { MeshAsset, SkeletonAsset, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import pack from '../actuator.pack';
import { ACTUATOR_DEFAULTS, actuatorBake, actuatorFrame, actuatorPath, actuatorRig, buildActuatorDetail, buildActuatorShell, SHELL_NORMALS } from '../actuator';

const SOURCE = fileURLToPath(new URL('../actuator.ts', import.meta.url));
const SMALL = { ...ACTUATOR_DEFAULTS, resolution: 128 };
const PACKAGE = PackageId.parse('01900000-0000-7000-8000-0000000c0112');
const PORT_CONTACT = [{ parts: ['port', 'ram-barrel'] as [string, string], tolerance: 0.002 }];

/** Column-major 4x4 multiply. */
function mul(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
      out[c * 4 + r] = s;
    }
  return out;
}

/** Row-major 3x4 rigid transform to column-major 4x4. */
function columnMajor(m: readonly number[]): Float32Array {
  return Float32Array.from([m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, m[3], m[7], m[11], 1] as number[]);
}

function triangles(m: Model): number {
  const out = m.toMesh({ normals: SHELL_NORMALS });
  if (!out.ok) throw out.error;
  return out.value.report.triangles;
}

/** Confirmed self-intersecting face pairs of the rig posed at path parameter u. */
function crossings(r: Rig, u: number): number {
  const pose = r.sample(actuatorPath(), u);
  if (!pose.ok) throw pose.error;
  const posed = r.posedSnapshot(pose.value);
  if (!posed.ok) throw posed.error;
  const view = model();
  view.append(posed.value);
  const issue = view.validate().issues.find((i) => i.code === 'self-intersection' && i.detail.certainty === 'confirmed');
  return (issue?.detail.total as number | undefined) ?? 0;
}

describe('C-112 actuator: detail, game-ready shell, bake and automatic weights', () => {
  it('records the detail and the shell; the shell meets its budget and validates clean', { timeout: 300000 }, () => {
    const recording = recordingSessions();
    const detail = buildActuatorDetail(SMALL, recording.session);
    const shell = buildActuatorShell(SMALL, recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE);
    expect(steps.every((s) => s.entry.status === 'ok')).toBe(true);
    expect(new Set(steps.map((s) => s.session))).toEqual(new Set(['detail', 'shell']));
    expect(steps.map((s) => s.entry.op)).toContain('simplify');
    expect(steps.map((s) => s.entry.op)).toContain('uv.auto');
    expect(steps.every((s) => s.line > 0)).toBe(true);

    const shellTriangles = triangles(shell);
    expect(shellTriangles).toBeLessThanOrEqual(SMALL.budget);
    expect(triangles(detail)).toBeGreaterThan(4 * shellTriangles);
    expect(shell.validate({ uniqueUv: true }).issues.filter((i) => i.severity !== 'info')).toEqual([]);
    // The port bosses sit 1 mm into the barrel by design; nothing else crosses.
    const detailIssues = detail.validate({ contacts: PORT_CONTACT }).issues;
    expect(detailIssues.filter((i) => i.severity !== 'info')).toEqual([]);
    expect(detailIssues.some((i) => i.code === 'designed-contact')).toBe(true);
    const labels = shell.inspect().labels.map((l) => l.label);
    for (const label of ['ram-barrel', 'ram-eye', 'ram-rod-eye', 'boot']) expect(labels).toContain(label);
  });

  it('weights the boot between its clamped collars and keeps every pose free of crossings', { timeout: 300000 }, () => {
    const shell = buildActuatorShell(SMALL);
    const r = actuatorRig(shell, SMALL);
    const parts = r.parts();
    if (!parts.ok) throw parts.error;
    expect(parts.value.map((p) => p.name)).toEqual(['barrel', 'rod', 'clamp-low', 'clamp-high']);
    const w = r.weights('boot');
    if (!w.ok) throw w.error;
    expect(w.value.status).toBe('ok');
    const frame = actuatorFrame(SMALL);
    const [gland, rod] = [1, 2];
    const on = (row: number, joint: number) => {
      let s = 0;
      for (let k = 0; k < 4; k++) if (w.value.joints[row * 4 + k] === joint) s += w.value.weights[row * 4 + k] as number;
      return s;
    };
    let pinned = 0;
    for (let row = 0; row < w.value.vertices.length; row++) {
      const y = shell.editMesh.position(w.value.vertices[row] as number)[1];
      expect(on(row, gland) + on(row, rod)).toBeCloseTo(1, 5);
      if (Math.abs(y - (frame.bottom + 0.003)) < 1e-6) {
        expect(on(row, gland)).toBe(1);
        pinned++;
      }
    }
    expect(pinned).toBeGreaterThan(0);
    for (const u of [0, 0.25, 0.5, 0.75, 0.9, 1]) expect(crossings(r, u), `u = ${u}`).toBe(0);
    const scan = r.scan(actuatorPath());
    if (!scan.ok) throw scan.error;
    expect(scan.value.pass).toBe(true);
    // Falsifier: the first design simplified the boot with the rest; its lowest fold crosses itself.
    expect(crossings(actuatorRig(buildActuatorShell(SMALL, undefined, true), SMALL), 1)).toBeGreaterThan(0);
  });

  it('exports a skinned shell that the Engine skinning kernel poses like the rig', { timeout: 300000 }, () => {
    if (!PACKAGE.ok) throw new Error('package id');
    const r = actuatorRig(buildActuatorShell(SMALL), SMALL);
    const out = r.finish({ key: 'actuator', packageId: PACKAGE.value, form: 'skinned', normals: SHELL_NORMALS, path: actuatorPath() });
    if (!out.ok) throw out.error;
    const mesh = out.value['mesh/actuator'] as MeshAsset;
    const skeleton = out.value['skeleton/actuator'] as SkeletonAsset;
    const extended = { rod: 0.09 };
    const posed = r.pose(extended);
    if (!posed.ok) throw posed.error;
    const palette = new Float32Array(skeleton.jointCount * 16);
    for (const [j, joint] of posed.value.joints.entries()) {
      palette.set(mul(columnMajor(joint.world as unknown as number[]), skeleton.inverseBindMatrices.subarray(j * 16, j * 16 + 16)), j * 16);
    }
    const expected = r.toMesh(extended, { normals: SHELL_NORMALS });
    if (!expected.ok) throw expected.error;
    const positions = mesh.attributes.position as Float32Array;
    const target = expected.value.mesh.attributes.position as Float32Array;
    expect(target.length).toBe(positions.length);
    const xyzw = new Float64Array(4);
    const skinned: number[] = [];
    for (let v = 0; v < positions.length / 3; v++) {
      expect(skinVertexPosition(xyzw, positions, mesh.attributes.skinIndex as Uint16Array, mesh.attributes.skinWeight as Float32Array, palette, v)).toBe(true);
      for (let k = 0; k < 3; k++) skinned.push((xyzw[k] as number) / (xyzw[3] as number));
    }
    // Exports number vertices canonically from positions, so compare the point sets.
    const nearest = (from: ArrayLike<number>, to: ArrayLike<number>) => {
      let far = 0;
      for (let i = 0; i < from.length; i += 3) {
        let best = Infinity;
        for (let j = 0; j < to.length; j += 3) {
          const d = Math.abs((from[i] as number) - (to[j] as number)) + Math.abs((from[i + 1] as number) - (to[j + 1] as number)) + Math.abs((from[i + 2] as number) - (to[j + 2] as number));
          if (d < best) best = d;
        }
        far = Math.max(far, best);
      }
      return far;
    };
    expect(Math.max(nearest(skinned, target), nearest(target, skinned))).toBeLessThan(1e-5);
  });

  it('bakes ports, grooves and bolts into the shell maps; the shell onto itself bakes none (falsifier)', { timeout: 300000 }, () => {
    const shell = buildActuatorShell(SMALL);
    const baked = bakeMaps({ base: shell, detail: buildActuatorDetail(SMALL), ...actuatorBake(SMALL) });
    if (!baked.ok) throw baked.error;
    expect(baked.value.report.metrics.rayHitRatio).toBeGreaterThan(0.97);
    const self = bakeMaps({ base: shell, detail: shell, ...actuatorBake(SMALL) });
    if (!self.ok) throw self.error;
    const count = (bake: typeof baked.value) => {
      const normal = bake.textures.normal?.data as Uint8Array;
      const ao = bake.textures.ao?.data as Uint8Array;
      let tilted = 0;
      let occluded = 0;
      for (let i = 0; i < 128 * 128; i++) {
        if ((normal[i * 4 + 2] as number) < 245) tilted++;
        if ((ao[i * 4] as number) < 200) occluded++;
      }
      return { tilted, occluded };
    };
    const detail = count(baked.value);
    const flat = count(self.value);
    expect(detail.tilted).toBeGreaterThan(4 * Math.max(1, flat.tilted));
    expect(detail.occluded).toBeGreaterThan(flat.occluded);
  });

  it('the Pack exports the skinned shell, the detail and the baked maps as modeling-bake cook sources', { timeout: 300000 }, async () => {
    const built = await executePackBuild(pack, {
      packageId: pack.packageId,
      readByGuid: async () => {
        throw new Error('no reads expected');
      },
      values: { stroke: 0.12, rest: 0.25, folds: 8, budget: 1500, resolution: 64 },
    });
    if (!built.ok) throw built.error;
    const outputs = built.value as Record<string, { kind: string; execution?: string; source?: unknown }>;
    expect(Object.keys(outputs).sort()).toEqual([
      'animation-clip/actuator',
      'material/actuator-paint',
      'material/actuator-rubber',
      'material/actuator-steel',
      'mesh/actuator',
      'mesh/actuator-detail',
      'scene/actuator',
      'skeleton/actuator',
      'skin/actuator',
      'texture/actuator-ao',
      'texture/actuator-normal',
    ]);
    expect(outputs['texture/actuator-normal']).toMatchObject({ kind: 'modeling-bake', execution: 'cooked' });
    const draft = await createBakeCooker().cook({
      guid: '01900000-0000-7000-8000-00000c011201',
      source: JSON.parse(JSON.stringify(outputs['texture/actuator-ao']?.source)),
    });
    const texture = draft.payload as TextureAsset;
    expect(texture.kind).toBe('texture');
    expect(texture.shape.extent).toEqual({ width: 64, height: 64 });
  });
});
