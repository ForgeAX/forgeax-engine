// @ts-check

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gltfImporter } from '@forgeax/engine-gltf';
import { ImporterRegistry, normaliseForPack, produceSourcePackage } from '@forgeax/engine-import';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { isEngineMaterial, readShaderManifestPublication } from '@forgeax/engine-shader';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const baseline = 'f34758bab0284ac1d63f55b701170ab4d8793299';
/** @param {string | Uint8Array} bytes */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** @param {unknown} value */
const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Fixture-specific build-time publication. It does not load a runtime Pack,
 * alter importer refs, compile shaders, or claim GPU resource readiness.
 * @param {{ output: string, shaderManifest?: string }} options
 */
export async function prepareLodIncrementalInputs(options) {
  const output = resolve(options.output);
  // Publish into a fresh directory: failed runs retain their evidence and
  // cannot leave a previously successful manifest pointing at partial files.
  const metaPath = resolve(appRoot, 'assets/lod-scene.gltf.meta.json');
  const metaBytes = await readFile(metaPath);
  /** @type {import('@forgeax/engine-import').RunImportMeta} */
  const meta = JSON.parse(metaBytes.toString('utf8'));
  const sourcePath = resolve(dirname(metaPath), meta.source);
  const sourceBytes = await readFile(sourcePath);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: appRoot,
    encoding: 'utf8',
  }).trim();
  const importers = new ImporterRegistry();
  importers.register(gltfImporter);
  const imported = await produceSourcePackage({
    meta,
    registry: importers,
    fs: {
      sourceIdentityFor: () => meta.source,
      readSource: async (path) => {
        if (path !== meta.source) throw new Error(`Unexpected source read: ${path}`);
        return { ok: true, value: sourceBytes };
      },
      readSibling: async () => {
        throw new Error('The embedded E03 fixture must not request sibling resources');
      },
    },
  });
  if (!imported.ok) throw new Error(JSON.stringify(imported.error));
  const assets = imported.value.product.assets;
  /** @param {string} kind @param {number} index */
  const declaration = (kind, index) => {
    const row = meta.subAssets.find((asset) => asset.kind === kind && asset.sourceIndex === index);
    if (!row) throw new Error(`Missing E03 declaration: ${kind}/${index}`);
    return row.guid;
  };
  const roles = {
    root: declaration('mesh', 0),
    middle: declaration('mesh', 1),
    lowest: declaration('mesh', 2),
    material: declaration('material', 0),
    scene: declaration('scene', 0),
  };
  if (assets.length !== 5)
    throw new Error('E03 requires exactly three meshes, one material and one scene');
  const material = assets.find((asset) => asset.guid === roles.material);
  /** @type {import('@forgeax/engine-types').MaterialAsset} */
  const materialPayload = /** @type {import('@forgeax/engine-types').MaterialAsset} */ (
    material?.payload
  );
  if (
    !material ||
    material.refs.length !== 0 ||
    !materialPayload.passes ||
    !isEngineMaterial(materialPayload)
  ) {
    throw new Error('E03 requires an engine-owned material with no external resource refs');
  }
  const root = assets.find((asset) => asset.guid === roles.root);
  /** @type {import('@forgeax/engine-types').MeshAsset} */
  const rootPayload = /** @type {import('@forgeax/engine-types').MeshAsset} */ (root?.payload);
  if (
    !root ||
    rootPayload.lods?.length !== 2 ||
    AssetGuid.format(rootPayload.lods[0].mesh) !== roles.middle ||
    AssetGuid.format(rootPayload.lods[1].mesh) !== roles.lowest ||
    ![roles.material, roles.middle, roles.lowest].every((guid) =>
      root.refs.some((ref) => ref.guid === guid),
    )
  )
    throw new Error('Original E03 root LOD/ref contract is missing');
  for (const asset of assets) {
    for (const ref of asset.refs) {
      if (!assets.some((target) => target.guid === ref.guid))
        throw new Error(`Missing ref closure: ${ref.guid}`);
    }
  }
  const programs = [...new Set(materialPayload.passes.map((pass) => pass.program.module))];
  /** @type {{ status: 'not-prepared' | 'cpu-publication-verified', programs: string[], publication?: {path: string, sha256: string, byteLength: number}, gpuReadiness: 'unverified' }} */
  const shaderClosure = { status: 'not-prepared', programs, gpuReadiness: 'unverified' };
  let shaderBytes;
  if (options.shaderManifest !== undefined) {
    shaderBytes = await readFile(resolve(options.shaderManifest));
    const expanded = await readShaderManifestPublication(JSON.parse(shaderBytes.toString('utf8')));
    /** @type {{ materialShaders?: {identifier: string}[] }} */
    const publication = /** @type {{ materialShaders?: {identifier: string}[] }} */ (expanded);
    if (
      !programs.every((module) =>
        publication.materialShaders?.some((row) => row.identifier === module),
      )
    ) {
      throw new Error('Shader publication is missing an original material program');
    }
    shaderClosure.status = 'cpu-publication-verified';
    shaderClosure.publication = {
      path: 'shaders/manifest.json',
      sha256: sha256(shaderBytes),
      byteLength: shaderBytes.byteLength,
    };
  }
  const modules = await Promise.all(
    ['@forgeax/engine-gltf', '@forgeax/engine-import', '@forgeax/engine-shader'].map(
      async (specifier) => ({
        specifier,
        sha256: sha256(await readFile(fileURLToPath(import.meta.resolve(specifier)))),
      }),
    ),
  );
  await mkdir(output); // An existing directory is an error, including a prior failed attempt.
  await mkdir(resolve(output, 'assets'));
  await mkdir(resolve(output, 'artifacts'));
  if (shaderBytes) {
    await mkdir(resolve(output, 'shaders'));
    await writeFile(resolve(output, 'shaders/manifest.json'), shaderBytes);
  }
  const rows = [];
  for (const asset of assets) {
    /** @type {Record<string, import('@forgeax/engine-types').ArtifactDescriptor>} */
    const artifacts = {};
    for (const [key, body] of Object.entries(asset.artifacts)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error(`Unsupported artifact key: ${key}`);
      const path = `artifacts/${asset.guid}-${key}.bin`;
      const digest = sha256(body.bytes);
      artifacts[key] = {
        path,
        mediaType: body.mediaType,
        assetCodec: body.assetCodec,
        contentEncoding: 'identity',
        byteLength: body.bytes.byteLength,
        integrity: { algorithm: 'sha256', digest },
      };
      await writeFile(resolve(output, path), body.bytes);
    }
    const bytes = jsonBytes({
      guid: asset.guid,
      kind: asset.kind,
      name: asset.name,
      payload: normaliseForPack(asset.payload),
      refs: asset.refs,
      artifacts,
    });
    const path = `assets/${asset.guid}.json`;
    await writeFile(resolve(output, path), bytes);
    rows.push({
      guid: asset.guid,
      kind: asset.kind,
      refs: asset.refs,
      path,
      sha256: sha256(bytes),
      byteLength: Buffer.byteLength(bytes),
      artifacts,
    });
  }
  const manifest = {
    schemaVersion: 'e03-incremental-inputs/1',
    provenance: {
      baseline,
      producerHead: head,
      producer: 'produceSourcePackage(gltfImporter)',
      modules,
      source: { path: `assets/${meta.source}`, sha256: sha256(sourceBytes) },
      meta: { path: 'assets/lod-scene.gltf.meta.json', sha256: sha256(metaBytes) },
      sourceDependencies: imported.value.product.sourceDependencies,
    },
    roles,
    admission: {
      initial: [roles.material, roles.middle, roles.root],
      later: [roles.lowest],
      excluded: [roles.scene],
      route: 'public loaders -> AssetRegistry.catalog(original guid, payload, refs)',
    },
    assets: rows,
    shaderClosure,
  };
  // Manifest is the final publication. No manifest is returned on a partial write.
  await writeFile(resolve(output, 'manifest.json'), jsonBytes(manifest));
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const supported = new Set(['--output', '--shader-manifest']);
  if (
    args.length === 0 ||
    args.length % 2 !== 0 ||
    args.some((arg, i) => i % 2 === 0 && !supported.has(arg))
  ) {
    throw new Error(
      'Usage: node scripts/prepare-lod-incremental-inputs.mjs --output <fresh-directory> [--shader-manifest <manifest.json>]',
    );
  }
  const outputIndex = args.indexOf('--output');
  const shaderIndex = args.indexOf('--shader-manifest');
  if (outputIndex < 0) throw new Error('--output is required');
  const manifest = await prepareLodIncrementalInputs({
    output: /** @type {string} */ (args[outputIndex + 1]),
    ...(shaderIndex >= 0 ? { shaderManifest: args[shaderIndex + 1] } : {}),
  });
  process.stdout.write(
    `${JSON.stringify({
      output: resolve(args[outputIndex + 1]),
      roles: manifest.roles,
      shaderClosure: manifest.shaderClosure,
    })}\n`,
  );
}
