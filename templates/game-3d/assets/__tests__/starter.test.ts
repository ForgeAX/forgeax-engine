import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import { deriveAnimationTargetId } from '@forgeax/engine/animation';
import { createUiImporter } from '@forgeax/engine/ui/importer';
import type { AnimationClip, SkeletonAsset } from '@forgeax/engine/types';
import { beforeAll, describe, expect, it } from 'vitest';
import characterPack from '../character.pack.ts';
import environmentPack from '../environment.pack.ts';
import fantasyMeshesPack from '../fantasy-meshes.pack.ts';
import geometryPack from '../geometry.pack.ts';
import materialsPack from '../materials.pack.ts';
import scenePack from '../scene.pack.ts';
import gamePack from '../game.pack.ts';
import uiPack from '../ui/ui.pack.ts';
import { createMeshJobCooker } from '@forgeax/engine/modeling';
import { CONVOY_JOB } from '../player/convoy-job.ts';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { EngineContent } from '@forgeax/engine/content';
import { assetGuid, guidText, PACKAGE_IDS, RUSTED_IRON_MATERIAL_GUID } from '../shared/asset-refs.ts';
import { buildConvoy, convoyPath, CONVOY_NORMALS, CONVOY_TRIANGLE_BUDGET } from '../player/convoy-model.ts';
import { PLAYER_RIG } from '../player/player-rig.ts';
import {
  MAX_CAMERA_PITCH,
  MIN_CAMERA_PITCH,
  cameraRelativeMove,
  facingYaw,
  horizontalCameraAxes,
  integratePointerLook,
} from '../camera/third-person.ts';

/**
 * These tests pin the canonical reference's engine and asset contracts. Keep
 * assertions that prove reusable behavior, but rewrite or remove sample-name
 * and sample-composition assertions when the template becomes a new product.
 */
async function build(pack: {
  readonly build: (reader: never) => unknown;
}): Promise<Record<string, unknown>> {
  const result = await pack.build((pack === characterPack ? { packageId: PACKAGE_IDS.character, values: { resolution: 128 } } : undefined) as never);
  if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== true) {
    throw new Error(`ScriptablePack build failed: ${JSON.stringify(result)}`);
  }
  const outputs = (result as unknown as { readonly value: Record<string, unknown> }).value;
  if (pack !== characterPack) return outputs;
  const cooker = createMeshJobCooker([CONVOY_JOB], { timeoutMs: 180000 });
  return Object.fromEntries(await Promise.all(Object.entries(outputs).map(async ([key, entry]) => [key, (await cooker.cook({ guid: guidText(assetGuid(PACKAGE_IDS.character, key)), source: (entry as { source: unknown }).source })).payload])));
}

type Matrix = number[];

function multiplyMatrix(a: readonly number[], b: readonly number[]): Matrix {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let lane = 0; lane < 4; lane += 1) {
        out[column * 4 + row] += (a[lane * 4 + row] ?? 0) * (b[column * 4 + lane] ?? 0);
      }
    }
  }
  return out;
}

function localMatrix(translation: readonly number[], quaternion: readonly number[]): Matrix {
  const [x = 0, y = 0, z = 0, w = 1] = quaternion;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y + w * z),
    2 * (x * z - w * y),
    0,
    2 * (x * y - w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z + w * x),
    0,
    2 * (x * z + w * y),
    2 * (y * z - w * x),
    1 - 2 * (x * x + y * y),
    0,
    translation[0] ?? 0,
    translation[1] ?? 0,
    translation[2] ?? 0,
    1,
  ];
}

function playerTargetPath(joint: number): readonly string[] {
  const names: string[] = [];
  let cursor = joint;
  while (cursor >= 0) {
    const entry = PLAYER_RIG[cursor];
    if (entry === undefined) break;
    names.unshift(entry.name);
    cursor = entry.parent;
  }
  return ['Player', ...names];
}

