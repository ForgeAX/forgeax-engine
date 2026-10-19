import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DdcEntryStore, DdcLifecycle } from '@forgeax/engine-ddc';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import {
  ImporterRegistry,
  publishImportPublication,
  type RunImportMeta,
} from '@forgeax/engine-import';
import type { CatalogBuildResult } from '@forgeax/engine-pack/build';
import type { Importer, PackIndexEntry } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { startMetaImport } from '../dev/meta-import.js';

const GUID = '00000000-0000-4000-8000-000000000001';
const META_PATH = 'assets/fixture.source.meta.json';
const SOURCE_PATH = 'assets/fixture.source';
const PACK_URL = `/__forgeax-ddc/${GUID}.pack.json`;
const ARTIFACT_URL = `/__forgeax-ddc/${GUID}/body.bin`;
const UNRELATED_ARTIFACT_URL = '/__forgeax-ddc/unrelated/body.bin';
const IMAGE_GUID = '019e4a26-3c29-7420-af5d-20f2724a16b0';
const FRESH_IMAGE_GUID = '019e4a26-3c29-7420-af5d-20f2724a16b1';

interface PackBody {
  readonly assets: readonly {
    readonly guid: string;
    readonly artifacts?: Readonly<Record<string, PackArtifactDescriptor>>;
  }[];
}

interface PackArtifactDescriptor {
  readonly path: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly integrity?: { readonly algorithm: 'sha256'; readonly digest: string };
}

const declaration = {
  schemaVersion: '1.0.0',
  kind: 'external-asset-package',
  importer: 'fixture',
  source: SOURCE_PATH,
  importSettings: {},
  subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'fixture' }],
} as const;
const meta: RunImportMeta = declaration;

function catalogEntry(): PackIndexEntry {
  return {
    guid: GUID,
    kind: 'fixture',
    sourcePath: SOURCE_PATH,
    packageUrl: '/__forgeax-ddc/old.pack.json',
  } as PackIndexEntry;
}

