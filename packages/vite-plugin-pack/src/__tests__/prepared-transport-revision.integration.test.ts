import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { projectImportProductForBuild } from '@forgeax/engine-import';
import {
  finalizePackageTransportSource,
  packageTransportRevision,
} from '@forgeax/engine-pack/build';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ProjectedPack = ReturnType<typeof projectImportProductForBuild>;
const captured = vi.hoisted(() => ({ projections: [] as ProjectedPack[] }));
vi.mock('@forgeax/engine-import', async () => {
  const actual =
    await vi.importActual<typeof import('@forgeax/engine-import')>('@forgeax/engine-import');
  return {
    ...actual,
    projectImportProductForBuild(...args: Parameters<typeof actual.projectImportProductForBuild>) {
      const projected = actual.projectImportProductForBuild(...args);
      captured.projections.push(projected);
      return projected;
    },
  };
});

import { createPluginPackInternal } from '../plugin-pack.js';

const PACKAGE = '01900000-0000-7000-8000-000000000082';
const parsed = PackageId.parse(PACKAGE);
if (!parsed.ok) throw parsed.error;
const packageId = parsed.value;
const OUTPUT_GUID = AssetGuid.format(AssetGuid.derive(packageId, 'fixture/typed'));
const REF_GUID = AssetGuid.format(AssetGuid.derive(packageId, 'scene/ref'));

type Middleware = (
  request: { readonly url: string; readonly method: string },
  response: {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string | Uint8Array): void;
  },
  next: () => void,
) => unknown;

async function request(middlewares: readonly Middleware[], url: string) {
  const response = { status: 200, body: '' as string | Uint8Array };
  for (const middleware of middlewares) {
    let next = false;
    await middleware(
      { url, method: 'GET' },
      {
        get statusCode() {
          return response.status;
        },
        set statusCode(value) {
          response.status = value;
        },
        setHeader() {},
        end(body) {
          response.body = body ?? '';
        },
      },
      () => {
        next = true;
      },
    );
    if (!next) break;
  }
  expect(response.status, JSON.stringify({ url, body: response.body })).toBe(200);
  return response.body;
}

function source(marker: number): string {
  return `export default {
    schemaVersion: '2.0.0', packageId: new Uint8Array(${JSON.stringify([...packageId])}),
    build() { return { ok: true, value: {
      'scene/ref': { kind: 'scene', entities: {} },
      'fixture/typed': { kind: 'test-typed-revision', execution: 'cooked', source: { marker: ${marker} } }
    } }; }
  };`;
}

function payload(marker: number) {
  const repeated = new Float32Array([marker, 0.125, -2.5]);
  return {
    kind: 'test-typed-revision',
    marker,
    views: {
      f32: repeated,
      f64: new Float64Array([marker, 0.0625]),
      u8: new Uint8Array([marker, 255]),
      u16: new Uint16Array([marker, 65535]),
      u32: new Uint32Array([marker, 4294967295]),
      i8: new Int8Array([-128, marker]),
      i16: new Int16Array([-32768, marker]),
      i32: new Int32Array([-2147483648, marker]),
    },
    nested: [{ repeated }, null, ['keep', marker]],
  };
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'prepared-transport-revision-')));
  const assets = join(root, 'assets');
  await mkdir(assets);
  const sourcePath = join(assets, 'fixture.pack.ts');
  await writeFile(sourcePath, source(1));
  const cookMarkers: number[] = [];
  const cooker: NativeCooker = {
    key: 'test-typed-revision',
    cook(raw: unknown) {
      const input = raw as { guid: string; source: { marker: number } };
      const marker = input.source.marker;
      cookMarkers.push(marker);
      return {
        guid: input.guid,
        payload: payload(marker),
        refs: [REF_GUID],
        artifacts: {
          'module.bin': {
            mediaType: 'application/octet-stream',
            bytes: new Uint8Array([marker, 0, 255, 3, 7]),
          },
        },
        inputFingerprint: `typed-fixture:${marker}`,
      };
    },
  };
  const plugin = createPluginPackInternal({
    roots: [assets],
    watch: false,
    cookers: [cooker],
    ddc: { projectDdcRoot: join(root, 'ddc') },
    sourceIdentityFor: () => 'assets/fixture.pack.ts',
  });
  const middlewares: Middleware[] = [];
  plugin.configureServer({
    middlewares: { use: (middleware) => middlewares.push(middleware as Middleware) },
    ws: { send() {} },
  });
  const binding = createStandaloneRuntimeAssetBinding('prepared-transport-revision');
  await plugin.rebind(binding, [assets]);
  return { root, sourcePath, plugin, middlewares, cookMarkers, binding };
}

