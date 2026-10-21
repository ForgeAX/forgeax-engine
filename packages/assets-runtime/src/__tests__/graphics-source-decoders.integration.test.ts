import { createHash } from 'node:crypto';
import { fontContribution } from '@forgeax/engine-font';
import { tilesetContribution, videoContribution } from '@forgeax/engine-graphics-extras';
import { textureContribution } from '@forgeax/engine-image';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { samplerContribution } from '@forgeax/engine-render';
import {
  type CatalogDelta,
  type CatalogEntry,
  type MaterialAsset,
  ok,
  type VideoAsset,
} from '@forgeax/engine-types';
import { afterEach, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';

const ROOT = '11111111-1111-4111-8111-111111111111';
const ATLAS = '22222222-2222-4222-8222-222222222222';
const SAMPLER = '33333333-3333-4333-8333-333333333333';
const owners: AssetRegistry[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

function fixture(kind: 'tileset' | 'font' | 'video') {
  let rows: CatalogEntry[] = [];
  let revision = 0;
  const packages = new Map<string, string | Uint8Array>();
  const listeners = new Set<(delta: CatalogDelta) => void>();
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const content = packages.get(String(input));
    return new Response(content as BodyInit | undefined, {
      status: content === undefined ? 404 : 200,
    });
  });
  const assets = new AssetRegistry({
    scopeId: 'graphics-source',
    catalog: {
      enumerate: async () => ok(rows),
      openPackage: () => fetcher,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  });
  assets.installDecoder(videoContribution.kind, videoContribution.decoder);
  assets.installDecoder(tilesetContribution.kind, tilesetContribution.decoder);
  assets.installDecoder(fontContribution.kind, fontContribution.decoder);
  assets.installDecoder(textureContribution.kind, textureContribution.decoder);
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  owners.push(assets);
  function publish(payload: unknown, refs: string[] = [], body?: unknown) {
    const packageUrl = `https://graphics.invalid/${++revision}/pack.json`;
    const bytes =
      body === undefined
        ? undefined
        : new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
    const publication = createRuntimePackPublication({
      scopeId: 'graphics-source',
      sourcePath: 'graphics.pack',
      sourceRevision: String(revision),
      packageUrl,
      pack: {
        assets: [
          {
            guid: ROOT,
            kind,
            payload,
            refs,
            artifacts:
              bytes === undefined
                ? {}
                : {
                    body: {
                      path: 'body.json',
                      mediaType: 'application/json',
                      contentEncoding: 'identity',
                      byteLength: bytes.length,
                      integrity: {
                        algorithm: 'sha256',
                        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
                      },
                    },
                  },
          },
          {
            guid: ATLAS,
            kind: 'texture',
            refs: [],
            artifacts: {},
            payload: {
              kind: 'texture',
              shape: { viewDimension: '2d', extent: { width: 2, height: 1 } },
              format: 'rgba8unorm',
              colorSpace: 'linear',
              mips: { kind: 'none' },
              data: [255, 0, 0, 255, 0, 255, 0, 255],
            },
          },
          {
            guid: SAMPLER,
            kind: 'sampler',
            refs: [],
            artifacts: {},
            payload: { kind: 'sampler', magFilter: 'nearest', minFilter: 'nearest' },
          },
        ],
      },
    });
    packages.set(packageUrl, JSON.stringify(publication.pack));
    if (bytes !== undefined) packages.set(new URL('body.json', packageUrl).href, bytes);
    const previous = new Set(rows.map((row) => row.guid));
    rows = publication.pack.assets.map(({ guid, kind }) => ({
      guid,
      kind,
      packageUrl,
      sourcePath: 'graphics.pack',
      publication: publication.publication,
      lifecycle: 'current',
    }));
    for (const listener of listeners)
      listener({
        added: rows.filter((row) => !previous.has(row.guid)),
        changed: rows.filter((row) => previous.has(row.guid)),
        removed: [],
      });
  }
  return { assets, publish, fetcher };
}

function tileset() {
  return {
    kind: 'tileset',
    atlases: [ATLAS],
    tileWidth: 1,
    tileHeight: 1,
    columns: 2,
    rows: 1,
    regions: [{ x: 0, y: 0, width: 1, height: 1 }],
    tiles: [{ regionIndex: 0 }],
  };
}
function font() {
  return {
    kind: 'font',
    atlasGuid: ATLAS,
    samplerGuid: SAMPLER,
    common: { lineHeight: 1, base: 1, distanceRange: 1, pxRange: 1, atlasWidth: 2, atlasHeight: 1 },
    glyphs: {
      65: {
        advance: 1,
        bearingX: 0,
        bearingY: 0,
        size: { w: 1, h: 1 },
        region: { x: 0, y: 0, w: 1, h: 1 },
      },
    },
  };
}

it.each([
  false,
  true,
])('loads a Tileset source closure and fixes old content across a body update: artifact=%s', async (artifact) => {
  const f = fixture('tileset');
  f.publish(artifact ? { kind: 'tileset' } : tileset(), [ATLAS], artifact ? tileset() : undefined);
  const handle = (await f.assets.load(ROOT, 'tileset')).unwrap();
  const before = f.assets.read(handle).unwrap();
  expect(typeof before.atlases[0]).toBe('number');
  const old = f.assets.snapshot(handle).unwrap();
  const next = { ...tileset(), regions: [{ x: 1, y: 0, width: 1, height: 1 }] };
  f.publish(artifact ? { kind: 'tileset' } : next, [ATLAS], artifact ? next : undefined);
  (await f.assets.reload(handle, { conflict: 'reject' })).unwrap();
  expect(f.assets.read(handle).unwrap().regions[0]?.x).toBe(1);
  expect(old.read(handle).unwrap()).toEqual(before);
  old.dispose();
});

it.each([
  false,
  true,
])('rejects mismatched Tileset envelope references even when the atlas is already loaded: artifact=%s', async (artifact) => {
  const f = fixture('tileset');
  f.publish(tileset(), [ATLAS]);
  (await f.assets.load(ATLAS, 'texture')).unwrap();
  f.publish(artifact ? { kind: 'tileset' } : tileset(), [], artifact ? tileset() : undefined);
  expect((await f.assets.load(ROOT, 'tileset')).ok).toBe(false);
});

it.each([
  '{broken',
  { kind: 'font' },
  { ...tileset(), tileWidth: 0 },
  { ...tileset(), tiles: [{ regionIndex: 9 }] },
])('rejects malformed Tileset artifact without admitting an asset: %j', async (body) => {
  const f = fixture('tileset');
  f.publish({ kind: 'tileset' }, [ATLAS], body);
  expect((await f.assets.load(ROOT, 'tileset')).ok).toBe(false);
});

it('loads Font source GUIDs and rejects malformed metrics without replacing accepted content', async () => {
  const f = fixture('font');
  f.publish(font(), [ATLAS, SAMPLER]);
  const handle = (await f.assets.load(ROOT, 'font')).unwrap();
  const before = f.assets.read(handle).unwrap();
  expect(typeof before.atlas).toBe('number');
  expect(typeof before.sampler).toBe('number');
  const old = f.assets.snapshot(handle).unwrap();
  f.publish({ ...font(), glyphs: { 65: { advance: 2 } } }, [ATLAS, SAMPLER]);
  expect((await f.assets.reload(handle, { conflict: 'reject' })).ok).toBe(false);
  expect(f.assets.read(handle).unwrap()).toEqual(before);
  f.publish({ ...font(), common: { ...font().common, lineHeight: 2 } }, [ATLAS, SAMPLER]);
  (await f.assets.reload(handle, { conflict: 'reject' })).unwrap();
  expect(f.assets.read(handle).unwrap().common.lineHeight).toBe(2);
  expect(old.read(handle).unwrap()).toEqual(before);
  old.dispose();
});

it('requires Font atlas and sampler to belong to its declared source closure', async () => {
  const f = fixture('font');
  f.publish(font(), [ATLAS, SAMPLER]);
  (await f.assets.load(ATLAS, 'texture')).unwrap();
  (await f.assets.load(SAMPLER, 'sampler')).unwrap();
  f.publish(font(), []);
  expect((await f.assets.load(ROOT, 'font')).ok).toBe(false);
});

it('recovers a failed Video source load and preserves its accepted content across a failed reload', async () => {
  const f = fixture('video');
  f.publish({ kind: 'video', url: 'javascript:alert(1)' });
  expect((await f.assets.load(ROOT, 'video')).ok).toBe(false);
  f.publish({ kind: 'video', url: '/first.webm' });
  const handle = (await f.assets.load(ROOT, 'video')).unwrap();
  const old = f.assets.snapshot(handle).unwrap();
  f.publish({ kind: 'video', url: 'bad url' });
  expect((await f.assets.reload(handle, { conflict: 'reject' })).ok).toBe(false);
  expect(f.assets.read(handle).unwrap().url).toBe('/first.webm');
  f.publish({ kind: 'video', url: '/second.webm' });
  (await f.assets.reload(handle, { conflict: 'reject' })).unwrap();
  expect(f.assets.read(handle).unwrap().url).toBe('/second.webm');
  expect(old.read<VideoAsset>(handle).unwrap().url).toBe('/first.webm');
  old.dispose();
  expect(f.fetcher.mock.calls.every(([input]) => String(input).endsWith('/pack.json'))).toBe(true);
});

it('admits a local Video material binding, retains its version, and rejects foreign owner or sampler use', () => {
  const f = fixture('video');
  const foreign = fixture('video');
  const video = f.assets.create({ kind: 'video', url: '/first.webm' }).unwrap();
  const material: MaterialAsset = {
    kind: 'material' as const,
    passes: [{ name: 'main', program: { module: 'forgeax::default-unlit' } }],
    parameters: [{ name: 'albedo', type: 'texture' as const }],
    values: { albedo: { texture: video } },
  };
  const handle = f.assets.create(material).unwrap();
  const old = f.assets.snapshot(handle).unwrap();
  f.assets.update(video, { url: '/second.webm' }).unwrap();
  expect(f.assets.read(video).unwrap().url).toBe('/second.webm');
  expect(old.read<VideoAsset>(video).unwrap().url).toBe('/first.webm');
  old.dispose();
  expect(foreign.assets.create(material).ok).toBe(false);
  expect(
    f.assets.create({
      ...material,
      values: { albedo: { texture: video, sampler: video } },
    } as never).ok,
  ).toBe(false);
});
