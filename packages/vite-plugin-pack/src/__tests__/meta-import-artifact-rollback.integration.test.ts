import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DdcEntryStore, DdcLifecycle } from '@forgeax/engine-ddc';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import {
  commitImportPublication,
  ImporterRegistry,
  type ImportPublicationInput,
  type RunImportMeta,
  stageImportPublication,
} from '@forgeax/engine-import';
import {
  type CatalogBuildResult,
  calculateCatalogDelta,
  currentProjectionFor,
} from '@forgeax/engine-pack/build';
import type { PackIndexEntry } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareMetaImport, startMetaImport as stageMetaImport } from '../dev/meta-import.js';
import { type DevPackBody, packBodyContent } from '../dev/plugin-server.js';

type MetaDraft = Parameters<typeof stageMetaImport>[1];

async function commitFixturePublication(input: ImportPublicationInput) {
  const staged = await stageImportPublication(input);
  return staged.ok ? commitImportPublication(staged.candidate) : staged;
}

async function startMetaImport(
  path: string,
  context: Omit<MetaDraft, 'pendingImportPublications'> & {
    readonly pendingImportPublications?: MetaDraft['pendingImportPublications'];
    readonly publishCatalogDelta?: (delta: unknown) => void;
  },
  prepared?: Parameters<typeof stageMetaImport>[2],
): Promise<PackIndexEntry[]> {
  if (context.pendingImportPublications !== undefined)
    return stageMetaImport(
      path,
      { ...context, pendingImportPublications: context.pendingImportPublications },
      prepared,
    );

  let catalog = context.getCatalogProjection();
  const candidate: MetaDraft = {
    ...context,
    getCatalogProjection: () => catalog,
    setCatalogProjection: (next) => {
      catalog = next;
    },
    metaPackBodies: new Map(context.metaPackBodies),
    devArtifactBodies: new Map(context.devArtifactBodies),
    pendingImportPublications: new Map(),
  };
  const rows = await stageMetaImport(path, candidate, prepared);
  for (const publication of candidate.pendingImportPublications.values()) {
    const committed = await commitFixturePublication(publication);
    if (!committed.ok) {
      const previous = publication.previousCatalog.filter((row) =>
        rows.some((candidate) => candidate.guid === row.guid),
      );
      if (previous.length > 0) return previous;
      throw Object.assign(new Error(committed.error.expected), {
        ...committed.error,
        code: 'import-internal-error',
      });
    }
  }

  const delta = calculateCatalogDelta(context.getCatalogProjection().entries, catalog.entries);
  context.setCatalogProjection(catalog);
  for (const [url, body] of candidate.metaPackBodies) context.metaPackBodies.set(url, body);
  for (const [url, body] of candidate.devArtifactBodies) context.devArtifactBodies.set(url, body);
  if (delta !== undefined) context.publishCatalogDelta?.(delta);
  return rows;
}

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
    entries: [
      {
        guid,
        kind: 'equirect',
        sourcePath: source,
        packageUrl: '/__forgeax-ddc/old.runtime-pack.json',
      } as PackIndexEntry,
    ],
    authority: 'authoritative',
    diagnostics: [],
    declarations: new Map(),
    sourceDeclarations: new Map(),
    packInstances: new Map(),
  };
}

function emptyImageCatalog(): CatalogBuildResult {
  return {
    entries: [],
    authority: 'authoritative',
    diagnostics: [],
    declarations: new Map(),
    sourceDeclarations: new Map(),
    packInstances: new Map(),
  };
}