async function verifyTransport(
  setup: Awaited<ReturnType<typeof fixture>>,
  marker: number,
  projected: ProjectedPack,
) {
  const entry = setup.plugin.catalogSnapshot().find((row) => row.guid === OUTPUT_GUID);
  expect(entry).toBeDefined();
  if (entry?.publication === undefined || entry.cookReceiptUrl === undefined)
    throw new Error('accepted typed publication and receipt required');
  const fingerprint = entry.publication.receipt.inputFingerprint;
  const revision = `${fingerprint}:${packageTransportRevision(projected)}`.replace(
    /[^a-zA-Z0-9._-]/g,
    '-',
  );
  const expected = await finalizePackageTransportSource(projected, {
    base: '/',
    packagePath: `__forgeax-ddc/${PACKAGE}.${revision}.pack.json`,
    artifactPath: (guid, key) =>
      `${guid.toLowerCase()}/${revision}/${key.includes('.') ? key : `${key}.bin`}`,
  });
  expect(expected.sourceRevision).toBe(packageTransportRevision(projected));
  expect(entry.packageUrl).toContain(`${PACKAGE}.${revision}.pack.json`);
  expect(entry.cookReceiptUrl).toContain(`${OUTPUT_GUID}.${revision}.receipt.json`);
  expect(entry.refs).toEqual([REF_GUID]);
  expect(entry.publication.digest).toBe(expected.digest);
  const body = await request(
    setup.middlewares,
    `${setup.binding.catalogUrl.replace(/\/catalog\.json$/, '/asset')}${entry.packageUrl}`,
  );
  if (typeof body !== 'string') throw new Error('Pack JSON text required');
  const pack = JSON.parse(body) as { assets: typeof expected.pack.assets };
  expect(pack.assets).toEqual(expected.pack.assets);
  const asset = pack.assets.find((row) => row.guid === OUTPUT_GUID);
  expect(asset?.payload).toEqual({
    kind: 'test-typed-revision',
    marker,
    views: {
      f32: [marker, 0.125, -2.5],
      f64: [marker, 0.0625],
      u8: [marker, 255],
      u16: [marker, 65535],
      u32: [marker, 4294967295],
      i8: [-128, marker],
      i16: [-32768, marker],
      i32: [-2147483648, marker],
    },
    nested: [{ repeated: [marker, 0.125, -2.5] }, null, ['keep', marker]],
  });
  // Supported views are emitted as JSON arrays, including repeated and nested views.
  expect(asset?.payload).toMatchObject({
    views: { f32: [marker, 0.125, -2.5], u8: [marker, 255] },
  });
  const descriptor = asset?.artifacts['module.bin'];
  if (descriptor === undefined) throw new Error('native artifact descriptor required');
  const artifactPath = new URL(descriptor.path, `http://fixture.test${entry.packageUrl}`).pathname;
  const artifact = await request(
    setup.middlewares,
    `${setup.binding.catalogUrl.replace(/\/catalog\.json$/, '/asset')}${artifactPath}`,
  );
  expect(artifact).toEqual(new Uint8Array([marker, 0, 255, 3, 7]));
  const receipt = await request(
    setup.middlewares,
    `${setup.binding.catalogUrl.replace(/\/catalog\.json$/, '/asset')}${entry.cookReceiptUrl}`,
  );
  expect(typeof receipt === 'string' ? receipt : new TextDecoder().decode(receipt)).toBe(
    JSON.stringify({
      guid: OUTPUT_GUID,
      origin: 'sourceMeta',
      status: 'succeeded',
      inputFingerprint: fingerprint,
      outputDigest: expected.digest,
    }),
  );
  return { entry, body, artifact, receipt };
}

describe('prepared ScriptablePack transport revision reuse', () => {
  beforeEach(() => {
    captured.projections.length = 0;
  });

  it('publishes identical typed payload, refs, artifact and receipt with one caller projection', async () => {
    const setup = await fixture();
    try {
      await setup.plugin.ready();
      const projected = captured.projections[0];
      if (projected === undefined) throw new Error('actual policy projection required');
      await verifyTransport(setup, 1, projected);
      expect(setup.cookMarkers).toEqual([1]);
      expect(captured.projections).toHaveLength(1);
    } finally {
      await setup.plugin.closeBundle();
      await rm(setup.root, { recursive: true, force: true });
    }
  });

  it('recomputes the revision for a later source mutation and preserves the unchanged accepted tuple', async () => {
    const setup = await fixture();
    try {
      await setup.plugin.ready();
      const firstProjection = captured.projections[0];
      if (firstProjection === undefined) throw new Error('initial projection required');
      const first = await verifyTransport(setup, 1, firstProjection);
      captured.projections.length = 0;
      await writeFile(setup.sourcePath, source(2));
      expect(await setup.plugin.rebuildCatalogInPlace([setup.sourcePath])).toBe(true);
      const changedProjection = captured.projections[0];
      if (changedProjection === undefined) throw new Error('mutated source projection required');
      const changed = await verifyTransport(setup, 2, changedProjection);
      expect(changed.entry.packageUrl).not.toBe(first.entry.packageUrl);
      expect(changed.entry.publication?.sourceRevision).not.toBe(
        first.entry.publication?.sourceRevision,
      );
      expect(changed.entry.publication?.digest).not.toBe(first.entry.publication?.digest);
      expect(changed.entry.publication?.generation).toBeGreaterThan(
        first.entry.publication?.generation ?? 0,
      );
      expect(changed.artifact).not.toEqual(first.artifact);
      expect(setup.cookMarkers).toContain(2);
      await setup.plugin.rebuildCatalogInPlace([setup.sourcePath]);
      const unchanged = setup.plugin.catalogSnapshot().find((row) => row.guid === OUTPUT_GUID);
      if (unchanged === undefined) throw new Error('unchanged accepted publication required');
      expect(unchanged.publication).toEqual(changed.entry.publication);
      expect(unchanged.packageUrl).toBe(changed.entry.packageUrl);
      expect(
        await request(
          setup.middlewares,
          `${setup.binding.catalogUrl.replace(/\/catalog\.json$/, '/asset')}${unchanged.packageUrl}`,
        ),
      ).toBe(changed.body);
      expect(
        await request(
          setup.middlewares,
          `${setup.binding.catalogUrl.replace(/\/catalog\.json$/, '/asset')}${unchanged.cookReceiptUrl ?? ''}`,
        ),
      ).toEqual(changed.receipt);
    } finally {
      await setup.plugin.closeBundle();
      await rm(setup.root, { recursive: true, force: true });
    }
  });
});
