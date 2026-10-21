import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import {
  Camera,
  createRenderPublisher,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  renderPublicationTransfers,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { page } from 'vitest/browser';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { constructRuntimeRendererHost } from '../renderer-host';

function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

async function pixels(canvas: HTMLCanvasElement): Promise<Uint8ClampedArray> {
  const shot = await page.elementLocator(canvas).screenshot({ base64: true });
  const bytes = Uint8Array.from(atob(typeof shot === 'string' ? shot : shot.base64), (x) =>
    x.charCodeAt(0),
  );
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const target = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = target.getContext('2d');
  if (ctx === null) throw new Error('Pixel decoder is unavailable');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, target.width, target.height).data;
}
it('renders the same Standard scene through local World and transferred publication, including changes', async () => {
  await page.viewport(800, 600);
  const identity = { source: 'browser-publication', epoch: 1 };
  const canvases = [document.createElement('canvas'), document.createElement('canvas')] as const;
  for (const canvas of canvases) {
    canvas.style.width = canvas.style.height = '128px';
    canvas.width = 128;
    canvas.height = 128;
    document.body.append(canvas);
  }
  const local = value(await constructRuntimeRendererHost(canvases[0]));
  const remote = value(
    await constructRuntimeRendererHost(canvases[1], { publicationSource: identity }),
  );
  const assets = local.assets;
  const world = new World({ assets });
  const cube = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  const publisher = createRenderPublisher(
    world,
    assets,
    identity,
    remote.renderer.inspect().capabilities,
  );
  const lease = value(local.renderer.attach(world));
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      {
        component: Camera,
        data: perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 2000 }),
      },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      {
        component: DirectionalLight,
        data: {
          castShadow: true,
          mapSize: testQuality.shadowMapSize,
          cascadeCount: testQuality.cascadeCount,
          shadowDistance: 35,
          intensity: 3,
          direction: [-0.5, -1, -0.3],
          color: [1, 1, 1],
        },
      },
    )
    .unwrap();
  const texture = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
      format: 'rgba8unorm',
      data: new Uint8Array([
        255, 80, 40, 255, 40, 255, 80, 255, 40, 80, 255, 255, 255, 255, 255, 255,
      ]),
      colorSpace: 'linear',
      mips: { kind: 'none' },
    } satisfies import('@forgeax/engine-types').TextureAsset)
    .unwrap();
  const material = assets
    .create(Materials.standard({ baseColor: [1, 1, 1, 1], baseColorTexture: texture }))
    .unwrap();
  const mesh = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: cube } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, -1, 0], scale: [4, 0.1, 4] } },
      { component: MeshFilter, data: { assetHandle: cube } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  assets.configurePackIndex('/__material-programs/pack-index.json');
  const cookedHandle = (
    await assets.load(assets.parseGuid('8f50ae65-6e0a-40b4-8949-b47006edab90'), 'material')
  ).unwrap();
  const images: Uint8ClampedArray[] = [];
  try {
    for (const x of [0, 1, -1, 2]) {
      if (x === 2) world.set(mesh, MeshRenderer, { materials: [cookedHandle] }).unwrap();
      world.set(mesh, Transform, { pos: [x, 0, 0] }).unwrap();
      assets
        .update(material, { values: { baseColor: x === 1 ? [0.2, 1, 0.2, 1] : [1, 1, 1, 1] } })
        .unwrap();
      world.update(1 / 60).unwrap();
      const shadowClaims: import('@forgeax/engine-render').GpuDrivenLaneSummary[] = [];
      if (!local.renderer.requestObservation || !remote.renderer.requestObservation)
        throw new Error('Receipt observation is unavailable');
      // Arming a color observation can change the graph and asynchronously
      // prepare its output pipeline. Queue completion alone is not readiness.
      let observationsReady = false;
      for (let frame = 0; frame < 60; frame++) {
        value(local.renderer.requestObservation(['linear-ldr']));
        value(remote.renderer.requestObservation(['linear-ldr']));
        const direct = value(
          local.renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
        );
        expect((await direct.completed).ok).toBe(true);
        const candidate = publisher.prepare((frame + 1) / 60).unwrap();
        const packet = structuredClone(candidate.packet, {
          transfer: renderPublicationTransfers(candidate.packet),
        });
        candidate.accept();
        if (x === 2 && frame === 0) expect(packet.programs.length).toBeGreaterThan(0);
        const draw = value(remote.renderer.draw({ publication: packet }));
        expect((await draw.completed).ok).toBe(true);
        shadowClaims.push(
          ...remote.renderer
            .inspect()
            .renderScene.gpuDriven.channels.filter(
              (channel) => channel.viewPass === 'directional-shadow',
            ),
        );
        publisher
          .recycle(
            packet.revision,
            structuredClone(renderPublicationTransfers(packet), {
              transfer: renderPublicationTransfers(packet),
            }),
          )
          .unwrap();
        if (direct.presentation === 'ready')
          value(await local.renderer.observe(direct, { include: ['linear-ldr'] }));
        if (draw.presentation === 'ready')
          value(await remote.renderer.observe(draw, { include: ['linear-ldr'] }));
        observationsReady = direct.presentation === 'ready' && draw.presentation === 'ready';
        if (frame >= 2 && observationsReady) break;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      expect(observationsReady, `observation pipeline readiness for scene ${x}`).toBe(true);
      // Static depth submissions have no dynamic lane channel. A real pose
      // change must promote the caster and publish its GPU shadow ownership.
      if (x === 1 || x === -1) {
        expect(shadowClaims.length).toBeGreaterThan(0);
        expect(
          shadowClaims.every(
            (channel) =>
              channel.lane === 'gpu' &&
              channel.claimedDrawCount > 0 &&
              channel.residualDrawCount === 0,
          ),
        ).toBe(true);
      }
      // Submit different states without awaiting either GPU. Receipt-owned
      // copies must preserve each image while the next draw rewrites uniforms,
      // scene tables, graph resources, and (once) the canvas extent.
      const flights = [0, 0.4].map((offset) => {
        if (x === 1 && offset > 0) {
          for (const canvas of canvases) canvas.width = canvas.height = 96;
        }
        world.set(mesh, Transform, { pos: [x + offset, 0, 0] }).unwrap();
        // The cooked fixture places vertices directly in clip space. Change its
        // actual scalar input so both material paths have a visible falsifier.
        if (x === 2)
          assets.update(cookedHandle, { values: { strength: offset === 0 ? 1 : 0.25 } }).unwrap();
        world.update(1 / 60).unwrap();
        if (
          local.renderer.requestObservation === undefined ||
          remote.renderer.requestObservation === undefined
        )
          throw new Error('Receipt observation is unavailable');
        value(local.renderer.requestObservation(['linear-ldr']));
        value(remote.renderer.requestObservation(['linear-ldr']));
        const direct = value(
          local.renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
        );
        const candidate = publisher.prepare((4 + offset) / 60).unwrap();
        const packet = structuredClone(candidate.packet, {
          transfer: renderPublicationTransfers(candidate.packet),
        });
        candidate.accept();
        const draw = value(remote.renderer.draw({ publication: packet }));
        expect(direct.presentation, `local receipt for scene ${x} offset ${offset}`).toBe('ready');
        expect(draw.presentation, `published receipt for scene ${x} offset ${offset}`).toBe(
          'ready',
        );
        return {
          direct,
          draw,
          packet,
          width: canvases[1].width,
          observations: Promise.all([
            local.renderer.observe(direct, { include: ['linear-ldr'] }),
            remote.renderer.observe(draw, { include: ['linear-ldr'] }),
          ]),
        };
      });
      const captured: Uint8Array[] = [];
      for (const flight of flights) {
        expect((await flight.direct.completed).ok).toBe(true);
        expect((await flight.draw.completed).ok).toBe(true);
        const [direct, published] = await flight.observations;
        const a = value(direct).observations?.find((row) => row.domain === 'linear-ldr');
        const b = value(published).observations?.find((row) => row.domain === 'linear-ldr');
        if (a === undefined || b === undefined) throw new Error('Missing receipt-bound pixels');
        expect(a.metadata.frameId).toBe(flight.direct.frameId);
        expect(b.metadata.frameId).toBe(flight.draw.frameId);
        expect(b.metadata.width).toBe(flight.width);
        expect(a.metadata.format).toBe(b.metadata.format);
        expect(a.bytes.length).toBe(b.bytes.length);
        expect(a.bytes).toEqual(b.bytes);
        captured.push(b.bytes);
        const buffers = renderPublicationTransfers(flight.packet);
        publisher
          .recycle(flight.packet.revision, structuredClone(buffers, { transfer: buffers }))
          .unwrap();
      }
      expect(captured[0], `distinct receipt pixels for scene ${x}`).not.toEqual(captured[1]);
      const a = await pixels(canvases[0]),
        b = await pixels(canvases[1]);
      expect(a.length).toBe(b.length);
      let error = 0;
      for (let i = 0; i < a.length; i++) error += Math.abs(Number(a[i]) - Number(b[i]));
      expect(error / a.length / 255).toBeLessThan(0.01);
      images.push(b);
    }
    let changed = 0;
    const [first, second] = images;
    if (first === undefined || second === undefined) throw new Error('Missing comparison frames');
    for (let i = 0; i < first.length; i++) if (first[i] !== second[i]) changed++;
    expect(changed).toBeGreaterThan(100);
  } finally {
    publisher.dispose();
    await local.renderer.dispose();
    await remote.renderer.dispose();
    for (const canvas of canvases) canvas.remove();
  }
}, 90_000);
