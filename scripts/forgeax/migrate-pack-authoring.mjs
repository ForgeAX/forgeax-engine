#!/usr/bin/env node

/**
 * One-time, owner-scoped migration for the authored template direct Packs.
 *
 * This is deliberately not a runtime lookup table: it has no exported state,
 * never runs during scan/build, and is only useful while converting the
 * explicitly listed legacy files. The resulting files retain packageId and
 * sourceKey as their only author identity; output GUIDs are not written.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

const DIRECT_PACK_PLANS = Object.freeze({
  'templates/game-brotato-3d/assets/brotato-impact-vfx.pack.json': {
    packageId: '019fb264-3000-7000-8000-000000000080',
    sourceKeys: ['material/vfx', 'vfx/impact'],
    legacyGuids: [undefined, '019fb264-3000-7000-8000-000000000079'],
  },
  'templates/game-brotato-3d/assets/ui/hud.pack.json': {
    packageId: '019fb264-3000-7000-8000-000000000091',
    sourceKeys: ['ui/hud'],
    legacyGuids: ['019fb264-3000-7000-8000-000000000090'],
  },
  'templates/game-default/assets/animated-target-material.pack.json': {
    packageId: '019fb264-1000-7000-8000-000000000104',
    sourceKeys: ['shaders/animated-target.wgsl'],
    legacyGuids: ['01935b00-7d8c-4c4e-9f12-345678abcd11'],
  },
  'templates/game-default/assets/arc-nova-ember-shard.shader.pack.json': {
    packageId: '019fb264-1000-7000-8000-000000000107',
    sourceKeys: ['shaders/arc-nova-ember-shard.wgsl'],
    legacyGuids: ['41f1e2a0-4d1e-4f71-9c55-000000000116'],
  },
  'templates/game-default/assets/arc-nova-geometry.pack.json': {
    packageId: '019fb264-1000-7000-8000-000000000102',
    sourceKeys: ['mesh/arc-ring', 'mesh/arc-ribbon', 'mesh/arc-shard'],
    legacyGuids: [
      '019e9c00-0000-7000-8000-000000000120',
      '019e9c00-0000-7000-8000-000000000121',
      '019e9c00-0000-7000-8000-000000000122',
    ],
  },
  'templates/game-default/assets/arc-nova-shard.shader.pack.json': {
    packageId: '019fb264-1000-7000-8000-000000000108',
    sourceKeys: ['shaders/arc-nova-shard.wgsl'],
    legacyGuids: ['41f1e2a0-4d1e-4f71-9c55-000000000115'],
  },
  'templates/game-default/assets/arc-nova-sigil.shader.pack.json': {
    packageId: '019fb264-1000-7000-8000-000000000109',
    sourceKeys: ['shaders/arc-nova-sigil.wgsl'],
    legacyGuids: ['41f1e2a0-4d1e-4f71-9c55-000000000113'],
  },
  'templates/game-default/assets/arc-nova-violet-sigil.shader.pack.json': {
    packageId: '019fb264-1000-7000-8000-00000000010a',
    sourceKeys: ['shaders/arc-nova-violet-sigil.wgsl'],
    legacyGuids: ['41f1e2a0-4d1e-4f71-9c55-000000000114'],
  },
  'templates/game-default/assets/base-material.pack.json': {
    packageId: '019fb264-1000-7000-8000-000000000106',
    sourceKeys: ['material/base'],
    legacyGuids: ['eb5bf6e6-2e47-4d9a-99fd-81843228c9b3'],
  },
  'templates/game-default/assets/boss-lightning-materials.pack.json': {
    packageId: '019fb264-1000-7000-8000-000000000103',
    sourceKeys: [
      'material/blue',
      'material/ember',
      'material/core',
      'material/violet',
      'material/deep-violet',
      'material/energy',
    ],
    legacyGuids: [
      '41f1e2a0-4d1e-4f71-9c55-000000000110',
      '41f1e2a0-4d1e-4f71-9c55-000000000111',
      '019e9c00-0000-7000-8000-000000000003',
      '019e9c00-0000-7000-8000-000000000004',
      '019e9c00-0000-7000-8000-000000000005',
      '41f1e2a0-4d1e-4f71-9c55-000000000112',
    ],
  },
  'templates/game-default/assets/charge-vfx-effect.pack.json': {
    packageId: '019fb264-1000-7000-8000-000000000020',
    sourceKeys: ['vfx/charge'],
    legacyGuids: ['019e9c00-0000-7000-8000-000000000020'],
  },
  'templates/game-default/assets/hit-flash-material.pack.json': {
    packageId: '019fb264-1000-7000-8000-000000000105',
    sourceKeys: ['shaders/hit-flash.wgsl'],
    legacyGuids: ['019e7535-5e5e-45fe-a328-0b08e3a72747'],
  },
  'templates/game-default/assets/multi-material-target.pack.json': {
    packageId: '019fb264-1000-7000-8000-000000000101',
    sourceKeys: ['mesh/target', 'material/target-body', 'material/target-accent'],
    legacyGuids: [
      'd9f2a000-0001-5000-8000-000000000001',
      'd9f2a000-0002-5000-8000-000000000002',
      'd9f2a000-0003-5000-8000-000000000003',
    ],
  },
  'templates/game-default/assets/hit-vfx-effect.pack.json': {
    packageId: '019fb264-1000-7000-8000-000000000010',
    sourceKeys: ['vfx/hit'],
    legacyGuids: ['019e9c00-0000-7000-8000-000000000010'],
  },
  'templates/game-default/assets/hit-vfx-materials.pack.json': {
    packageId: '019fb264-1000-7000-8000-000000000030',
    sourceKeys: ['material/hit-billboard', 'material/hit-mesh'],
    legacyGuids: ['019e9c00-0000-7000-8000-000000000011', '019e9c00-0000-7000-8000-000000000012'],
  },
  'templates/game-default/assets/scene.pack.json': {
    packageId: '019fb264-1000-7000-8000-000000000100',
    sourceKeys: [
      'scene/main',
      'scene/nested-target',
      'material/ground',
      'material/tree-trunk',
      'material/tree-canopy',
      'material/red-box',
      'material/blue-ball',
      'material/player-skin',
      'material/player-torso',
      'material/player-legs',
      'material/crate',
      'material/barrier-emitter',
      'material/health-pickup',
      'material/sentinel',
    ],
    legacyGuids: [
      '1036f6f0-d3c2-5f31-9593-3432942d4c93',
      '0f20e111-5b2f-5a77-9a02-2f5d1e9c7a11',
      '4e3206e4-f2ac-5d05-b879-2c667168dc27',
      '423f2ea4-a8f2-504f-a1b5-323e3adf94d1',
      '4b077814-3cc4-51b5-8e76-e3d273dad53b',
      '7d718b8e-9fac-5301-b5cb-e0bc940bae67',
      '65a4a1d4-2abf-535b-923e-bd066a9ab475',
      'a1b2c3d4-0001-5000-8000-000000000001',
      'a1b2c3d4-0002-5000-8000-000000000002',
      'a1b2c3d4-0003-5000-8000-000000000003',
      'c0a7e000-0001-5000-8000-0000000000c1',
      'c0a7e000-0002-5000-8000-0000000000c2',
      '019f7000-0000-7000-8000-000000000025',
      '019f7f31-93d6-7c65-b688-2389096fb8e1',
    ],
  },
  'templates/game-default/assets/ui/hud.pack.json': {
    packageId: '019fb264-1000-7000-8000-000000000040',
    sourceKeys: ['ui/hud'],
    legacyGuids: ['019f8354-6386-4386-849d-f2ab4b96229c'],
  },
  'templates/game-default/assets/ui/settings.pack.json': {
    packageId: '019fb264-1000-7000-8000-000000000041',
    sourceKeys: ['ui/settings'],
    legacyGuids: ['019f8354-6386-4387-849d-f2ab4b9622a0'],
  },
});

const COOKED_REFERENCE_FILES = Object.freeze([
  'templates/game-default/assets/boss-lightning-contact.pack.json',
  'templates/game-default/assets/boss-lightning-flight.pack.json',
  'templates/game-default/assets/boss-lightning-suite.pack.json',
  'templates/game-default/assets/boss-lightning-telegraph.pack.json',
]);

const PRESERVED_COOKED_PACKS = Object.freeze({
  ...Object.fromEntries(
    COOKED_REFERENCE_FILES.map((path) => [path, 'native-cooked VFX transport']),
  ),
});

function uuidBytes(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`invalid UUID: ${value}`);
  }
  return Uint8Array.from(
    value
      .replaceAll('-', '')
      .match(/../g)
      .map((part) => Number.parseInt(part, 16)),
  );
}

function formatUuid(bytes) {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function derive(packageId, sourceKey) {
  const digest = createHash('sha1')
    .update(Buffer.from(uuidBytes(packageId)))
    .update(Buffer.from(sourceKey, 'utf8'))
    .digest();
  const result = Uint8Array.from(digest.subarray(0, 16));
  result[6] = (result[6] & 0x0f) | 0x50;
  result[8] = (result[8] & 0x3f) | 0x80;
  return formatUuid(result);
}

function rewriteKnown(value, oldToNew) {
  if (typeof value === 'string') return oldToNew.get(value.toLowerCase()) ?? value;
  if (Array.isArray(value)) return value.map((item) => rewriteKnown(item, oldToNew));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, rewriteKnown(item, oldToNew)]),
  );
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(ROOT, relativePath), 'utf8'));
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function collectUuidStrings(value, result = new Set()) {
  if (typeof value === 'string') {
    if (UUID_PATTERN.test(value)) result.add(value.toLowerCase());
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUuidStrings(item, result);
    return result;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectUuidStrings(item, result);
  }
  return result;
}

async function checkCookedReferenceClosure(rows, oldToNew) {
  const knownGuids = new Set(rows.map((row) => row.newGuid.toLowerCase()));
  for (const relativePath of COOKED_REFERENCE_FILES) {
    const document = await readJson(relativePath);
    for (const asset of Array.isArray(document.assets) ? document.assets : []) {
      if (typeof asset?.guid === 'string' && UUID_PATTERN.test(asset.guid)) {
        knownGuids.add(asset.guid.toLowerCase());
      }
    }
  }
  for (const relativePath of trackedTemplatePaths('.meta.json')) {
    const document = await readJson(relativePath);
    for (const guid of collectUuidStrings(document)) knownGuids.add(guid);
  }
  const failures = [];
  for (const relativePath of COOKED_REFERENCE_FILES) {
    const document = await readJson(relativePath);
    for (const guid of collectUuidStrings(document)) {
      if (oldToNew.has(guid)) {
        failures.push(
          `${relativePath}: legacy GUID ${guid} remains in a preserved cooked reference`,
        );
      } else if (!knownGuids.has(guid)) {
        failures.push(`${relativePath}: cooked reference ${guid} has no current owner`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `pack cooked reference closure failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
    );
  }
}

function assertLegacyDirect(relativePath, document, plan) {
  if (document.schemaVersion !== '1.0.0' && document.schemaVersion !== '2.0.0') {
    throw new Error(`${relativePath}: expected legacy Pack v1/v2 input`);
  }
  if (document.kind !== 'internal-text-package' || !Array.isArray(document.assets)) {
    throw new Error(`${relativePath}: expected an internal-text-package asset array`);
  }
  if (document.assets.length !== plan.sourceKeys.length) {
    throw new Error(`${relativePath}: sourceKey plan does not cover every output`);
  }
  if (
    plan.legacyGuids !== undefined &&
    plan.legacyGuids.length === document.assets.length &&
    document.assets.some(
      (asset, index) => asset.guid?.toLowerCase() !== plan.legacyGuids[index].toLowerCase(),
    )
  ) {
    throw new Error(`${relativePath}: legacy GUID order does not match the owner census`);
  }
  if (document.assets.some((asset) => asset.execution === 'cooked')) {
    throw new Error(`${relativePath}: cooked output is outside the direct authoring plan`);
  }
}

function projectDirect(document, plan, oldToNew) {
  const assets = {};
  document.assets.forEach((asset, index) => {
    const sourceKey = plan.sourceKeys[index];
    const { guid, execution, sourceKey: legacySourceKey, sourceIndex, ...entry } = asset;
    void guid;
    void execution;
    void legacySourceKey;
    void sourceIndex;
    assets[sourceKey] = rewriteKnown(entry, oldToNew);
  });
  return {
    schemaVersion: '3.0.0',
    packageId: plan.packageId,
    assets,
  };
}

async function buildOwnerMap() {
  const oldToNew = new Map();
  const rows = [];
  for (const [relativePath, plan] of Object.entries(DIRECT_PACK_PLANS)) {
    const document = await readJson(relativePath);
    const legacyAssets = Array.isArray(document.assets) ? document.assets : undefined;
    const migratedAssets =
      document.schemaVersion === '3.0.0' &&
      document.assets !== null &&
      typeof document.assets === 'object'
        ? document.assets
        : undefined;
    if (legacyAssets === undefined && migratedAssets === undefined) {
      throw new Error(`${relativePath}: expected a legacy or migrated direct Pack`);
    }
    if (legacyAssets !== undefined) assertLegacyDirect(relativePath, document, plan);
    if (
      migratedAssets !== undefined &&
      Object.keys(migratedAssets).length !== plan.sourceKeys.length
    ) {
      throw new Error(`${relativePath}: migrated sourceKey plan does not cover every output`);
    }
    plan.sourceKeys.forEach((sourceKey, index) => {
      const asset = legacyAssets?.[index] ?? migratedAssets?.[sourceKey];
      if (asset === undefined || typeof asset !== 'object') {
        throw new Error(`${relativePath}: missing output for ${sourceKey}`);
      }
      const next = derive(plan.packageId, sourceKey);
      const expectedLegacyGuid = plan.legacyGuids?.[index];
      const oldGuid = typeof asset.guid === 'string' ? asset.guid : (expectedLegacyGuid ?? next);
      if (
        expectedLegacyGuid !== undefined &&
        oldGuid.toLowerCase() !== expectedLegacyGuid.toLowerCase()
      ) {
        throw new Error(`${relativePath}: ${sourceKey} does not match its owner census GUID`);
      }
      const prior = oldToNew.get(oldGuid.toLowerCase());
      if (prior !== undefined && prior !== next) {
        throw new Error(
          `${relativePath}: old GUID is owned by two different derived identities: ${oldGuid}`,
        );
      }
      oldToNew.set(oldGuid.toLowerCase(), next);
      rows.push({ relativePath, sourceKey, oldGuid, newGuid: next });
    });
  }
  return { oldToNew, rows };
}

async function migrate({ write }) {
  const { oldToNew, rows } = await buildOwnerMap();
  for (const [relativePath, plan] of Object.entries(DIRECT_PACK_PLANS)) {
    const document = await readJson(relativePath);
    if (document.schemaVersion === '3.0.0') continue;
    const projected = projectDirect(document, plan, oldToNew);
    if (write)
      await writeFile(resolve(ROOT, relativePath), `${JSON.stringify(projected, null, 2)}\n`);
  }
  for (const relativePath of COOKED_REFERENCE_FILES) {
    const document = await readJson(relativePath);
    const rewritten = rewriteKnown(document, oldToNew);
    if (write)
      await writeFile(resolve(ROOT, relativePath), `${JSON.stringify(rewritten, null, 2)}\n`);
  }
  return rows;
}

async function check() {
  const { oldToNew, rows } = await buildOwnerMap();
  for (const [relativePath, plan] of Object.entries(DIRECT_PACK_PLANS)) {
    const document = await readJson(relativePath);
    if (document.schemaVersion !== '3.0.0' || document.packageId !== plan.packageId) {
      throw new Error(`${relativePath}: expected the migrated v3 direct envelope`);
    }
    const keys = Object.keys(document.assets ?? {});
    if (keys.join('\0') !== plan.sourceKeys.join('\0')) {
      throw new Error(`${relativePath}: sourceKey order or set differs from the owner plan`);
    }
    for (const [index, sourceKey] of plan.sourceKeys.entries()) {
      const entry = document.assets[sourceKey];
      if (entry === undefined || 'guid' in entry || 'sourceKey' in entry || 'execution' in entry) {
        throw new Error(`${relativePath}: ${sourceKey} still stores legacy output identity`);
      }
      const row = rows.find(
        (candidate) => candidate.relativePath === relativePath && candidate.sourceKey === sourceKey,
      );
      if (
        row === undefined ||
        oldToNew.get(row.oldGuid.toLowerCase()) !== derive(plan.packageId, sourceKey)
      ) {
        throw new Error(
          `${relativePath}: derived identity evidence is incomplete at output ${index}`,
        );
      }
    }
  }
  await checkCookedReferenceClosure(rows, oldToNew);
  return rows;
}

function trackedTemplatePaths(suffix) {
  return execFileSync('git', ['ls-files', '--', 'templates'], { encoding: 'utf8' })
    .split('\n')
    .filter((path) => path.endsWith(suffix));
}

async function audit() {
  const failures = [];
  const directPaths = new Set(Object.keys(DIRECT_PACK_PLANS));
  const packJsonPaths = trackedTemplatePaths('.pack.json');
  const packSourcePaths = trackedTemplatePaths('.pack.ts');
  let directCount = 0;
  let preservedCookedCount = 0;

  await check();
  for (const relativePath of packJsonPaths) {
    const document = await readJson(relativePath);
    if (directPaths.has(relativePath)) {
      if (
        document.schemaVersion !== '3.0.0' ||
        typeof document.packageId !== 'string' ||
        document.assets === null ||
        typeof document.assets !== 'object' ||
        Array.isArray(document.assets)
      ) {
        failures.push(`${relativePath}: expected a v3 direct authoring document`);
        continue;
      }
      directCount += Object.keys(document.assets).length;
      for (const [sourceKey, asset] of Object.entries(document.assets)) {
        if (
          asset === null ||
          typeof asset !== 'object' ||
          'guid' in asset ||
          'sourceKey' in asset ||
          'execution' in asset
        ) {
          failures.push(`${relativePath}: ${sourceKey} contains legacy output identity`);
        }
      }
      continue;
    }
    const preservationReason = PRESERVED_COOKED_PACKS[relativePath];
    if (preservationReason === undefined) {
      failures.push(
        `${relativePath}: unclassified Pack document; assign an owner before preserving it`,
      );
      continue;
    }
    const assets = Array.isArray(document.assets) ? document.assets : [];
    if (
      document.schemaVersion !== '2.0.0' ||
      assets.length === 0 ||
      assets.some((asset) => asset?.execution !== 'cooked')
    ) {
      failures.push(`${relativePath}: expected only ${preservationReason}`);
      continue;
    }
    preservedCookedCount += assets.length;
  }

  for (const relativePath of packSourcePaths) {
    const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
    for (const pattern of [
      /schemaVersion:\s*['"]1\.0\.0['"]/,
      /\bexternalAssets\b/,
      /ScriptablePack(?:Definition|Outputs|AssetDeclaration)/,
      /output\.add\(/,
      /canonical-v1/,
    ]) {
      if (pattern.test(source))
        failures.push(`${relativePath}: forbidden legacy authoring token ${pattern}`);
    }
    if (!/\bdefinePack\s*\(/.test(source)) {
      failures.push(`${relativePath}: Pack source must use definePack()`);
    }
  }

  for (const stalePath of [
    'templates/game-3d/src/asset-ids.ts',
    'templates/game-3d/src/asset-ids.generated.ts',
  ]) {
    if (existsSync(resolve(ROOT, stalePath)))
      failures.push(`${stalePath}: generated output identity table remains`);
  }
  const templateSources = packSourcePaths
    .map((path) => readFileSync(resolve(ROOT, path), 'utf8'))
    .join('\n');
  if (/BROTATO_ASSET_GUIDS|OUTPUT_GUIDS/.test(templateSources)) {
    failures.push('templates: static output GUID table remains in Pack source');
  }
  if (failures.length > 0)
    throw new Error(
      `pack authoring audit failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
    );
  console.log(
    `pack authoring audit passed: ${directCount} v3 template outputs, ${preservedCookedCount} explicitly preserved cooked outputs, ${packSourcePaths.length} Pack sources`,
  );
  for (const [path, reason] of Object.entries(PRESERVED_COOKED_PACKS))
    console.log(`preserved\t${path}\t${reason}`);
}

const mode = process.argv.slice(2);
if (mode.includes('--audit')) {
  await audit();
} else if (mode.includes('--write')) {
  const rows = await migrate({ write: true });
  console.log(
    `migrated ${rows.length} authored outputs and rewrote ${COOKED_REFERENCE_FILES.length} owner-scoped cooked references`,
  );
} else {
  const rows = await check();
  if (mode.includes('--report')) {
    for (const row of rows)
      console.log(`${row.relativePath}\t${row.sourceKey}\t${row.oldGuid}\t${row.newGuid}`);
  } else {
    console.log(`pack authoring migration check passed for ${rows.length} owned outputs`);
  }
}