function maximumAnimatedEdgeStretch(
  mesh: {
    readonly indices: Uint32Array;
    readonly attributes: {
      readonly position?: Float32Array;
      readonly skinIndex?: Uint16Array;
      readonly skinWeight?: Float32Array;
    };
  },
  skeleton: { readonly inverseBindMatrices: Float32Array },
  clip: {
    readonly channels: readonly {
      readonly targetId: number;
      readonly property: string;
      readonly sampler: { readonly input: Float32Array; readonly output: Float32Array };
    }[];
  },
): { readonly ratio: number; readonly detail: string } {
  const positions = mesh.attributes.position ?? new Float32Array();
  const jointIndices = mesh.attributes.skinIndex ?? new Uint16Array();
  const jointWeights = mesh.attributes.skinWeight ?? new Float32Array();
  const channelByTargetAndProperty = new Map<string, (typeof clip.channels)[number]>(
    clip.channels.map(
      (channel) => [`${String(channel.targetId)}:${channel.property}`, channel] as const,
    ),
  );
  let maximum = 1;
  let detail = '';
  for (const sampleTime of [0.25, 0.75]) {
    const worlds: Matrix[] = [];
    for (let joint = 0; joint < PLAYER_RIG.length; joint += 1) {
      const rigJoint = PLAYER_RIG[joint];
      if (rigJoint === undefined) continue;
      const targetId = deriveAnimationTargetId(playerTargetPath(joint));
      const translationChannel = channelByTargetAndProperty.get(`${String(targetId)}:translation`);
      const rotationChannel = channelByTargetAndProperty.get(`${String(targetId)}:rotation`);
      const translationKey =
        translationChannel?.sampler.input.findIndex((time) => time === sampleTime) ?? -1;
      const rotationKey =
        rotationChannel?.sampler.input.findIndex((time) => time === sampleTime) ?? -1;
      const translation =
        translationKey >= 0
          ? Array.from(
              translationChannel?.sampler.output.slice(
                translationKey * 3,
                translationKey * 3 + 3,
              ) ?? rigJoint.local,
            )
          : rigJoint.local;
      const rotation =
        rotationKey >= 0
          ? Array.from(
              rotationChannel?.sampler.output.slice(rotationKey * 4, rotationKey * 4 + 4) ?? [
                0, 0, 0, 1,
              ],
            )
          : [0, 0, 0, 1];
      const local = localMatrix(translation, rotation);
      worlds[joint] =
        rigJoint.parent < 0
          ? local
          : multiplyMatrix(worlds[rigJoint.parent] ?? localMatrix([0, 0, 0], [0, 0, 0, 1]), local);
    }
    const palettes = worlds.map((world, joint) =>
      multiplyMatrix(
        world,
        Array.from(skeleton.inverseBindMatrices.slice(joint * 16, joint * 16 + 16)),
      ),
    );
    const deformed = new Float32Array(positions.length);
    for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
      const source = [
        positions[vertex * 3] ?? 0,
        positions[vertex * 3 + 1] ?? 0,
        positions[vertex * 3 + 2] ?? 0,
      ];
      for (let lane = 0; lane < 4; lane += 1) {
        const weight = jointWeights[vertex * 4 + lane] ?? 0;
        if (weight <= 0) continue;
        const matrix = palettes[jointIndices[vertex * 4 + lane] ?? 0];
        if (matrix === undefined) continue;
        deformed[vertex * 3] +=
          weight *
          ((matrix[0] ?? 0) * source[0] +
            (matrix[4] ?? 0) * source[1] +
            (matrix[8] ?? 0) * source[2] +
            (matrix[12] ?? 0));
        deformed[vertex * 3 + 1] +=
          weight *
          ((matrix[1] ?? 0) * source[0] +
            (matrix[5] ?? 0) * source[1] +
            (matrix[9] ?? 0) * source[2] +
            (matrix[13] ?? 0));
        deformed[vertex * 3 + 2] +=
          weight *
          ((matrix[2] ?? 0) * source[0] +
            (matrix[6] ?? 0) * source[1] +
            (matrix[10] ?? 0) * source[2] +
            (matrix[14] ?? 0));
      }
    }
    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
      const triangle = [
        mesh.indices[offset] ?? 0,
        mesh.indices[offset + 1] ?? 0,
        mesh.indices[offset + 2] ?? 0,
      ];
      for (let edge = 0; edge < 3; edge += 1) {
        const a = triangle[edge] ?? 0;
        const b = triangle[(edge + 1) % 3] ?? 0;
        const rest = Math.hypot(
          (positions[a * 3] ?? 0) - (positions[b * 3] ?? 0),
          (positions[a * 3 + 1] ?? 0) - (positions[b * 3 + 1] ?? 0),
          (positions[a * 3 + 2] ?? 0) - (positions[b * 3 + 2] ?? 0),
        );
        if (rest < 0.01) continue;
        const animated = Math.hypot(
          (deformed[a * 3] ?? 0) - (deformed[b * 3] ?? 0),
          (deformed[a * 3 + 1] ?? 0) - (deformed[b * 3 + 1] ?? 0),
          (deformed[a * 3 + 2] ?? 0) - (deformed[b * 3 + 2] ?? 0),
        );
        const ratio = animated / rest;
        if (ratio > maximum) {
          maximum = ratio;
          const describeVertex = (vertex: number) => ({
            position: Array.from(positions.slice(vertex * 3, vertex * 3 + 3)),
            joints: Array.from(jointIndices.slice(vertex * 4, vertex * 4 + 4)),
            weights: Array.from(jointWeights.slice(vertex * 4, vertex * 4 + 4)),
          });
          detail = JSON.stringify({
            sampleTime,
            a: describeVertex(a),
            b: describeVertex(b),
            rest,
            animated,
          });
        }
      }
    }
  }
  return { ratio: maximum, detail };
}

