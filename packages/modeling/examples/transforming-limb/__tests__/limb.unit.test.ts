import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import type { AnimationClip, MeshAsset, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { buildLimb, LIMB_CONTACTS, LIMB_DEFAULTS, LIMB_PARTS, limbPath, limbRig } from '../limb';

const m = buildLimb();
const r = limbRig(m);

describe('C-107 transforming limb', () => {
  it('builds seven closed rigid parts on seven joints', () => {
    expect(m.poisoned).toBeUndefined();
    const parts = r.parts();
    if (!parts.ok) throw parts.error;
    expect(parts.value.map((p) => p.name)).toEqual([...LIMB_PARTS]);
    expect(parts.value.every((p) => p.closed)).toBe(true);
    expect(r.joints.map((j) => j.kind)).toEqual(['fixed', 'revolute', 'revolute', 'revolute', 'revolute', 'prismatic', 'revolute']);
  });

  it('transforms from car to robot without a contact, within every joint limit', { timeout: 120000 }, () => {
    const scan = r.scan(limbPath(), { contacts: LIMB_CONTACTS });
    if (!scan.ok) throw scan.error;
    expect(scan.value.pass).toBe(true);
    expect(scan.value.pairs).toEqual([]);
    expect(scan.value.clamped).toEqual([]);
    expect(scan.value.samples.map((s) => s.u)).toContain(0.35);
    expect(scan.value.evaluated).toBeGreaterThan(scan.value.samples.length);
  });

  it('catches the first design: an upper-arm beam over the elbow meets the forearm web', { timeout: 120000 }, () => {
    const first = limbRig(buildLimb({ ...LIMB_DEFAULTS, beamEnd: 0.45 }));
    const scan = first.scan(limbPath(), { contacts: LIMB_CONTACTS });
    if (!scan.ok) throw scan.error;
    expect(scan.value.pass).toBe(false);
    expect(scan.value.pairs.map((p) => [p.parts, p.status])).toEqual([[['forearm', 'upper-arm'], 'confirmed']]);
    // Fixed 0.05 samples first see it at u = 0.8; travel subdivision finds the real start,
    // where the web clips the beam's end corner at elbow -111.6 degrees.
    const pair = scan.value.pairs[0];
    expect(pair?.firstContact).toBeGreaterThan(0.685);
    expect(pair?.firstConfirmed).toBeLessThan(0.692);
    expect(pair?.maxDepth).toBeGreaterThan(0.015);
  });

  it('keeps one part set in both forms', () => {
    const car = r.toMesh();
    const robotPose = r.sample(limbPath(), 1);
    if (!robotPose.ok) throw robotPose.error;
    const robot = r.toMesh(robotPose.value);
    if (!car.ok || !robot.ok) throw new Error('export');
    expect(robot.value.report.triangles).toBe(car.value.report.triangles);
    expect(robot.value.report.materialSlots).toEqual(car.value.report.materialSlots);
    expect(robot.value.pose.clamped).toEqual([]);
    const height = (mesh: MeshAsset) => ((mesh.aabb as Float32Array)[4] as number) - ((mesh.aabb as Float32Array)[1] as number);
    expect(height(robot.value.mesh)).toBeGreaterThan(height(car.value.mesh) * 1.4);
  });

  it('exports part meshes, the joint scene and the transformation clip', () => {
    const id = PackageId.parse('01900000-0000-7000-8000-0000000c0107');
    if (!id.ok) throw id.error;
    const out = r.finish({ key: 'limb', packageId: id.value, path: limbPath(), duration: 6 });
    if (!out.ok) throw out.error;
    expect(Object.keys(out.value).filter((k) => k.startsWith('mesh/'))).toHaveLength(LIMB_PARTS.length);
    const scene = out.value['scene/limb'] as SceneAsset;
    expect(Object.keys(scene.entities)).toHaveLength(1 + 7 + LIMB_PARTS.length);
    const clip = out.value['animation-clip/limb'] as AnimationClip;
    expect(clip.duration).toBe(6);
    // Six moving joints: five rotate, the telescope translates.
    expect(clip.channels.map((c) => c.property).sort()).toEqual(['rotation', 'rotation', 'rotation', 'rotation', 'rotation', 'translation']);
    expect(scene.entities.rig?.components.AnimationPlayer).toMatchObject({
      clips: [AssetGuid.format(AssetGuid.derive(id.value, 'animation-clip/limb'))],
    });
  });
});