function catalogProjection(): CatalogBuildResult {
  return {
    schemaVersion: 'catalog-legacy-v1',
    entries: [catalogEntry()],
    authority: 'authoritative',
    diagnostics: [],
    declarations: new Map([[META_PATH, declaration]]),
    sourceDeclarations: new Map(),
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A valid 8-pixel Radiance RGBE source with deterministic, distinct colours. */
function tinyHdr(seed: number, height = 1): Uint8Array {
  const encoder = new TextEncoder();
  const header = encoder.encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X 8\n`);
  const scanline = new Uint8Array([2, 2, 0, 8]);
  const body = new Uint8Array(height * (scanline.length + 8));
  for (let row = 0; row < height; row += 1) {
    const offset = row * (scanline.length + 8);
    body.set(scanline, offset);
    for (let channel = 0; channel < 4; channel += 1) {
      body.set([136, (seed + channel * 17 + row * 3) & 0xff], offset + 4 + channel * 2);
    }
  }
  const result = new Uint8Array(header.length + body.length);
  result.set(header);
  result.set(body, header.length);
  return result;
}

function imageMeta(source: string, guid = IMAGE_GUID): RunImportMeta {
  return {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    source,
    importSettings: { colorSpace: 'linear', mipmap: 'none' },
    subAssets: [{ guid, sourceIndex: 0, kind: 'equirect' }],
  } as RunImportMeta;
}

function imageCatalogProjection(source: string, guid = IMAGE_GUID): CatalogBuildResult {
  return {
    schemaVersion: 'catalog-legacy-v1',
    entries: [
      {
        guid,
        kind: 'equirect',
        sourcePath: source,
        packageUrl: '/__forgeax-ddc/old.pack.json',
      } as PackIndexEntry,
    ],
    authority: 'authoritative',
    diagnostics: [],
    declarations: new Map(),
    sourceDeclarations: new Map(),
  };
}

function emptyImageCatalog(): CatalogBuildResult {
  return {
    schemaVersion: 'catalog-legacy-v1',
    entries: [],
    authority: 'authoritative',
    diagnostics: [],
    declarations: new Map(),
    sourceDeclarations: new Map(),
  };
}

function cloneBytesMap(
  source: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly mimeType: string }>,
): Map<string, { readonly bytes: Uint8Array; readonly mimeType: string }> {
  return new Map(
    [...source].map(([url, artifact]) => [
      url,
      { bytes: new Uint8Array(artifact.bytes), mimeType: artifact.mimeType },
    ]),
  );
}

function assertArtifactClosure(
  packBody: string,
  artifacts: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly mimeType: string }>,
  prefix = '/__forgeax-ddc/',
): void {
  const pack = JSON.parse(packBody) as PackBody;
  for (const asset of pack.assets) {
    for (const descriptor of Object.values(asset.artifacts ?? {})) {
      const body = artifacts.get(`${prefix}${descriptor.path}`);
      if (body === undefined) throw new Error(`missing artifact ${descriptor.path}`);
      if (body.mimeType !== descriptor.mediaType) {
        throw new Error(`artifact MIME mismatch for ${descriptor.path}`);
      }
      if (body.bytes.byteLength !== descriptor.byteLength) {
        throw new Error(`artifact length mismatch for ${descriptor.path}`);
      }
      if (descriptor.integrity?.digest !== `sha256:${sha256(body.bytes)}`) {
        throw new Error(`artifact digest mismatch for ${descriptor.path}`);
      }
    }
  }
}

function imageContext({
  root,
  declaration: imageDeclaration,
  projection,
  importedGuids = new Set<string>(),
  metaPackBodies = new Map<string, string>(),
  devArtifactBodies = new Map<string, { readonly bytes: Uint8Array; readonly mimeType: string }>(),
  pendingImportPublications,
  signal,
  abortAfterRead = false,
  publishCatalogDelta,
}: {
  readonly root: string;
  readonly declaration: RunImportMeta;
  readonly projection: CatalogBuildResult;
  readonly importedGuids?: Set<string>;
  readonly metaPackBodies?: Map<string, string>;
  readonly devArtifactBodies?: Map<
    string,
    { readonly bytes: Uint8Array; readonly mimeType: string }
  >;
  readonly pendingImportPublications?: Map<
    string,
    import('@forgeax/engine-import').ImportPublicationInput
  >;
  readonly signal?: AbortSignal;
  readonly abortAfterRead?: boolean;
  readonly publishCatalogDelta?: (delta: unknown) => void;
}) {
  let currentProjection = projection;
  const controller = new AbortController();
  const context = {
    ddcRoot: () => root,
    getCatalogProjection: () => currentProjection,
    setCatalogProjection: (next: CatalogBuildResult) => {
      currentProjection = next;
    },
    importedGuids,
    metaPackBodies,
    devArtifactBodies,
    importerRegistry: (() => {
      const registry = new ImporterRegistry();
      registry.register(imageImporter);
      return registry;
    })(),
    fsForImport: {
      readSource: async (sourcePath: string) => {
        try {
          const bytes = new Uint8Array(await readFile(sourcePath));
          if (abortAfterRead) controller.abort();
          return { ok: true as const, value: bytes };
        } catch (error) {
          return { ok: false as const, error };
        }
      },
    },
    publishCatalogDelta: publishCatalogDelta ?? (() => undefined),
    cookedProjection: {},
    declaration: imageDeclaration,
    ...(pendingImportPublications === undefined ? {} : { pendingImportPublications }),
    ...(signal === undefined ? {} : { signal }),
  };
  return {
    context,
    controller,
    get projection() {
      return currentProjection;
    },
  };
}

describe('meta import artifact publication rollback', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('keeps the accepted artifact map while a real DDC candidate write fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-meta-import-artifact-rollback-'));
    let version = 1;
    const importer: Importer = {
      key: 'fixture',
      import: async () => ({
        ok: true,
        value: {
          assets: [
            {
              guid: GUID,
              kind: 'fixture',
              payload: { version },
              refs: [],
              artifacts: {
                body: {
                  mediaType: 'application/octet-stream',
                  bytes: new Uint8Array([version, version + 1, version + 2]),
                },
              },
            },
          ],
          sourceDependencies: [],
        },
      }),
    };
    const importerRegistry = new ImporterRegistry();
    importerRegistry.register(importer);
    const fsForImport = {
      readSource: async () => ({ ok: true as const, value: new Uint8Array([1]) }),
    };
    let projection = catalogProjection();
    const importedGuids = new Set<string>();
    const metaPackBodies = new Map<string, string>();
    const devArtifactBodies = new Map<
      string,
      { readonly bytes: Uint8Array; readonly mimeType: string }
    >([
      [
        UNRELATED_ARTIFACT_URL,
        { bytes: new Uint8Array([7, 7, 7]), mimeType: 'application/octet-stream' },
      ],
    ]);
    const catalogDeltas: unknown[] = [];
    const context = {
      ddcRoot: () => root as string,
      getCatalogProjection: () => projection,
      setCatalogProjection: (next: CatalogBuildResult) => {
        projection = next;
      },
      importedGuids,
      metaPackBodies,
      devArtifactBodies,
      importerRegistry,
      fsForImport,
      publishCatalogDelta: (delta: unknown) => catalogDeltas.push(delta),
      cookedProjection: {},
      declaration: meta,
    };

    const first = await startMetaImport(META_PATH, context);
    expect(first).toHaveLength(1);
    const oldPack = metaPackBodies.get(PACK_URL);
    const oldArtifact = devArtifactBodies.get(ARTIFACT_URL);
    expect(oldPack).toBeDefined();
    expect(oldArtifact).toBeDefined();
    if (oldPack === undefined || oldArtifact === undefined || root === undefined) return;
    const oldArtifactBytes = [...oldArtifact.bytes];
    const oldPackDocument = JSON.parse(oldPack) as PackBody;
    const oldDescriptorPath = oldPackDocument.assets.find((asset) => asset.guid === GUID)?.artifacts
      ?.body?.path;
    expect(oldDescriptorPath).toBe(`${GUID}/body.bin`);
    if (oldDescriptorPath === undefined) return;
    const oldDescriptorArtifactUrl = `/__forgeax-ddc/${oldDescriptorPath}`;
    expect(devArtifactBodies.get(oldDescriptorArtifactUrl)?.bytes).toBe(oldArtifact.bytes);
    const oldCatalog = projection.entries;
    const oldImportedGuids = [...importedGuids];
    const oldHead = await new DdcLifecycle(root).inspect(
      GUID,
      oldCatalog[0]?.publication?.receipt.inputFingerprint ?? '',
    );
    expect(oldHead.state).toBe('current');
    const oldCurrentKey = oldHead.currentKey;
    expect(oldCurrentKey).toBeDefined();
    if (oldCurrentKey === undefined) return;
    const oldDdcEntry = await new DdcEntryStore(root).read(oldCurrentKey);
    expect(oldDdcEntry).not.toBeNull();
    expect([...(oldDdcEntry?.artifacts[oldDescriptorPath]?.bytes ?? [])]).toEqual(oldArtifactBytes);
    const oldRevision = oldHead.revision ?? 0;
    const oldGeneration = oldHead.generation ?? 0;
    const oldDeltaCount = catalogDeltas.length;

    await rm(join(root, 'staging'), { recursive: true, force: true });
    await writeFile(join(root, 'staging'), 'candidate-write-blocked');
    version = 2;

    const failed = await startMetaImport(META_PATH, context);
    expect(failed).toEqual(oldCatalog);
    expect(projection.entries).toEqual(oldCatalog);
    expect(metaPackBodies.get(PACK_URL)).toBe(oldPack);
    expect([...importedGuids]).toEqual(oldImportedGuids);
    expect([...(devArtifactBodies.get(UNRELATED_ARTIFACT_URL)?.bytes ?? [])]).toEqual([7, 7, 7]);
    expect([...(devArtifactBodies.get(oldDescriptorArtifactUrl)?.bytes ?? [])]).toEqual(
      oldArtifactBytes,
    );
    expect(catalogDeltas).toHaveLength(oldDeltaCount);

    const failedRecord = JSON.parse(
      await readFile(join(root, 'heads', `${encodeURIComponent(GUID)}.json`), 'utf8'),
    ) as { desiredKey: string };
    const failedHead = await new DdcLifecycle(root).inspect(GUID, failedRecord.desiredKey);
    expect(failedHead.state).toBe('failed');
    expect(failedRecord.desiredKey).not.toBe(oldCurrentKey);
    expect(failedHead.currentKey).toBe(oldCurrentKey);
    expect(failedHead.revision).toBeGreaterThan(oldRevision);
    expect(failedHead.generation).toBeGreaterThan(oldGeneration);

    await rm(join(root, 'staging'), { force: true });
    await mkdir(join(root, 'staging'));
    const recovered = await startMetaImport(META_PATH, context);
    expect(recovered).toHaveLength(1);
    expect(metaPackBodies.get(PACK_URL)).not.toBe(oldPack);
    const recoveredPackDocument = JSON.parse(metaPackBodies.get(PACK_URL) ?? '') as PackBody;
    const recoveredDescriptorPath = recoveredPackDocument.assets.find(
      (asset) => asset.guid === GUID,
    )?.artifacts?.body?.path;
    expect(recoveredDescriptorPath).toBe(oldDescriptorPath);
    expect([...(devArtifactBodies.get(oldDescriptorArtifactUrl)?.bytes ?? [])]).toEqual([2, 3, 4]);
    expect(importedGuids).toContain(GUID);
    expect(catalogDeltas).toHaveLength(oldDeltaCount + 1);
    const recoveredHead = await new DdcLifecycle(root).inspect(GUID, failedRecord.desiredKey);
    expect(recoveredHead.state).toBe('current');
    expect(recoveredHead.currentKey).toBe(failedRecord.desiredKey);
    expect(recoveredHead.revision).toBeGreaterThan(failedHead.revision ?? 0);
    expect(recoveredHead.generation).toBeGreaterThan(failedHead.generation ?? 0);
    const recoveredDdcEntry = await new DdcEntryStore(root).read(failedRecord.desiredKey);
    expect([...(recoveredDdcEntry?.artifacts[oldDescriptorPath]?.bytes ?? [])]).toEqual([2, 3, 4]);
  });

  it('replays two real HDR inputs through the image importer and preserves the disk closure', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-meta-import-image-rollback-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    const source = join(assets, 'environment.hdr');
    const metaPath = `${source}.meta.json`;
    await writeFile(source, tinyHdr(11));

    const declaration = imageMeta(source);
    const importedGuids = new Set<string>();
    const metaPackBodies = new Map<string, string>();
    const devArtifactBodies = new Map<
      string,
      { readonly bytes: Uint8Array; readonly mimeType: string }
    >();
    const deltas: unknown[] = [];
    const initial = imageContext({
      root,
      declaration,
      projection: imageCatalogProjection(source),
      importedGuids,
      metaPackBodies,
      devArtifactBodies,
      publishCatalogDelta: (delta: unknown) => deltas.push(delta),
    });

    const first = await startMetaImport(metaPath, initial.context);
    expect(first).toHaveLength(1);
    const packUrl = `/__forgeax-ddc/${IMAGE_GUID}.pack.json`;
    const artifactUrl = `/__forgeax-ddc/${IMAGE_GUID}/body.bin`;
    const oldPack = metaPackBodies.get(packUrl);
    const oldArtifact = devArtifactBodies.get(artifactUrl);
    expect(oldPack).toBeDefined();
    expect(oldArtifact).toBeDefined();
    if (oldPack === undefined || oldArtifact === undefined) return;
    expect(oldArtifact.mimeType).toBe('application/x-forgeax-rgba16f');
    expect(oldArtifact.bytes.byteLength).toBe(64);
    expect(() => assertArtifactClosure(oldPack, devArtifactBodies)).not.toThrow();
    const oldPackHash = sha256(new TextEncoder().encode(oldPack));
    const oldArtifactHash = sha256(oldArtifact.bytes);
    const oldCatalog = initial.projection.entries;
    const oldHead = await new DdcLifecycle(root).inspect(
      IMAGE_GUID,
      oldCatalog[0]?.publication?.receipt.inputFingerprint ?? '',
    );
    expect(oldHead.state).toBe('current');
    expect(oldHead.currentKey).toBeDefined();
    if (oldHead.currentKey === undefined) return;
    const oldDdcEntry = await new DdcEntryStore(root).read(oldHead.currentKey);
    expect(oldDdcEntry).not.toBeNull();
    const oldDescriptorPath = (JSON.parse(oldPack) as PackBody).assets[0]?.artifacts?.body?.path;
    expect(oldDescriptorPath).toBe(`${IMAGE_GUID}/body.bin`);
    if (oldDescriptorPath === undefined) return;
    expect(oldDdcEntry?.artifacts[oldDescriptorPath]?.mediaType).toBe(oldArtifact.mimeType);
    expect(oldDdcEntry?.artifacts[oldDescriptorPath]?.bytes).toEqual(oldArtifact.bytes);
    const persistedPack = await readFile(join(root, `${IMAGE_GUID}.pack.json`), 'utf8');
    expect(sha256(new TextEncoder().encode(persistedPack))).toBe(oldPackHash);

    // A second valid HDR uses the same GUID and artifact path but produces a distinct body.
    await writeFile(source, tinyHdr(97, 2));
    await rm(join(root, 'staging'), { recursive: true, force: true });
    await writeFile(join(root, 'staging'), 'candidate-write-blocked');
    const failed = await startMetaImport(metaPath, initial.context);
    expect(failed).toEqual(oldCatalog);
    expect(initial.projection.entries).toEqual(oldCatalog);
    expect(metaPackBodies.get(packUrl)).toBe(oldPack);
    expect(sha256(new TextEncoder().encode(metaPackBodies.get(packUrl) ?? ''))).toBe(oldPackHash);
    expect(devArtifactBodies.get(artifactUrl)?.mimeType).toBe(oldArtifact.mimeType);
    expect(devArtifactBodies.get(artifactUrl)?.bytes).toEqual(oldArtifact.bytes);
    expect([...importedGuids]).toEqual([IMAGE_GUID]);
    expect(deltas).toHaveLength(1);

    // The accepted body and bytes remain readable from the real DDC closure after failure.
    const failedRecord = JSON.parse(
      await readFile(join(root, 'heads', `${encodeURIComponent(IMAGE_GUID)}.json`), 'utf8'),
    ) as { readonly desiredKey: string };
    const failedHead = await new DdcLifecycle(root).inspect(IMAGE_GUID, failedRecord.desiredKey);
    expect(failedHead.state).toBe('failed');
    expect(failedHead.currentKey).toBe(oldHead.currentKey);
    expect(failedRecord.desiredKey).not.toBe(oldHead.currentKey);
    const failedEntry = await new DdcEntryStore(root).read(oldHead.currentKey);
    expect(failedEntry?.artifacts[oldDescriptorPath]?.bytes).toEqual(oldArtifact.bytes);
    expect(await new DdcEntryStore(root).read(failedRecord.desiredKey)).toBeNull();
    expect(await new DdcEntryStore(root).listKeys()).toEqual([oldHead.currentKey]);
    expect(await readFile(join(root, `${IMAGE_GUID}.pack.json`), 'utf8')).toBe(persistedPack);
    expect(sha256(oldArtifact.bytes)).toBe(oldArtifactHash);

    // Repair the staging directory and retry in the same context and GUID.
    await rm(join(root, 'staging'), { force: true });
    await mkdir(join(root, 'staging'));
    const recovered = await startMetaImport(metaPath, initial.context);
    expect(recovered).toHaveLength(1);
    const recoveredPack = metaPackBodies.get(packUrl);
    const recoveredArtifact = devArtifactBodies.get(artifactUrl);
    expect(recoveredPack).toBeDefined();
    expect(recoveredArtifact).toBeDefined();
    if (recoveredPack === undefined || recoveredArtifact === undefined) return;
    expect(recoveredPack).not.toBe(oldPack);
    expect(recoveredArtifact.bytes).not.toEqual(oldArtifact.bytes);
    expect(recoveredArtifact.mimeType).toBe('application/x-forgeax-rgba16f');
    expect(() => assertArtifactClosure(recoveredPack, devArtifactBodies)).not.toThrow();
    expect(deltas).toHaveLength(2);
    const recoveredHead = await new DdcLifecycle(root).inspect(IMAGE_GUID, failedRecord.desiredKey);
    expect(recoveredHead.state).toBe('current');
    expect(recoveredHead.currentKey).toBe(failedRecord.desiredKey);
    expect(recoveredHead.generation).toBeGreaterThan(failedHead.generation ?? 0);
    const recoveredEntry = await new DdcEntryStore(root).read(failedRecord.desiredKey);
    expect(recoveredEntry?.artifacts[oldDescriptorPath]?.bytes).toEqual(recoveredArtifact.bytes);

    // The descriptor is the byte/hash oracle; corrupting only a copied body must fail it.
    const corrupted = cloneBytesMap(devArtifactBodies);
    const corruptedBody = corrupted.get(artifactUrl);
    expect(corruptedBody).toBeDefined();
    if (corruptedBody === undefined) return;
    corruptedBody.bytes[0] = (corruptedBody.bytes[0] ?? 0) ^ 0xff;
    expect(() => assertArtifactClosure(recoveredPack, corrupted)).toThrow(/digest mismatch/);
  });

  it('fails a fresh real-image publication without leaking a new artifact key', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-meta-import-image-fresh-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    const source = join(assets, 'fresh.hdr');
    const metaPath = `${source}.meta.json`;
    await writeFile(source, tinyHdr(31));
    const unrelated = new Uint8Array([7, 7, 7]);
    const devArtifactBodies = new Map([
      [UNRELATED_ARTIFACT_URL, { bytes: unrelated, mimeType: 'application/octet-stream' }],
    ]);
    const contextState = imageContext({
      root,
      declaration: imageMeta(source, FRESH_IMAGE_GUID),
      projection: emptyImageCatalog(),
      devArtifactBodies,
    });
    await rm(join(root, 'staging'), { recursive: true, force: true });
    await writeFile(join(root, 'staging'), 'first-publication-blocked');

    await expect(startMetaImport(metaPath, contextState.context)).rejects.toMatchObject({
      code: 'import-internal-error',
    });
    expect(contextState.projection.entries).toEqual([]);
    expect(contextState.context.metaPackBodies.size).toBe(0);
    expect([...contextState.context.importedGuids]).toEqual([]);
    expect([...devArtifactBodies.keys()]).toEqual([UNRELATED_ARTIFACT_URL]);
    const unrelatedBody = devArtifactBodies.get(UNRELATED_ARTIFACT_URL);
    expect(unrelatedBody).toBeDefined();
    expect([...(unrelatedBody?.bytes ?? [])]).toEqual([7, 7, 7]);
    expect(await new DdcEntryStore(root).listKeys()).toEqual([]);
    expect(await readFile(join(root, `${FRESH_IMAGE_GUID}.pack.json`)).catch(() => undefined)).toBe(
      undefined,
    );
  });

  it('stages an image import without traversing unrelated catalog payloads before commit', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-meta-import-staged-catalog-'));
    const source = join(root, 'staged.hdr');
    await writeFile(source, tinyHdr(41));
    let payloadReads = 0;
    const unrelated: PackIndexEntry = {
      guid: '00000000-0000-4000-8000-000000000099',
      kind: 'texture',
      sourcePath: 'assets/unrelated.png',
      packageUrl: '/__forgeax-ddc/unrelated.pack.json',
      sourceOverrides: {
        surface: {
          get roughness() {
            payloadReads += 1;
            return 0.8;
          },
        },
      },
    };
    const projection = imageCatalogProjection(source);
    const pending = new Map<string, import('@forgeax/engine-import').ImportPublicationInput>();
    const deltas: unknown[] = [];
    const staged = imageContext({
      root,
      declaration: imageMeta(source),
      projection: { ...projection, entries: [...projection.entries, unrelated] },
      pendingImportPublications: pending,
      publishCatalogDelta: (delta) => deltas.push(delta),
    });

    const rows = await startMetaImport(`${source}.meta.json`, staged.context);

    expect(rows.map((row) => row.guid)).toEqual([IMAGE_GUID]);
    expect(pending.size).toBe(1);
    expect(staged.projection.entries.find((row) => row.guid === unrelated.guid)).toBe(unrelated);
    expect(deltas).toEqual([]);
    expect(payloadReads).toBe(0);
    assertArtifactClosure(
      staged.context.metaPackBodies.get(`/__forgeax-ddc/${IMAGE_GUID}.pack.json`) ?? '',
      staged.context.devArtifactBodies,
    );
  });

  it('keeps accepted maps outside staged, aborted, discarded, and failed outer commits', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-meta-import-staged-controls-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    const source = join(assets, 'controls.hdr');
    const metaPath = `${source}.meta.json`;
    await writeFile(source, tinyHdr(41));
    const declaration = imageMeta(source);
    const accepted = imageContext({
      root,
      declaration,
      projection: imageCatalogProjection(source),
    });
    await startMetaImport(metaPath, accepted.context);
    const packUrl = `/__forgeax-ddc/${IMAGE_GUID}.pack.json`;
    const artifactUrl = `/__forgeax-ddc/${IMAGE_GUID}/body.bin`;
    const acceptedPack = accepted.context.metaPackBodies.get(packUrl);
    const acceptedArtifact = accepted.context.devArtifactBodies.get(artifactUrl);
    expect(acceptedPack).toBeDefined();
    expect(acceptedArtifact).toBeDefined();
    if (acceptedPack === undefined || acceptedArtifact === undefined) return;
    const acceptedHead = await new DdcLifecycle(root).inspect(
      IMAGE_GUID,
      accepted.projection.entries[0]?.publication?.receipt.inputFingerprint ?? '',
    );
    if (acceptedHead.currentKey === undefined) return;

    await writeFile(source, tinyHdr(149, 2));
    const stagedPending = new Map<
      string,
      import('@forgeax/engine-import').ImportPublicationInput
    >();
    const staged = imageContext({
      root,
      declaration,
      projection: accepted.projection,
      importedGuids: new Set(accepted.context.importedGuids),
      metaPackBodies: new Map(accepted.context.metaPackBodies),
      devArtifactBodies: new Map(accepted.context.devArtifactBodies),
      pendingImportPublications: stagedPending,
    });
    await startMetaImport(metaPath, staged.context);
    const stagedCandidate = [...stagedPending.values()][0];
    expect(stagedCandidate).toBeDefined();
    expect(staged.context.metaPackBodies.get(packUrl)).not.toBe(acceptedPack);
    expect(staged.context.devArtifactBodies.get(artifactUrl)?.bytes).not.toEqual(
      acceptedArtifact.bytes,
    );
    expect(accepted.context.metaPackBodies.get(packUrl)).toBe(acceptedPack);
    expect(accepted.context.devArtifactBodies.get(artifactUrl)?.bytes).toEqual(
      acceptedArtifact.bytes,
    );
    if (stagedCandidate === undefined) return;
    // Queued source outputs must not acquire a lease while later synchronous
    // cooks can still starve the event loop beyond the 30-second lease TTL.
    const queuedHead = await new DdcLifecycle(root).inspect(IMAGE_GUID, acceptedHead.currentKey);
    expect(queuedHead.state).toBe('current');
    expect(queuedHead.activeLease).toBeUndefined();
    stagedPending.clear();
    expect(await new DdcLifecycle(root).inspect(IMAGE_GUID, acceptedHead.currentKey)).toMatchObject(
      {
        state: 'current',
        currentKey: acceptedHead.currentKey,
      },
    );
    expect(accepted.context.metaPackBodies.get(packUrl)).toBe(acceptedPack);
    expect(accepted.context.devArtifactBodies.get(artifactUrl)?.bytes).toEqual(
      acceptedArtifact.bytes,
    );

    // An abort before the finalizer is allowed to finish never mutates the accepted context.
    const aborting = imageContext({
      root,
      declaration,
      projection: accepted.projection,
      importedGuids: new Set(accepted.context.importedGuids),
      metaPackBodies: new Map(accepted.context.metaPackBodies),
      devArtifactBodies: new Map(accepted.context.devArtifactBodies),
      abortAfterRead: true,
    });
    await expect(
      startMetaImport(metaPath, { ...aborting.context, signal: aborting.controller.signal }),
    ).rejects.toMatchObject({
      code: 'import-internal-error',
    });
    expect(aborting.projection.entries).toEqual(accepted.projection.entries);
    expect(aborting.context.metaPackBodies.get(packUrl)).toBe(acceptedPack);
    expect(aborting.context.devArtifactBodies.get(artifactUrl)?.bytes).toEqual(
      acceptedArtifact.bytes,
    );
    expect(await new DdcLifecycle(root).inspect(IMAGE_GUID, acceptedHead.currentKey)).toMatchObject(
      {
        state: 'current',
        currentKey: acceptedHead.currentKey,
      },
    );

    // Simulate the production bridge's outer commit failing after DDC commit: transport restore
    // returns the DDC head to A, while the disposable B candidate never enters accepted maps.
    const failedPending = new Map<
      string,
      import('@forgeax/engine-import').ImportPublicationInput
    >();
    const failedCandidateContext = imageContext({
      root,
      declaration,
      projection: accepted.projection,
      importedGuids: new Set(accepted.context.importedGuids),
      metaPackBodies: new Map(accepted.context.metaPackBodies),
      devArtifactBodies: new Map(accepted.context.devArtifactBodies),
      pendingImportPublications: failedPending,
    });
    await startMetaImport(metaPath, failedCandidateContext.context);
    const failedCandidate = [...failedPending.values()][0];
    expect(failedCandidate).toBeDefined();
    if (failedCandidate === undefined) return;
    await rm(join(root, `${IMAGE_GUID}.pack.json`), { force: true, recursive: true });
    await mkdir(join(root, `${IMAGE_GUID}.pack.json`));
    const outerCommit = await publishImportPublication(failedCandidate);
    expect(outerCommit.ok).toBe(false);
    expect(outerCommit).toMatchObject({
      error: { code: 'source-package-publication-invalid' },
    });
    expect(accepted.context.metaPackBodies.get(packUrl)).toBe(acceptedPack);
    expect(accepted.context.devArtifactBodies.get(artifactUrl)?.bytes).toEqual(
      acceptedArtifact.bytes,
    );

    // A later successful outer commit installs the candidate's complete closure only after the
    // DDC/transport publication succeeds, matching the production bridge's Object.assign fence.
    await rm(join(root, `${IMAGE_GUID}.pack.json`), { recursive: true, force: true });
    await writeFile(source, tinyHdr(201, 3));
    const successfulPending = new Map<
      string,
      import('@forgeax/engine-import').ImportPublicationInput
    >();
    const successfulCandidateContext = imageContext({
      root,
      declaration,
      projection: accepted.projection,
      importedGuids: new Set(accepted.context.importedGuids),
      metaPackBodies: new Map(accepted.context.metaPackBodies),
      devArtifactBodies: new Map(accepted.context.devArtifactBodies),
      pendingImportPublications: successfulPending,
    });
    await startMetaImport(metaPath, successfulCandidateContext.context);
    const successfulCandidate = [...successfulPending.values()][0];
    expect(successfulCandidate).toBeDefined();
    if (successfulCandidate === undefined) return;
    const successfulCommit = await publishImportPublication(successfulCandidate);
    expect(successfulCommit).toMatchObject({ ok: true, transportPersisted: true });
    accepted.context.setCatalogProjection(successfulCandidateContext.projection);
    accepted.context.metaPackBodies.clear();
    for (const [url, body] of successfulCandidateContext.context.metaPackBodies) {
      accepted.context.metaPackBodies.set(url, body);
    }
    accepted.context.devArtifactBodies.clear();
    for (const [url, body] of successfulCandidateContext.context.devArtifactBodies) {
      accepted.context.devArtifactBodies.set(url, body);
    }
    expect(() =>
      assertArtifactClosure(
        successfulCandidateContext.context.metaPackBodies.get(packUrl) ?? '',
        accepted.context.devArtifactBodies,
      ),
    ).not.toThrow();
  });
});
