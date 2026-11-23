import { AnimationPlayer, AnimationTargetId } from '@forgeax/engine/animation';
import { model, rig, sel } from '@forgeax/engine/modeling';
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { ChildOf, Name, Transform } from '@forgeax/engine/scene';
import { Skin } from '@forgeax/engine/skinning';
import { type MaterialAsset, ok } from '@forgeax/engine/types';

type Point = [number, number, number];

export const wildlifePackageId = 'b890ecd5-55e4-4eea-9f93-0bc7774a9fce';
const surfaces = { fur: '#a8673d', throat: '#dec278', dark: '#51362a', antler: '#d6c5a2' };

function skinMaterial(color: string): MaterialAsset {
  const material = Materials.standard({ baseColor: color, roughness: 0.88 });
  if (material.passes === undefined)
    throw Error('Pine Basin wildlife requires a Standard material');
  const [first, ...rest] = material.passes;
  const skin = (pass: typeof first) =>
    pass.name === 'shadow-caster'
      ? pass
      : { ...pass, program: { ...pass.program, module: 'forgeax::pbr-skin' } };
  return { ...material, passes: [skin(first), ...rest.map(skin)] };
}

function deer(packageId: ReturnType<typeof definePackageId>) {
  const mesh = model();
  const ellipsoid = (name: string, at: Point, size: Point, material: keyof typeof surfaces) => {
    mesh.sphere({
      radius: 1,
      widthSegments: 8,
      heightSegments: 5,
      center: at,
      tag: name,
      material,
    });
    mesh.scale(sel.tag(name), size, at);
  };
  ellipsoid('body', [0, 1.27, -0.01], [0.38, 0.44, 0.95], 'fur');
  ellipsoid('chest', [0, 1.25, 0.47], [0.35, 0.4, 0.42], 'throat');
  ellipsoid('neck', [0, 1.61, 0.6], [0.2, 0.48, 0.25], 'fur');
  ellipsoid('forehead', [0, 2.05, 0.77], [0.2, 0.24, 0.29], 'fur');
  ellipsoid('muzzle', [0, 1.98, 1.03], [0.13, 0.14, 0.22], 'throat');
  ellipsoid('nose', [0, 2.01, 1.21], [0.105, 0.085, 0.08], 'dark');
  ellipsoid('tail', [0, 1.43, -0.97], [0.12, 0.13, 0.22], 'throat');
  for (const side of [-1, 1]) {
    ellipsoid(`ear-${side}`, [side * 0.2, 2.22, 0.64], [0.14, 0.065, 0.18], 'fur');
    ellipsoid(`eye-${side}`, [side * 0.174, 2.083, 0.885], [0.028, 0.04, 0.036], 'dark');
    mesh.box({
      size: [0.036, 0.33, 0.04],
      center: [side * 0.15, 2.35, 0.63],
      tag: `antler-${side}`,
      material: 'antler',
    });
    mesh.box({
      size: [0.14, 0.04, 0.035],
      center: [side * 0.2, 2.42, 0.63],
      tag: `antler-${side}`,
      material: 'antler',
    });
  }

  const legs = [
    { key: 'front-left', x: -0.245, z: 0.53, phase: 1 },
    { key: 'front-right', x: 0.245, z: 0.53, phase: -1 },
    { key: 'rear-left', x: -0.245, z: -0.59, phase: -1 },
    { key: 'rear-right', x: 0.245, z: -0.59, phase: 1 },
  ];
  for (const { key, x, z } of legs) {
    ellipsoid(`${key}-upper`, [x, 0.94, z], [0.105, 0.37, 0.12], 'fur');
    mesh.box({
      size: [0.105, 0.56, 0.11],
      center: [x, 0.33, z],
      tag: `${key}-lower`,
      material: 'dark',
    });
    mesh.box({
      size: [0.14, 0.13, 0.18],
      center: [x, 0.062, z + 0.025],
      tag: `${key}-lower`,
      material: 'dark',
    });
  }
  mesh.uv.project({ mode: 'box', scale: 1 });
  const assembly = rig(mesh, {
    joints: [
      { name: 'body', parent: null, position: [0, 1.27, 0] },
      {
        name: 'neck',
        parent: 'body',
        position: [0, 1.45, 0.6],
        kind: 'revolute',
        axis: 'x',
        limits: [-22, 52],
      },
      {
        name: 'head',
        parent: 'neck',
        position: [0, 2.02, 0.72],
        kind: 'revolute',
        axis: 'x',
        limits: [-22, 20],
      },
      {
        name: 'tail',
        parent: 'body',
        position: [0, 1.48, -0.84],
        kind: 'revolute',
        axis: 'y',
        limits: [-25, 25],
      },
      ...legs.flatMap(({ key, x, z }) => [
        {
          name: `${key}-upper`,
          parent: 'body',
          position: [x, 1.24, z] as Point,
          kind: 'revolute' as const,
          axis: 'x' as const,
          limits: [-36, 36] as [number, number],
        },
        {
          name: `${key}-lower`,
          parent: `${key}-upper`,
          position: [x, 0.62, z] as Point,
          kind: 'revolute' as const,
          axis: 'x' as const,
          limits: [-28, 38] as [number, number],
        },
      ]),
    ],
  });
  assembly.bindRigid(sel.tag('body').or(sel.tag('chest')), 'body');
  assembly.bindAuto(sel.tag('neck'), ['body', 'neck', 'head'], {
    resolution: 24,
    maxInfluences: 3,
  });
  let head = sel.tag('forehead').or(sel.tag('muzzle')).or(sel.tag('nose'));
  for (const side of [-1, 1])
    head = head
      .or(sel.tag(`ear-${side}`))
      .or(sel.tag(`eye-${side}`))
      .or(sel.tag(`antler-${side}`));
  assembly.bindRigid(head, 'head');
  assembly.bindRigid(sel.tag('tail'), 'tail');
  for (const { key } of legs) {
    assembly.bindRigid(sel.tag(`${key}-upper`), `${key}-upper`);
    assembly.bindRigid(sel.tag(`${key}-lower`), `${key}-lower`);
  }

  const walk = [0, 1, 2, 3, 4].map((n) => {
    const swing = [0, 1, 0, -1, 0][n] ?? 0;
    const pose: Record<string, number> = { head: -3 * swing, neck: 4 * swing, tail: 13 * swing };
    for (const { key, phase } of legs) {
      pose[`${key}-upper`] = phase * swing * 24;
      pose[`${key}-lower`] = Math.max(0, phase * swing) * 31;
    }
    return { u: n / 4, pose };
  });
  return assembly.finish({
    key: 'deer',
    packageId,
    form: 'skinned',
    materials: {
      fur: 'material/fur',
      throat: 'material/throat',
      dark: 'material/dark',
      antler: 'material/antler',
    },
    clips: [
      {
        name: 'walk',
        duration: 1.15,
        frameRate: 24,
        loop: true,
        path: { keys: walk, interpolation: 'smooth' },
      },
      {
        name: 'graze',
        duration: 3.2,
        frameRate: 24,
        loop: true,
        path: {
          keys: [
            { u: 0, pose: { neck: 0, head: 0, tail: 5 } },
            { u: 0.45, pose: { neck: 47, head: 13, tail: -11 } },
            { u: 0.68, pose: { neck: 45, head: 17, tail: 7 } },
            { u: 1, pose: { neck: 0, head: 0, tail: 5 } },
          ],
          interpolation: 'smooth',
        },
      },
    ],
  });
}

export default definePack({
  schemaVersion: '2.0.0',
  name: 'Pine Basin skinned deer',
  packageId: definePackageId(wildlifePackageId),
  sceneComponents: [
    Transform,
    Name,
    ChildOf,
    AnimationPlayer,
    AnimationTargetId,
    Skin,
    MeshFilter,
    MeshRenderer,
  ],
  build({ packageId }) {
    const products = deer(packageId);
    if (!products.ok) return products;
    return ok({
      ...products.value,
      ...Object.fromEntries(
        Object.entries(surfaces).map(([slot, color]) => [`material/${slot}`, skinMaterial(color)]),
      ),
    });
  },
});