function assertArtifactClosure(
  packBody: DevPackBody,
  artifacts: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly mimeType: string }>,
  prefix = '/__forgeax-ddc/',
): void {
  const pack = JSON.parse(String(packBodyContent(packBody))) as PackBody;
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
  metaPackBodies = new Map<string, DevPackBody>(),
  devArtifactBodies = new Map<string, { readonly bytes: Uint8Array; readonly mimeType: string }>(),
  pendingImportPublications,
  signal,
  abortAfterRead = false,
  publishCatalogDelta,
}: {
  readonly root: string;
  readonly declaration: RunImportMeta;
  readonly projection: CatalogBuildResult;
  readonly metaPackBodies?: Map<string, DevPackBody>;
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
    cookedProjection: currentProjectionFor('imported-output', 'cooked'),
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

  it('prepares independent real HDR products without publication and consumes the exact source snapshot once', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-meta-prepared-'));
    const source = join(root, 'environment.hdr'),
      metaPath = `${source}.meta.json`;
    await writeFile(source, tinyHdr(17));
    const declaration = imageMeta(source),
      initial = imageContext({ root, declaration, projection: imageCatalogProjection(source) });
    let reads = 0;
    const read = initial.context.fsForImport.readSource;
    initial.context.fsForImport.readSource = async (path) => {
      reads++;
      return read(path);
    };
    const prepared = await prepareMetaImport(metaPath, declaration, initial.context);
    expect(reads).toBeGreaterThan(0);
    const preparedReads = reads;
    expect(initial.context.metaPackBodies.size).toBe(0);
    expect(initial.context.devArtifactBodies.size).toBe(0);
    const result = await startMetaImport(metaPath, initial.context, prepared);
    expect(result.some((row) => row.guid === IMAGE_GUID)).toBe(true);
    expect(reads).toBe(preparedReads);
    expect(initial.context.metaPackBodies.size).toBe(1);
    for (const body of initial.context.metaPackBodies.values())
      assertArtifactClosure(body, initial.context.devArtifactBodies);
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
    expect([...devArtifactBodies.keys()]).toEqual([UNRELATED_ARTIFACT_URL]);
    const unrelatedBody = devArtifactBodies.get(UNRELATED_ARTIFACT_URL);
    expect(unrelatedBody).toBeDefined();
    expect([...(unrelatedBody?.bytes ?? [])]).toEqual([7, 7, 7]);
    expect(await new DdcEntryStore(root).listKeys()).toEqual([]);
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
      packageUrl: '/__forgeax-ddc/unrelated.runtime-pack.json',
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
      String(
        packBodyContent(
          staged.context.metaPackBodies.get(`/__forgeax-ddc/${IMAGE_GUID}.runtime-pack.json`),
        ),
      ),
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
    const packUrl = `/__forgeax-ddc/${IMAGE_GUID}.runtime-pack.json`;
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

    const draft = (
      pendingImportPublications?: Map<string, ImportPublicationInput>,
      abortAfterRead = false,
    ) =>
      imageContext({
        root: root as string,
        declaration,
        projection: accepted.projection,
        metaPackBodies: new Map(accepted.context.metaPackBodies),
        devArtifactBodies: new Map(accepted.context.devArtifactBodies),
        ...(pendingImportPublications === undefined ? {} : { pendingImportPublications }),
        abortAfterRead,
      });
    const assertUnchanged = (context: ReturnType<typeof imageContext> = accepted) => {
      expect(context.context.metaPackBodies.get(packUrl)).toBe(acceptedPack);
      expect(context.context.devArtifactBodies.get(artifactUrl)?.bytes).toEqual(
        acceptedArtifact.bytes,
      );
    };
    const lifecycle = new DdcLifecycle(root);
    const assertCurrent = async () =>
      expect(await lifecycle.inspect(IMAGE_GUID, acceptedHead.currentKey ?? '')).toMatchObject({
        state: 'current',
        currentKey: acceptedHead.currentKey,
      });
    const stage = async () => {
      const pending = new Map<string, ImportPublicationInput>();
      const working = draft(pending);
      await startMetaImport(metaPath, working.context);
      const candidate = pending.values().next().value;
      if (candidate === undefined) throw new Error('expected staged candidate');
      return { working, candidate, pending };
    };

    await writeFile(source, tinyHdr(149, 2));
    const { working: staged, pending } = await stage();
    expect(staged.context.metaPackBodies.get(packUrl)).not.toBe(acceptedPack);
    expect(staged.context.devArtifactBodies.get(artifactUrl)?.bytes).not.toEqual(
      acceptedArtifact.bytes,
    );
    assertUnchanged();
    // Queued source outputs must not acquire a lease while later synchronous
    // cooks can still starve the event loop beyond the 30-second lease TTL.
    const queuedHead = await new DdcLifecycle(root).inspect(IMAGE_GUID, acceptedHead.currentKey);
    expect(queuedHead.state).toBe('current');
    expect(queuedHead.activeLease).toBeUndefined();
    pending.clear();
    await assertCurrent();
    assertUnchanged();

    const aborting = draft(undefined, true);
    await expect(
      startMetaImport(metaPath, { ...aborting.context, signal: aborting.controller.signal }),
    ).rejects.toMatchObject({
      code: 'import-internal-error',
    });
    expect(aborting.projection.entries).toEqual(accepted.projection.entries);
    assertUnchanged(aborting);
    await assertCurrent();

    const { candidate: failedCandidate } = await stage();
    await rm(join(root, 'staging'), { force: true, recursive: true });
    await writeFile(join(root, 'staging'), 'candidate-write-blocked');
    const outerCommit = await commitFixturePublication(failedCandidate);
    expect(outerCommit.ok).toBe(false);
    expect(outerCommit).toMatchObject({
      error: { code: 'source-package-ddc-failed' },
    });
    assertUnchanged();

    await rm(join(root, 'staging'));
    await mkdir(join(root, 'staging'));
    await writeFile(source, tinyHdr(201, 3));
    const { working, candidate } = await stage();
    expect(await commitFixturePublication(candidate)).toMatchObject({ ok: true });
    assertArtifactClosure(
      String(packBodyContent(working.context.metaPackBodies.get(packUrl))),
      working.context.devArtifactBodies,
    );
    assertUnchanged();
  });
});
