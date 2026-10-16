import {
  type BakeDataKey,
  type BakeFingerprintInput,
  bakeFingerprint,
  resolveBakeData,
} from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const INPUT: BakeFingerprintInput = {
  meshContentHash: 'mesh-a',
  worldTransform: IDENTITY,
  materialHash: 'mat-a',
  lightHashes: ['sun', 'lamp'],
  settingsHash: 'settings-a',
  algorithmVersion: 1,
};

export default defineFeature({
  title: 'Baked data fingerprint',
  catalog: 'Baked lighting identity',
  kind: 'headless',
  summary:
    'bakeFingerprint hashes every baked-lighting input (mesh, transform, material, lights, settings, algorithm) to SHA-256; resolveBakeData keeps only records whose fingerprint still matches the live scene and reports one bake-data-stale diagnostic per scene.',
  expect:
    'All checks pass: stable 64-hex digest, light order ignored, any input change alters the digest, a moved entity is dropped to realtime with a bake-data-stale diagnostic.',
  run(checks) {
    const digest = bakeFingerprint(INPUT);
    checks.ok('sha256 hex digest', /^[0-9a-f]{64}$/.test(digest), digest);
    checks.equal('deterministic', bakeFingerprint({ ...INPUT }), digest);
    checks.equal(
      'light order is insensitive',
      bakeFingerprint({ ...INPUT, lightHashes: ['lamp', 'sun'] }),
      digest,
    );
    const moved = [...IDENTITY];
    moved[12] = 1;
    checks.ok(
      'transform change alters digest',
      bakeFingerprint({ ...INPUT, worldTransform: moved }) !== digest,
    );
    checks.ok(
      'material change alters digest',
      bakeFingerprint({ ...INPUT, materialHash: 'mat-b' }) !== digest,
    );
    checks.ok(
      'algorithm version alters digest',
      bakeFingerprint({ ...INPUT, algorithmVersion: 2 }) !== digest,
    );

    const rock: BakeDataKey = { sceneSourceKey: 'scene:level-1', address: 'rock', lod: 'shared' };
    const tree: BakeDataKey = {
      sceneSourceKey: 'scene:level-1',
      address: ['forest', 'tree'],
      lod: 0,
    };
    const gone: BakeDataKey = { sceneSourceKey: 'scene:level-2', address: 'removed', lod: 1 };
    const live = new Map<BakeDataKey, BakeFingerprintInput>([
      [rock, INPUT],
      [tree, { ...INPUT, worldTransform: moved }],
    ]);
    const resolution = resolveBakeData(
      [
        { key: rock, fingerprint: digest },
        { key: tree, fingerprint: digest },
        { key: gone, fingerprint: digest },
      ],
      (key) => live.get(key),
    );
    checks.equal(
      'only the unchanged record is baked',
      resolution.baked.map((record) => record.key.address),
      ['rock'],
    );
    checks.equal(
      'one diagnostic per scene',
      resolution.diagnostics.map((d) => d.detail.sceneSourceKey),
      ['scene:level-1', 'scene:level-2'],
    );
    checks.ok(
      'diagnostic code bake-data-stale',
      resolution.diagnostics.every((d) => d.code === 'bake-data-stale'),
    );
    checks.equal(
      'stale keys of level-1',
      resolution.diagnostics[0]?.detail.stale.map((key) => key.lod),
      [0],
    );
  },
});
