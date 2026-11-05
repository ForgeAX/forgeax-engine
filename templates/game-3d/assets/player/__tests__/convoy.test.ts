import { isDeepStrictEqual } from 'node:util';
import { bakeMaps } from '@forgeax/engine/modeling';
import { deriveAnimationTargetId } from '@forgeax/engine/animation';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildConvoy, convoyAssets, convoyPath, CONVOY_NORMALS, CONVOY_MAPS, convoyBakeSettings, CONVOY_TRIANGLE_BUDGET } from '../convoy-model.ts';
import { CONVOY_FINISH_KIND, finishConvoyTextures } from '../convoy-finish.ts';
import characterPack from '../../character.pack.ts';
import { CONVOY_WHEELS, PLAYER_RIG, playerTargetPath } from '../player-rig.ts';

describe('Convoy native modeling delivery', () => {
  let built: ReturnType<typeof buildConvoy>;
  beforeAll(() => { built = buildConvoy(512); }, 30000);
  it('uses one continuous rigid assembly in robot, folding and truck poses', { timeout: 30000 }, () => {
    const { base, detail, assembly } = built;
    const low = base.toMesh({ normals: CONVOY_NORMALS });
    const high = detail.toMesh({ normals: CONVOY_NORMALS });
    if (!low.ok) throw low.error;
    if (!high.ok) throw high.error;
    expect(low.value.mesh.indices!.length / 3).toBeLessThan(CONVOY_TRIANGLE_BUDGET);
    expect(high.value.mesh.indices!.length).toBeGreaterThan(low.value.mesh.indices!.length * 6);
    for (const u of [0, 0.2, 0.5, 0.8, 1]) {
      const pose = assembly.sample(convoyPath(), u);
      if (!pose.ok) throw pose.error;
      const mesh = assembly.toMesh(pose.value, { normals: CONVOY_NORMALS });
      if (!mesh.ok) throw mesh.error;
      expect(mesh.value.mesh.indices!.length).toBe(low.value.mesh.indices!.length);
      expect((mesh.value.mesh.attributes.position as Float32Array).every(Number.isFinite)).toBe(true);
    }
  });

  it('exports complete rest tracks and six independent wheel rotations at the declared 1K default', { timeout: 30000 }, () => {
    const assets = convoyAssets();
    expect(characterPack.parameters?.find(parameter => parameter.name === 'resolution')?.default).toBe(1024);
    const textures = Object.values(assets).filter(asset => asset.kind === CONVOY_FINISH_KIND);
    expect(textures).toHaveLength(5);
    for (const asset of textures) expect(asset).toHaveProperty('source.params.resolution', 1024);
    const transform = assets['animation/player-transform'];
    const wheels = assets['animation/player-wheels'];
    const valid = new Set(PLAYER_RIG.map((_, index) => deriveAnimationTargetId(playerTargetPath(index))));
    for (const clip of [transform, wheels]) {
      expect(new Set(clip.channels.map(channel => `${channel.targetId}:${channel.property}`)).size).toBe(clip.channels.length);
      expect(clip.channels.every(channel => valid.has(channel.targetId))).toBe(true);
    }
    expect(wheels.channels).toHaveLength(6);
    const wheelIds = new Set(CONVOY_WHEELS.map(wheel => deriveAnimationTargetId(playerTargetPath(PLAYER_RIG.findIndex(joint => joint.name === wheel.name)))));
    expect(wheels.channels.every(channel => channel.property === 'rotation' && wheelIds.has(channel.targetId))).toBe(true);
    for (const [index, joint] of PLAYER_RIG.entries()) if (joint.role === 'body') expect(transform.channels.some(channel => channel.property === 'rotation' && channel.targetId === deriveAnimationTargetId(playerTargetPath(index)))).toBe(true);
    expect(Object.keys(assets).every(key => /^[a-z0-9][a-z0-9._/-]*$/.test(key))).toBe(true);
  });

  it('bakes real high surface detail into tangent normals, AO and height', { timeout: 60_000 }, () => {
    const { bakeBase: base, bakeDetail: detail } = built;
    const baked = bakeMaps({ base, detail, ...convoyBakeSettings(128), resolution: 128, mips: false });
    if (!baked.ok) throw baked.error;
    const pixels = (map: typeof CONVOY_MAPS[number]) => baked.value.textures[map]!.data as Uint8Array;
    const normal = pixels('normal'), ao = pixels('ao'), height = pixels('height');
    let tilted = 0, occluded = 0;
    const heights = new Set<number>();
    for (let i = 0; i < normal.length; i += 4) {
      if (Math.abs(normal[i]! - 128) > 8 || Math.abs(normal[i + 1]! - 128) > 8) tilted++;
      if (ao[i]! < 245) occluded++;
      heights.add(height[i]!);
    }
    expect(tilted).toBeGreaterThan(100);
    expect(occluded).toBeGreaterThan(100);
    expect(heights.size).toBeGreaterThan(10);
    const ormh = pixels('ormh'), color = pixels('baseColor'), emission = pixels('emissive');
    const roughness = new Set<number>(), metal = new Set<number>(), colors = new Set<string>();
    let glowing = 0, identicalAo = true;
    for (let i = 0; i < ormh.length; i += 4) {
      identicalAo &&= ormh[i] === ao[i];
      roughness.add(ormh[i + 1]!); metal.add(ormh[i + 2]!);
      colors.add(`${color[i]},${color[i + 1]},${color[i + 2]}`);
      if (emission[i]! + emission[i + 1]! + emission[i + 2]! > 0) glowing++;
    }
    expect(identicalAo).toBe(true);
    expect(Math.max(...roughness) - Math.min(...roughness)).toBeGreaterThan(100);
    expect(Math.max(...metal) - Math.min(...metal)).toBeGreaterThan(200);
    expect(colors.size).toBeGreaterThan(16);
    expect(glowing).toBeGreaterThan(10);
    const finished = finishConvoyTextures(baked.value.textures);
    expect(isDeepStrictEqual(finished, finishConvoyTextures(baked.value.textures))).toBe(true);
    expect(finished.baseColor!.data.slice(0, color.length)).not.toEqual(color);
    expect(finished.ormh!.data.slice(0, ormh.length)).not.toEqual(ormh);
    expect(finished.normal!.mips).toEqual({ kind: 'packed', levelCount: 8 });
    expect(finished.coat!.data.length).toBe(87380);
    const coat = finished.coat!.data as Uint8Array;
    let lacquered = 0, dry = 0;
    for (let i = 0; i < color.length; i += 4) {
      if (coat[i]! > 180) lacquered++;
      if (coat[i]! === 0) dry++;
    }
    expect(lacquered).toBeGreaterThan(100);
    expect(dry).toBeGreaterThan(100);
  });
});
