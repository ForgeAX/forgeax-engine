import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { EngineWorkspaceRuntime } from '@forgeax/engine-app';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { createServer, type ViteDevServer } from 'vite';
import { expect, it } from 'vitest';
import { createViteConfig } from '../src/host.js';
import { readProjectFacts } from '../src/project.js';
import { createWorkspaceThumbnails, readPreviewInputs } from '../src/workspace-thumbnails.js';
import { createWorkspacePreviewBatch } from '../src/workspace-preview-batch.js';

it('captures transparent previews progressively and reopens from DDC without a GPU carrier', async () => {
  const started = performance.now();
  const extra = Number(process.env.FORGEAX_THUMBNAIL_EXTRA ?? 0);
  const expectCache = process.env.FORGEAX_THUMBNAIL_EXPECT_CACHE === '1';
  const stages: Record<string, number> = {};
  const repository = resolve(import.meta.dirname, '../../..');
  const root = process.env.FORGEAX_THUMBNAIL_PROJECT ?? await mkdtemp(resolve(tmpdir(), 'forgeax-thumbnail-browser-'));
  await mkdir(root, { recursive: true });
  const evidence = process.env.FORGEAX_THUMBNAIL_EVIDENCE ?? resolve(repository, 'artifacts/preview-thumbnails');
  let server: ViteDevServer | undefined;
  let owner: ReturnType<typeof createWorkspaceThumbnails> | undefined;
  const oldBackend = process.env.FORGEAX_THUMBNAIL_BACKEND;
  if (process.platform === 'linux') process.env.FORGEAX_THUMBNAIL_BACKEND = 'software';
  try {
    await mkdir(evidence, { recursive: true });
    await mkdir(resolve(root, 'assets'), { recursive: true });
    await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
    await symlink(resolve(repository, 'packages/engine'), resolve(root, 'node_modules/@forgeax/engine'), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error; });
    await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'thumbnail-browser', type: 'module', dependencies: { '@forgeax/engine': '*' } }));
    await writeFile(resolve(root, 'forge.json'), JSON.stringify({ schemaVersion: '3.0.0', id: 'thumbnail-browser', name: 'Thumbnail Browser', assetRoots: ['assets'], roots: {} }));
    await writeFile(resolve(root, 'assets/subjects.pack.ts'), `
      import { definePack, definePackageId, AssetGuid } from '@forgeax/engine/pack/source';
      import { ok } from '@forgeax/engine/types';
      import { createPrimitiveMesh } from '@forgeax/engine/geometry';
      import { Materials, Camera, DirectionalLight, Skylight, MeshFilter, MeshRenderer } from '@forgeax/engine/render';
      import { Transform } from '@forgeax/engine/scene';
      export default definePack({ schemaVersion: '2.0.0', packageId: definePackageId('019fb7ce-3200-7000-8000-000000001abc'), name: 'Thumbnail subjects', sceneComponents: [Transform, Camera, DirectionalLight, Skylight, MeshFilter, MeshRenderer], build: ({ packageId }) => ok({
        sphere: createPrimitiveMesh('sphere').unwrap(),
        quad: createPrimitiveMesh('quad').unwrap(),
        red: Materials.standard({ baseColor: [0.8,0.03,0.02,1], roughness: 0.45 }),
        blue: Materials.standard({ baseColor: [0.02,0.12,0.8,1], roughness: 0.2 }),
        metal: Materials.standard({ baseColor: [0.9,0.8,0.6,1], metallic: 0.8, roughness: 0.3 }),
        scene: { kind: 'scene', entities: {
          subject: { components: { Transform: {}, MeshFilter: { assetHandle: AssetGuid.format(AssetGuid.derive(packageId, 'sphere')) }, MeshRenderer: { materials: [AssetGuid.format(AssetGuid.derive(packageId, 'red'))] } } },
          camera: { components: { Transform: { pos: [0,0,5] }, Camera: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 20, clearColor: [0.2,0.3,0.4,1] } } },
          light: { components: { DirectionalLight: { direction: [-0.5,-1,-0.3], intensity: 2 }, Skylight: { color: [1,1,1], intensity: 1 } } },
        } },
        alpha: { kind: 'texture', shape: { viewDimension: '2d', extent: { width: 32, height: 16 } }, format: 'rgba8unorm-srgb', colorSpace: 'srgb', mips: { kind: 'none' }, data: new Uint8Array(32*16*4).map((_, index) => {
          const x = Math.floor(index / 4) % 32, y = Math.floor(index / 128);
          return index % 4 === 3 ? (x < 11 ? 255 : x < 21 ? 128 : 0) :
            ((Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? [30,210,230] : [240,80,40])[index % 4];
        }) },
        environment: { kind: 'equirect', width: 32, height: 16, format: 'rgba8unorm-srgb', colorSpace: 'srgb', data: new Uint8Array(32*16*4).map((_, index) => {
          const quadrant = Number(Math.floor(index / 4) % 32 >= 16) + 2 * Number(Math.floor(index / 128) >= 8);
          return index % 4 === 3 ? 255 : [[220,30,40],[20,200,60],[30,60,220],[230,200,40]][quadrant][index % 4];
        }) },
        ...Object.fromEntries(['2d-array', '3d'].map(viewDimension => [viewDimension, {
          kind: 'texture', shape: { viewDimension, extent: { width: 16, height: 16, [viewDimension === '3d' ? 'depth' : 'layers']: 2 } },
          format: 'rgba8unorm-srgb', colorSpace: 'srgb', mips: { kind: 'none' }, data: new Uint8Array(16*16*2*4).map((_, index) => {
            const pixel = Math.floor(index / 4), x = pixel % 16, y = Math.floor(pixel / 16) % 16;
            return index % 4 === 3 ? 255 : pixel >= 256 ? [30,60,220][index % 4] :
              ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? [20,200,60] : [220,30,40])[index % 4];
          }),
        }])),
        ...Object.fromEntries(Array.from({ length: ${extra} }, (_, index) => ['swatch' + index, Materials.standard({ baseColor: [(index % 6) / 6 + 0.1, (Math.floor(index / 6) % 6) / 6 + 0.1, 0.35, 1], metallic: (index % 3) / 2, roughness: (index % 5) / 5 + 0.1 })])),
      }) });
    `);
    await writeFile(resolve(root, 'assets/particles.pack.json'), JSON.stringify({
      schemaVersion: '3.0.0', packageId: '019fb7ce-3200-7000-8000-000000001abd',
      assets: { particles: { kind: 'particle-effect', refs: [], artifacts: {}, payload: {
        schemaVersion: 3,
        emitters: [{ id: 'particles', capacity: 64, backend: { required: 'gpu' }, space: 'world',
          schedule: { rate: 60, bursts: [{ time: 0.02, count: 8 }] },
          bounds: { kind: 'sphere', center: [0,0,0], radius: 1 },
          program: { module: 'forgeax_vfx::default' },
          renderers: [{ kind: 'billboard', material: AssetGuid.format(AssetGuid.derive(definePackageId('019fb7ce-3200-7000-8000-000000001abc'), 'red')), blend: 'alpha' }],
        }],
      } } },
    }));
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    const config = await createViteConfig(facts.value, 'serve', '/', { server: { port: 0 }, bootstrapRoot: 'resource-bootstrap' }).catch(cause => { throw new Error(JSON.stringify(cause)); });
    stages.configMs = performance.now() - started;
    server = await createServer(config);
    const reloads: unknown[] = [];
    const send = server.ws.send.bind(server.ws);
    server.ws.send = ((...args: Parameters<typeof send>) => {
      const message: unknown = args[0];
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'full-reload') reloads.push(message);
      return send(...args);
    }) as typeof server.ws.send;
    await server.listen();
    const pack = server.config.plugins.find(plugin => plugin.name === 'forgeax:pack') as unknown as { ready(): Promise<void> };
    await pack.ready();
    stages.projectReadyMs = performance.now() - started;
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Preview server address missing');
    const url = `http://localhost:${address.port}`;
    const inputs = await readPreviewInputs(url, new AbortController().signal);
    stages.inputsReadyMs = performance.now() - started;
    const assets = inputs.entries.filter(row => /subjects\.pack\.ts|particles\.pack\.json/.test(row.sourcePath));
    expect(assets).toHaveLength(11 + extra);
    const runtime = { project: { project: { id: facts.value.id, root }, target: { url } } } as Pick<EngineWorkspaceRuntime, 'project'>;
    let launches = 0;
    const changes: { ms: number; ready: number }[] = [];
    const start = performance.now();
    const dependencies = { readInputs: readPreviewInputs, createBatch: (target: string) => { launches++; return createWorkspacePreviewBatch(target); } };
    owner = createWorkspaceThumbnails(runtime, () => {}, dependencies);
    owner.refresh();
    let completed = false;
    while (performance.now() - start < 120_000) {
      const response = await owner.read(assets.map(row => row.guid));
      const failed = response.thumbnails.filter(row => row.state === 'failed');
      if (failed.length) throw new Error(JSON.stringify(failed));
      const ready = response.thumbnails.filter(row => row.state === 'ready').length;
      if (changes.at(-1)?.ready !== ready) changes.push({ ms: performance.now() - start, ready });
      if (ready === assets.length) { completed = true; break; }
      await new Promise(done => setTimeout(done, 25));
    }
    expect(completed, JSON.stringify((await owner.read(assets.map(row => row.guid))).thumbnails.map(({ dataUrl: _image, ...row }) => row))).toBe(true);
    const coldMs = performance.now() - start;
    // Cold module discovery must finish without navigating an active capture.
    expect(reloads).toEqual([]);
    expect(launches).toBe(expectCache ? 0 : 1);
    const cold = await owner.read(assets.map(row => row.guid));
    await writeFile(resolve(evidence, 'cold-measurements.json'), JSON.stringify({ stages, coldMs, changes, assets: cold.thumbnails.map(({ dataUrl: _dataUrl, ...row }) => row) }, null, 2));
    for (const row of cold.thumbnails) {
      const asset = assets.find(asset => asset.guid === row.guid);
      const name = asset?.sourceKey ?? row.guid;
      if (!row.dataUrl) throw new Error('Ready thumbnail has no image');
      await writeFile(resolve(evidence, `${name}.png`), Buffer.from(row.dataUrl.split(',')[1] ?? '', 'base64'));
    }
    // Decode the real renderer PNGs, including alpha, through the installed image owner.
    const { PNG } = await import('pngjs');
    const red = PNG.sync.read(await readFile(resolve(evidence, 'red.png')));
    expect(red.width).toBe(128); expect(red.height).toBe(128);
    let transparent = 0, opaque = 0, redPixels = 0;
    for (let i = 0; i < red.data.length; i += 4) {
      if (red.data[i + 3] === 0) transparent++;
      if (red.data[i + 3] === 255) opaque++;
      if ((red.data[i] ?? 0) > (red.data[i + 2] ?? 0) + 30) redPixels++;
    }
    expect(transparent).toBeGreaterThan(1000); expect(opaque).toBeGreaterThan(1000); expect(redPixels).toBeGreaterThan(1000);
    const alpha = PNG.sync.read(await readFile(resolve(evidence, 'alpha.png')));
    const at = (image: typeof alpha, x: number, y: number) => Array.from(image.data.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 4));
    const near = (actual: number[], expected: number[]) => expected.forEach((value, index) => expect(Math.abs(actual[index]! - value)).toBeLessThanOrEqual(2));
    expect(alpha.data[(64 * 128 + 42) * 4 + 3]).toBe(255);
    expect(alpha.data[(64 * 128 + 86) * 4 + 3]).toBe(0);
    // Sample the cell interior: its boundary intentionally blends both checker colors.
    near(at(alpha, 68, 70), [30,210,230,128]);
    expect(at(alpha, 64, 20)[3]).toBe(0);
    const environment = PNG.sync.read(await readFile(resolve(evidence, 'environment.png')));
    near(at(environment, 32, 46), [220,30,40,255]);
    near(at(environment, 96, 46), [20,200,60,255]);
    near(at(environment, 32, 82), [30,60,220,255]);
    near(at(environment, 96, 82), [230,200,40,255]);
    expect(at(environment, 64, 20)[3]).toBe(0);
    for (const dimension of ['2d-array', '3d']) {
      const slice = PNG.sync.read(await readFile(resolve(evidence, `${dimension}.png`)));
      near(at(slice, 78, 78), [220,30,40,255]);
      expect(at(slice, 0, 0)[3]).toBe(0);
    }
    const scene = PNG.sync.read(await readFile(resolve(evidence, 'scene.png')));
    expect(scene.data[3]).toBe(0);
    expect(scene.data[(64 * 128 + 64) * 4 + 3]).toBe(255);
    expect(scene.data[(64 * 128 + 64) * 4]).toBeGreaterThan(scene.data[(64 * 128 + 64) * 4 + 2] + 30);
    const effect = assets.find(asset => asset.kind === 'particle-effect');
    expect(effect).toBeDefined();
    const effectMetrics = cold.thumbnails.find(row => row.guid === effect?.guid)?.metrics;
    if (expectCache) expect(effectMetrics?.cache).toBe('hit');
    else expect(effectMetrics?.capture?.ready).toBe(30);
    const particles = PNG.sync.read(await readFile(resolve(evidence, 'particles.png')));
    expect(particles.data.filter((value, index) => index % 4 === 3 && value > 0).length).toBeGreaterThan(8);
    await owner.close();
    launches = 0;
    owner = createWorkspaceThumbnails(runtime, () => {}, dependencies);
    const reopen = performance.now(); owner.refresh();
    await expect.poll(async () => (await owner?.read(assets.map(row => row.guid)))?.thumbnails.every(row => row.state === 'ready'), { timeout: 5000 }).toBe(true);
    const hotMs = performance.now() - reopen;
    expect(launches).toBe(0);
    await writeFile(resolve(evidence, 'measurements.json'), JSON.stringify({ backend: process.platform === 'linux' ? 'SwiftShader' : 'hardware', size: 128, stages, coldMs, hotMs, changes, assets: cold.thumbnails.map(({ dataUrl: _dataUrl, ...row }) => row), pixels: { transparent, opaque, redPixels } }, null, 2));
  } finally {
    if (oldBackend === undefined) delete process.env.FORGEAX_THUMBNAIL_BACKEND; else process.env.FORGEAX_THUMBNAIL_BACKEND = oldBackend;
    await owner?.close(); await server?.close();
    if (!process.env.FORGEAX_THUMBNAIL_PROJECT) await rm(root, { recursive: true, force: true });
  }
}, 180_000);