describe('game-3d starter', () => {
  let characterOutputs: Record<string, unknown>;
  beforeAll(async () => { characterOutputs = await build(characterPack); }, 30000);

  it('declares frontend and engine asset roots with ordinary native composition', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../../forge.json', import.meta.url), 'utf8'),
    );
    expect(manifest).toMatchObject({
      schemaVersion: '3.0.0',
      roots: {
        frontend: AssetGuid.format(AssetGuid.derive(uiPack.packageId, 'plugin/host')),
        engine: AssetGuid.format(AssetGuid.derive(gamePack.packageId, 'plugin/engine')),
      },
    });
  });

  it('mounts the Engine Content library and references its default material by GUID', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../../forge.json', import.meta.url), 'utf8'),
    );
    expect(manifest.assetLibraries).toEqual(['@forgeax/engine/content']);
    expect(AssetGuid.parse(EngineContent.materials.default).ok).toBe(true);
    expect(AssetGuid.parse(EngineContent.meshes.cube).ok).toBe(true);
  });

  it('keeps one source per asset owner and a readable UI authoring pair', async () => {
    const html = await readFile(new URL('../guide.ui.html', import.meta.url), 'utf8');
    const css = await readFile(new URL('../guide.ui.css', import.meta.url), 'utf8');
    const meta = JSON.parse(
      await readFile(new URL('../guide.ui.html.meta.json', import.meta.url), 'utf8'),
    );
    expect(html).toContain('WASD move');
    expect(html).toContain('\n');
    expect(css).toContain(':host {');
    expect(css).toContain('\n');
    expect(meta).toMatchObject({ importer: 'ui', source: 'guide.ui.html' });
    expect(meta.subAssets).toEqual([
      expect.objectContaining({ sourceKey: 'ui/guide', kind: 'ui' }),
    ]);
    const imported = await createUiImporter().import({
      source: 'guide.ui.html',
      readSource: async () => ({ ok: true as const, value: new TextEncoder().encode(html) }),
      readSibling: async (path) => ({
        ok: true as const,
        value: new TextEncoder().encode(path === 'guide.ui.css' ? css : await readFile(new URL('../guide.ui.i18n.json', import.meta.url), 'utf8')),
      }),
      decodeImage: async () => {
        throw new Error('the template UI has no image companion');
      },
      subAssets: meta.subAssets,
      importSettings: meta.importSettings,
    });
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    if (imported.ok) {
      expect(imported.value.sourceDependencies).toEqual(['guide.ui.html', 'guide.ui.css', 'guide.ui.i18n.json']);
      expect(imported.value.assets[0]?.payload).toMatchObject({ html, css });
    }
  });

  it('defines camera-relative directions without left/right or front/back ambiguity', () => {
    expect(horizontalCameraAxes(0)).toEqual({ forwardX: 0, forwardZ: -1, rightX: 1, rightZ: 0 });
    const left = cameraRelativeMove(0, -1, 0);
    const right = cameraRelativeMove(0, 1, 0);
    expect(left.x).toBe(-1);
    expect(left.z).toBeCloseTo(0);
    expect(right.x).toBe(1);
    expect(right.z).toBeCloseTo(0);
    const quarterTurn = cameraRelativeMove(Math.PI / 2, 0, 1);
    expect(quarterTurn.x).toBeCloseTo(1);
    expect(quarterTurn.z).toBeCloseTo(0);
    expect(facingYaw(0, -1)).toBeCloseTo(0);
    expect(facingYaw(1, 0)).toBeCloseTo(-Math.PI / 2);
  });

  it('uses locked-pointer deltas with a bounded camera pitch', () => {
    expect(integratePointerLook(0, 0, 100, 0).yaw).toBeGreaterThan(0);
    expect(integratePointerLook(0, 0, 0, -100_000).pitch).toBe(MIN_CAMERA_PITCH);
    expect(integratePointerLook(0, 0, 0, 100_000).pitch).toBe(MAX_CAMERA_PITCH);
  });

  it('uses one authored sky for both the background and PBR environment', async () => {
    const scene = (await build(scenePack))['scene/showcase'] as {
      readonly entities: Record<string, { readonly components: Record<string, Record<string, unknown>> }>;
    };
    const components = Object.values(scene.entities).map((entity) => entity.components);
    expect(components.filter((entry) => entry.DirectionalLight)).toHaveLength(1);
    expect(components.filter((entry) => entry.Atmosphere)).toHaveLength(0);
    const skylights = components.filter((entry) => entry.Skylight);
    expect(skylights).toHaveLength(1);
    const backgrounds = components.filter((entry) => entry.SkyboxBackground);
    expect(backgrounds).toHaveLength(1);
    expect(skylights[0]?.Skylight?.equirect).toBeDefined();
    expect(backgrounds[0]?.SkyboxBackground?.equirect).toBe(skylights[0]?.Skylight?.equirect);
    expect(skylights[0]?.Skylight?.equirect).toBe(
      guidText(assetGuid(PACKAGE_IDS.environment, 'environment/daylight')),
    );
    const environment = (await build(environmentPack))['environment/daylight'] as {
      readonly width: number;
      readonly height: number;
      readonly data: Uint8Array;
    };
    const pixels = new Float32Array(environment.data.buffer);
    expect(pixels).toHaveLength(environment.width * environment.height * 4);
    expect(pixels.every((channel) => Number.isFinite(channel) && channel > 0)).toBe(true);
    const zenith = Math.floor(environment.width / 2) * 4;
    expect(pixels[zenith + 2]).toBeGreaterThan(pixels[zenith] ?? 0);
    const ground = ((environment.height - 1) * environment.width + Math.floor(environment.width / 2)) * 4;
    expect(pixels[ground]).toBeGreaterThan(0.02);
    expect(pixels[ground + 1]).toBeGreaterThan(0.02);
    expect(pixels[ground + 2]).toBeGreaterThan(0.02);
  });

  it('exports baked armor with rigid skinning and valid normals', { timeout: 30000 }, async () => {
    const outputs = characterOutputs;
    const mesh = outputs['mesh/player'] as {
      readonly indices: Uint32Array;
      readonly attributes: {
        readonly position?: Float32Array;
        readonly normal?: Float32Array;
        readonly skinIndex?: Uint16Array;
        readonly skinWeight?: Float32Array;
      };
      readonly submeshes: readonly { readonly materialSlot: number; readonly indexCount: number }[];
      readonly materialSlots: readonly {
        readonly slotName: string;
        readonly defaultMaterial?: Uint8Array;
      }[];
    };
    expect(mesh.attributes.skinIndex).toBeInstanceOf(Uint16Array);
    expect(mesh.attributes.skinWeight).toBeInstanceOf(Float32Array);
    expect(mesh.submeshes.map((submesh) => submesh.materialSlot)).toEqual(mesh.materialSlots.map((_, index) => index));
    expect(mesh.submeshes.every((submesh) => submesh.indexCount > 0)).toBe(true);
    expect(new Set(mesh.materialSlots.map((slot) => slot.slotName))).toEqual(new Set(['convoy', 'steel', 'dark', 'gold', 'rubber']));
    expect(mesh.materialSlots.every((slot) => slot.defaultMaterial?.byteLength === 16)).toBe(true);
    const vertexCount = (mesh.attributes.position?.length ?? 0) / 3;
    const positions = mesh.attributes.position ?? new Float32Array();
    const xs = Array.from({ length: vertexCount }, (_, index) => positions[index * 3] ?? 0);
    const ys = Array.from({ length: vertexCount }, (_, index) => positions[index * 3 + 1] ?? 0);
    expect(Math.min(...xs)).toBeLessThan(-0.9);
    expect(Math.max(...xs)).toBeGreaterThan(0.9);
    expect(Math.min(...ys)).toBeLessThan(-1);
    expect(Math.max(...ys)).toBeGreaterThan(1.15);
    expect(mesh.indices.length / 3).toBeLessThan(CONVOY_TRIANGLE_BUDGET);
    const normals = mesh.attributes.normal!;
    const weights = mesh.attributes.skinWeight!;
    const joints = mesh.attributes.skinIndex!;
    const usedJoints = new Set<number>();
    let unitWeights = true, validJoints = true, rigidTriangles = true;
    let minimumArea = Infinity, minimumFacing = Infinity, maximumNormalError = 0;
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const lane = vertex * 4;
      unitWeights &&= weights[lane] === 1 && weights[lane + 1] === 0 && weights[lane + 2] === 0 && weights[lane + 3] === 0;
      validJoints &&= joints[lane]! < PLAYER_RIG.length;
      usedJoints.add(joints[vertex * 4]!);
    }
    expect([...usedJoints].map(index => PLAYER_RIG[index]!.name).sort()).toEqual(PLAYER_RIG.map(joint => joint.name).sort());
    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
      const triangle = Array.from(mesh.indices.slice(offset, offset + 3));
      const [a, b, c] = triangle as [number, number, number];
      const edge = (to: number) => [0, 1, 2].map((axis) => positions[to * 3 + axis]! - positions[a * 3 + axis]!);
      const ab = edge(b), ac = edge(c);
      const cross = [ab[1]! * ac[2]! - ab[2]! * ac[1]!, ab[2]! * ac[0]! - ab[0]! * ac[2]!, ab[0]! * ac[1]! - ab[1]! * ac[0]!];
      const area = Math.hypot(...cross);
      minimumArea = Math.min(minimumArea, area);
      for (const vertex of triangle) {
        rigidTriangles &&= joints[vertex * 4] === joints[a * 4];
        const normal = Array.from(normals.slice(vertex * 3, vertex * 3 + 3));
        maximumNormalError = Math.max(maximumNormalError, Math.abs(Math.hypot(...normal) - 1));
        minimumFacing = Math.min(minimumFacing, normal.reduce((dot, value, axis) => dot + value * cross[axis]! / area, 0));
      }

    }
    // Check every vertex/triangle above, then assert the same exact predicates in batches.
    expect(unitWeights).toBe(true);
    expect(validJoints).toBe(true);
    expect(rigidTriangles).toBe(true);
    expect(minimumArea).toBeGreaterThan(1e-8);
    expect(maximumNormalError).toBeLessThan(0.00005);
    expect(minimumFacing).toBeGreaterThan(0.5);
    expect(outputs['rig/player-skeleton']).toMatchObject({ kind: 'skeleton', jointCount: PLAYER_RIG.length });
    expect(outputs['rig/player-skin']).toMatchObject({ kind: 'skin' });
    expect(outputs['animation/player-walk']).toMatchObject({
      kind: 'animation-clip',
      duration: 1,
      channels: expect.arrayContaining([expect.objectContaining({ property: 'translation' })]),
    });
  });

  it('rebuilds every authored character output deterministically', { timeout: 30000 }, async () => {
    const rebuilt = await build(characterPack);
    expect(isDeepStrictEqual(rebuilt, characterOutputs), 'every authored output remains deterministic').toBe(true);
  });

  it('keeps rigid armor edge lengths throughout the walk cycle', { timeout: 30000 }, () => {
    const outputs = characterOutputs;
    const mesh = outputs['mesh/player'] as Parameters<typeof maximumAnimatedEdgeStretch>[0];
    const stretch = maximumAnimatedEdgeStretch(
      mesh,
      outputs['rig/player-skeleton'] as { readonly inverseBindMatrices: Float32Array },
      outputs['animation/player-walk'] as Parameters<typeof maximumAnimatedEdgeStretch>[2],
    );
    expect(stretch.ratio, stretch.detail).toBeLessThan(1.0001);
  });

  it('derives mirrored world anchors and inverse binds from the authored local rig', { timeout: 30000 }, async () => {
    const outputs = characterOutputs;
    const skeleton = outputs['rig/player-skeleton'] as SkeletonAsset;
    const worlds: Matrix[] = [];
    const identity = localMatrix([0, 0, 0], [0, 0, 0, 1]);
    for (const [index, joint] of PLAYER_RIG.entries()) {
      expect(joint.parent).toBeLessThan(index);
      const local = localMatrix(joint.local, [0, 0, 0, 1]);
      const world = joint.parent < 0 ? local : multiplyMatrix(worlds[joint.parent]!, local);
      worlds.push(world);
      joint.world.forEach((value, axis) => expect(value).toBeCloseTo(world[12 + axis]!, 6));
      const bound = multiplyMatrix(world, Array.from(skeleton.inverseBindMatrices.slice(index * 16, (index + 1) * 16)));
      bound.forEach((value, lane) => expect(value).toBeCloseTo(identity[lane]!, 6));
      if (joint.name.endsWith('.L')) {
        const right = PLAYER_RIG.find((candidate) => candidate.name === joint.name.replace('.L', '.R'))!;
        expect(right.world[0]).toBeCloseTo(-joint.world[0], 6);
        expect(right.world[1]).toBeCloseTo(joint.world[1], 6);
        expect(right.world[2]).toBeCloseTo(joint.world[2], 6);
      }
    }
  });

  it('closes the walk cycle and offsets matching limbs by half a cycle', { timeout: 30000 }, async () => {
    const clip = characterOutputs['animation/player-walk'] as AnimationClip;
    expect(new Set(clip.channels.map((channel) => `${channel.targetId}:${channel.property}`)).size).toBe(clip.channels.length);
    for (const channel of clip.channels) {
      if (channel.property === 'property') throw new Error('starter walk must contain numeric TRS tracks');
      const { input, output } = channel.sampler;
      const stride = channel.property === 'rotation' ? 4 : 3;
      expect(input[0]).toBe(0);
      expect(input[input.length - 1]).toBe(clip.duration);
      for (let key = 1; key < input.length; key += 1) expect(input[key]).toBeGreaterThan(input[key - 1]!);
      expect(Array.from(output.slice(-stride))).toEqual(Array.from(output.slice(0, stride)));
    }
    const translation = clip.channels.find((channel) => channel.property === 'translation');
    if (translation?.property !== 'translation') throw new Error('starter walk root translation is missing');
    Array.from(translation.sampler.output.slice(0, 3)).forEach((value, axis) =>
      expect(value).toBeCloseTo(PLAYER_RIG[0]!.local[axis]!, 6));
    for (const [leftIndex, joint] of PLAYER_RIG.entries()) {
      if (leftIndex >= 14 || !joint.name.endsWith('.L')) continue;
      const rightIndex = PLAYER_RIG.findIndex((candidate) => candidate.name === joint.name.replace('.L', '.R'));
      const left = clip.channels.find((channel) => channel.targetId === deriveAnimationTargetId(playerTargetPath(leftIndex)));
      const right = clip.channels.find((channel) => channel.targetId === deriveAnimationTargetId(playerTargetPath(rightIndex)));
      if (left?.property !== 'rotation' || right?.property !== 'rotation') throw new Error('starter walk mirrored rotations are missing');
      const steps = left.sampler.input.length - 1;
      for (let key = 0; key < steps; key += 1) {
        const opposite = (key + steps / 2) % steps;
        for (let lane = 0; lane < 4; lane += 1) {
          expect(right.sampler.output[key * 4 + lane]).toBeCloseTo(left.sampler.output[opposite * 4 + lane]!, 6);
        }
      }
    }
  });

  it('restores the three fantasy meshes with explicit multi-material submeshes', async () => {
    const outputs = await build(fantasyMeshesPack);
    expect(Object.keys(outputs)).toEqual([
      'mesh/klein-bottle',
      'mesh/trefoil-knot',
      'mesh/astral-bloom',
    ]);
    for (const mesh of Object.values(outputs) as {
      readonly submeshes: readonly { readonly materialSlot: number; readonly indexCount: number }[];
      readonly materialSlots: readonly unknown[];
    }[]) {
      expect(mesh.submeshes.map((submesh) => submesh.materialSlot)).toEqual([0, 1, 2]);
      expect(mesh.submeshes.every((submesh) => submesh.indexCount > 0)).toBe(true);
      expect(mesh.materialSlots).toHaveLength(3);
    }
  });

  it('routes visible player passes through skinning and keeps the depth-only shadow pass', { timeout: 30000 }, async () => {
    const outputs = await build(materialsPack);
    expect(Object.keys(outputs)).toHaveLength(11);
    const character = characterOutputs;
    {
      const material = character['material/convoy'] as {
        readonly passes: readonly {
          readonly name: string;
          readonly program: { readonly module: string; readonly fragmentEntry?: string };
        }[];
        readonly values: Readonly<Record<string, unknown>>;
      };
      expect(
        material.passes
          .filter((pass) => pass.name !== 'shadow-caster')
          .every((pass) => pass.program.module === 'forgeax::pbr-skin'),
      ).toBe(true);
      const deferred = material.passes.find((pass) => pass.name === 'deferred');
      if (deferred === undefined) {
        expect(material.passes.map((pass) => pass.name)).toEqual(['forward', 'shadow-caster']);
      } else {
        expect(deferred.program.fragmentEntry).toBe('fs_gbuffer');
      }
      expect(material.passes.find((pass) => pass.name === 'shadow-caster')?.program.module).toBe(
        'forgeax::default-shadow-caster',
      );
      for (const [property, map] of [['baseColorTexture', 'base-color'], ['normalTexture', 'normal'], ['metallicRoughnessTexture', 'ormh'], ['occlusionTexture', 'ormh'], ['emissiveTexture', 'emissive'], ['clearcoatTexture', 'coat'], ['clearcoatRoughnessTexture', 'coat']]) {
        expect(material.values[property!]).toEqual({ texture: guidText(assetGuid(PACKAGE_IDS.character, `texture/convoy-${map}`)) });
      }
      expect(material.values.baseColor).toEqual([1, 1, 1, 1]);
      expect(material.values.emissive).toEqual([2, 2, 2]);
    }
    const rustedIron = outputs['material/rusted-iron'] as {
      readonly passes: readonly { readonly program: { readonly module: string } }[];
      readonly parameters: readonly { readonly name: string; readonly type: string }[];
      readonly values: { readonly ironColor: readonly number[] };
    };
    expect(rustedIron.passes[0]?.program.module).toBe('forgeax_material::standard');
    expect(rustedIron.parameters).toContainEqual({ name: 'ironColor', type: 'color' });
    expect(rustedIron.values).not.toHaveProperty('baseColorTexture');
    expect(Math.min(...rustedIron.values.ironColor.slice(0, 3))).toBeGreaterThanOrEqual(0.38);

    const geometry = await build(geometryPack);
    expect(Object.keys(geometry)).toHaveLength(8);
    expect(geometry['mesh/finial']).toBeUndefined();
    const ramp = geometry['mesh/ramp'] as {
      readonly materialSlots: readonly { readonly defaultMaterial?: Uint8Array }[];
    };
    expect(ramp.materialSlots[0]?.defaultMaterial).toEqual(RUSTED_IRON_MATERIAL_GUID);
  });

  it('authors physics on the player and every visible walkable obstacle', { timeout: 30000 }, async () => {
    const scene = (await build(scenePack))['scene/showcase'] as {
      readonly skinGuids: readonly string[];
      readonly entities: Record<
        string,
        { readonly components: Record<string, Record<string, unknown>> }
      >;
    };
    const components = Object.values(scene.entities).map((entity) => entity.components);
    const player = components.find((entry) => entry.Name?.value === 'Player');
    const convoy = buildConvoy(512);
    const supportHeight = Number(player?.Collider?.radius) + Number(player?.Collider?.halfHeight);
    for (const u of [0, 1]) {
      const pose = convoy.assembly.sample(convoyPath(convoy.assembly), u).unwrap();
      const mesh = convoy.assembly.toMesh(pose, { normals: CONVOY_NORMALS }).unwrap().mesh;
      const positions = mesh.attributes.position as Float32Array;
      let lowest = Infinity;
      for (let i = 1; i < positions.length; i += 3) lowest = Math.min(lowest, positions[i]!);
      expect(supportHeight).toBeGreaterThanOrEqual(-lowest - 0.00001);
      expect(supportHeight + lowest).toBeLessThan(0.005);
    }
    expect(player).toMatchObject({
      RigidBody: { type: 2 },
      Collider: { radius: 0.38 },
      CharacterController: { autoStepMaxHeight: 0.32, snapToGroundDist: 0.24 },
    });
    for (const name of [
      'Ground',
      'Warm Stone Pedestal',
      'Mirror Sphere',
      'Lacquer Collision Cube',
      'Mirror Torus',
      'Sandstone Step',
      'Rusted Iron Ramp',
      'Klein Bottle',
      'Trefoil Knot',
      'Astral Bloom',
    ]) {
      const object = components.find((entry) => entry.Name?.value === name);
      expect(object?.RigidBody).toMatchObject({ type: 0 });
      expect(object?.Collider).toBeDefined();
    }
    const ramp = components.find((entry) => entry.Name?.value === 'Rusted Iron Ramp');
    const rampPosition = ramp?.Transform?.pos as readonly number[] | undefined;
    const playerPosition = player?.Transform?.pos as readonly number[] | undefined;
    expect(rampPosition?.[0]).toBeCloseTo(-2.2);
    expect(rampPosition?.[2]).toBeCloseTo(playerPosition?.[2] ?? 0);
    expect(Math.abs((rampPosition?.[0] ?? 0) - (playerPosition?.[0] ?? 0))).toBeLessThan(3);
    expect(components.find((entry) => entry.Name?.value === 'Player Body')?.Skin).toBeDefined();
    expect(scene.skinGuids).toHaveLength(1);
    const sun = components.find((entry) => entry.DirectionalLight)?.DirectionalLight;
    expect(sun).toMatchObject({ castShadow: true });
    // The game opts into shadows while the engine owns the cascade defaults.
    expect(sun).not.toHaveProperty('cascadeCount');
    expect(components.some((entry) => entry.Skylight !== undefined)).toBe(true);
    expect(components.some((entry) => entry.PointLight !== undefined)).toBe(true);
    expect(components.some((entry) => entry.Camera !== undefined)).toBe(true);
  });
});
