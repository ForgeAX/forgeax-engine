import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { AssetGuid, decodeCatalogWire, decodeMaterialProgramWire } from '@forgeax/engine-pack';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import { Transform } from '@forgeax/engine-scene';
import type {
  AssetHandle,
  MaterialAsset,
  PackIndexEntry,
  RuntimeAssetBinding,
} from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { ParticleEffectPlayer } from '@forgeax/engine-vfx';
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';
import { expect } from 'vitest';
import { loadBackendPack } from '../backend-selection';
import { createDevImportTransport } from '../dev-import-transport';
import { constructRuntimeRendererHost } from '../renderer-host';

const inspect = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item instanceof Error ? { ...item, message: item.message } : item,
  );

export async function verifyMaterialPublication(options: {
  readonly binding: RuntimeAssetBinding;
  readonly guids: readonly string[];
  readonly shaderManifestUrl: string;
  readonly update: (value: 'red' | 'blue' | 'broken') => Promise<void>;
  readonly saveTape?: (bytes: Uint8Array) => void;
}) {
  const errors: unknown[] = [];
  let device: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  let surfaceFormat: GPUTextureFormat = 'rgba8unorm';
  const canvas = {
    width: 64,
    height: 64,
    getContext: () => ({
      configure(config: GPUCanvasConfiguration) {
        device = config.device;
        surfaceFormat = config.format;
        device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        target = device.createTexture({
          size: [64, 64],
          format: config.format,
          viewFormats: [config.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
          usage: 0x10 | 0x01,
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
    addEventListener() {},
    removeEventListener() {},
  };
  const transport = createDevImportTransport(options.binding);
  const backend = await loadBackendPack({});
  if (!backend.ok) throw backend.error;
  if (backend.value.createShaderModule === undefined)
    throw new Error('missing backend shader factory');
  const recording = attachRecorder({
    ...backend.value,
    createShaderModule: backend.value.createShaderModule,
  });
  if (!recording.ok) throw recording.error;
  const recorder = recording.value;
  const vfx = createVfxRuntimeHost({
    camera: {
      read: () => ({
        position: new Float32Array([0, 0, 3]),
        right: new Float32Array([1, 0, 0]),
        up: new Float32Array([0, 1, 0]),
        viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      }),
    },
  });
  const constructed = await constructRuntimeRendererHost(
    canvas,
    {
      features: [vfx.feature],
      rhi: recorder.backend.rhi,
      rhiInstrumentation: {
        resolveSurfaceDevice(device) {
          const unwrapped = recorder.backend.unwrapDeviceForSurface(device);
          if (!unwrapped.ok) throw unwrapped.error;
          return ok(unwrapped.value);
        },
      },
    },
    {
      shaderManifestUrl: options.shaderManifestUrl,
      importTransport: transport,
    },
  );
  if (!constructed.ok) throw constructed.error;
  const { renderer, assets } = constructed.value;
  renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  assets.configureRuntimeBinding(options.binding);
  const world = new World({ assets });
  const materialContent = (handle: AssetHandle<'material'>) =>
    runtimeAssets(assets).borrow<MaterialAsset>(handle).unwrap();
  try {
    const catalog = async () => {
      const response = await fetch(options.binding.catalogUrl);
      const body = (await response.json()) as {
        authority: string;
        entries: unknown;
        diagnostics?: unknown[];
      };
      // This probe also inspects degraded snapshots during producer recovery.
      return { ...body, entries: decodeCatalogWire(body.entries).unwrap() };
    };
    const baseline = await catalog();
    expect(baseline.authority, inspect(baseline)).toBe('authoritative');
    expect(baseline.entries).toHaveLength(9);
    const firstGuid = options.guids[0];
    const childGuid = options.guids[1];
    const otherGuid = options.guids[2];
    if (firstGuid === undefined || childGuid === undefined || otherGuid === undefined)
      throw new Error('missing fixture identity');
    const firstRow = baseline.entries.find((row) => row.guid === firstGuid);
    const otherRow = baseline.entries.find((row) => row.guid === otherGuid);
    if (firstRow === undefined || otherRow === undefined)
      throw new Error('missing material Catalog row');
    const publicationFor = (row: PackIndexEntry) => {
      const publication = row.publication;
      if (publication === undefined) throw new Error(`missing publication for ${row.guid}`);
      const current = publication.current;
      if (current === undefined) throw new Error(`missing current publication for ${row.guid}`);
      expect(current.generation).toBe(publication.generation);
      // Runtime Catalog rows add the active scope prefix; the publication
      // locator retains the producer-owned DDC path.
      expect(row.packageUrl.endsWith(current.packageUrl)).toBe(true);
      expect(publication.receipt.sourcePath).toBe(publication.sourcePath);
      expect(publication.receipt.sourceRevision).toBe(publication.sourceRevision);
      expect(publication.receipt.outputDigest).toBe(publication.digest);
      expect(publication.receipt.outputSetDigest).toBe(publication.outputSetDigest);
      return publication;
    };
    const cookedGenerationsFor = async (row: PackIndexEntry) => {
      const response = await fetch(new URL(row.packageUrl, options.binding.catalogUrl));
      expect(response.status).toBe(200);
      const body = decodeMaterialProgramWire(await response.json()).unwrap() as {
        readonly assets?: readonly {
          readonly guid: string;
          readonly payload?: {
            readonly cooked?: {
              readonly publicationGeneration?: unknown;
              readonly receipt?: {
                readonly identity?: { readonly cookGeneration?: unknown };
              };
            };
          };
        }[];
      };
      const asset = body.assets?.find((candidate) => candidate.guid === row.guid);
      const cooked = asset?.payload?.cooked;
      const publicationGeneration = cooked?.publicationGeneration;
      const cookGeneration = cooked?.receipt?.identity?.cookGeneration;
      if (
        typeof publicationGeneration !== 'number' ||
        !Number.isSafeInteger(publicationGeneration) ||
        publicationGeneration < 1 ||
        typeof cookGeneration !== 'number' ||
        !Number.isSafeInteger(cookGeneration) ||
        cookGeneration < 1
      ) {
        throw new Error(`missing cooked publication generations for ${row.guid}`);
      }
      return { publicationGeneration, cookGeneration };
    };
    const baselinePublication = publicationFor(firstRow);
    const baselineOtherPublication = publicationFor(otherRow);
    const transportResult = await transport.fetchPack(firstGuid, options.binding);
    expect(transportResult.ok, inspect(transportResult)).toBe(true);
    const packUrl = new URL(firstRow.packageUrl, options.binding.catalogUrl).href;
    const pack = decodeMaterialProgramWire(await (await fetch(packUrl)).json()).unwrap() as {
      assets: { guid: string; artifacts: Record<string, unknown>; payload: unknown }[];
    };
    const row = pack.assets.find((asset) => asset.guid === firstGuid);
    if (row === undefined) throw new Error('missing fetched material Pack row');
    const descriptors = Object.values(row.artifacts) as { path: string; byteLength: number }[];
    expect(pack).toMatchObject({
      scopeId: options.binding.scopeId,
      generation: baselinePublication.generation,
      digest: baselinePublication.digest,
      outputSetDigest: baselinePublication.outputSetDigest,
    });
    const wire = (
      row.payload as {
        cooked: {
          programs: readonly {
            specializationKey: string;
            selections: readonly {
              pass: string;
              context: { backend: string; capability: string };
            }[];
            artifact: { path: string; digest: string; bytes?: unknown };
          }[];
        };
      }
    ).cooked;
    for (const program of wire.programs) {
      expect(program.artifact).not.toHaveProperty('bytes');
      expect(row.artifacts[program.artifact.path]).toMatchObject({
        integrity: { digest: program.artifact.digest },
      });
    }
    const load = async (guid: string) => {
      const parsed = AssetGuid.parse(guid);
      if (!parsed.ok) throw parsed.error;
      const loaded = await assets.load(parsed.value, 'material');
      if (!loaded.ok) throw loaded.error;
      return loaded.value;
    };
    const first = await load(firstGuid);
    const firstContent = materialContent(first);
    // Cook records stay with the publication and shader owners, not mutable content.
    expect(firstContent).not.toHaveProperty('cooked');
    const cooked = wire;
    // Every native and downlevel View layout selects three independent passes;
    // identical WGSL bytes retain one content-addressed transport artifact.
    const contexts = [
      ['webgpu', 'storage-buffer'],
      ['webgpu', 'storage-buffer-atmosphere'],
      ['webgpu', 'storage-buffer-minimum'],
      ['webgpu', 'storage-buffer-projector'],
      ['webgpu', 'uniform-fallback'],
      ['webgl2', 'uniform-fallback'],
    ] as const;
    expect(cooked.programs).toHaveLength(contexts.length * 3);
    for (const [backend, capability] of contexts) {
      const programs = cooked.programs.filter((program) =>
        program.selections.some(
          (selection) =>
            selection.context.backend === backend && selection.context.capability === capability,
        ),
      );
      expect(programs).toHaveLength(3);
      expect(
        new Set(
          programs.flatMap((program) => program.selections.map((selection) => selection.pass)),
        ),
      ).toEqual(new Set(['Forward', 'Overlay', 'ShadowCaster']));
    }
    expect(descriptors).toHaveLength(6);
    expect(new Set(cooked.programs.map((program) => program.artifact.path)).size).toBe(
      descriptors.length,
    );
    const publishedSources = new Map<string, string>();
    for (const descriptor of descriptors) {
      const programs = cooked.programs.filter(
        (candidate) =>
          descriptor.path === candidate.artifact.path ||
          descriptor.path.endsWith(`/${candidate.artifact.path}`),
      );
      if (programs.length === 0) throw new Error(`missing program for ${descriptor.path}`);
      const response = await fetch(new URL(descriptor.path, packUrl));
      expect(response.status).toBe(200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.byteLength).toBe(descriptor.byteLength);
      for (const program of programs)
        publishedSources.set(program.specializationKey, new TextDecoder().decode(bytes));
    }
    const inherited = await load(childGuid);
    const other = await load(otherGuid);
    const firstProjection = assets.getMaterialProjectionForPayload(materialContent(first));
    if (firstProjection === undefined) throw new Error('missing first material projection');
    const shadow = assets.shaderRegistry.findMaterialArtifact('forgeax::default-shadow-caster');
    if (!shadow.ok) throw shadow.error;
    for (const program of cooked.programs)
      expect(assets.shaderRegistry.findMaterialArtifact(program.specializationKey)).toMatchObject({
        ok: true,
        value: { source: publishedSources.get(program.specializationKey) },
      });
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    const entity = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        {
          component: MeshFilter,
          data: {
            assetHandle: assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap(),
          },
        },
        {
          component: MeshRenderer,
          data: { materials: [first] },
        },
      )
      .unwrap();
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const lease = attached.value;
    const sample = async (material?: AssetHandle<'material'>) => {
      if (material !== undefined)
        world
          .set(entity, MeshRenderer, {
            materials: [material],
          })
          .unwrap();
      for (let frame = 0; frame < 15; frame++) {
        const capture = frame === 14 ? recorder.captureFrame() : undefined;
        if (capture !== undefined) {
          const before = await recorder.frameBoundary();
          if (!before.ok) throw before.error;
        }
        world.update(1 / 60).unwrap();
        const result = renderer.draw({
          leases: [lease],
          camera: { lease },
          environment: { lease },
        });
        if (!result.ok) throw result.error;
        if (capture !== undefined) {
          const after = await recorder.frameBoundary();
          if (!after.ok) throw after.error;
          const captured = await capture;
          if (!captured.ok) throw captured.error;
          options.saveTape?.(captured.value.bytes);
          const decoded = decodeTape(captured.value.bytes);
          if (!decoded.ok) throw decoded.error;
          expect(
            buildFrameModel(decoded.value).works.some(
              (work) => work.kind === 'draw' || work.kind === 'drawIndexed',
            ),
          ).toBe(true);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (device === undefined || target === undefined) throw new Error('missing real GPU target');
      const buffer = device.createBuffer({ size: 256, usage: 0x08 | 0x01 });
      try {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
          { texture: target, origin: [32, 32] },
          { buffer, bytesPerRow: 256 },
          [1, 1],
        );
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(0x01);
        const pixel = [...new Uint8Array(buffer.getMappedRange()).slice(0, 4)];
        buffer.unmap();
        if (surfaceFormat === 'bgra8unorm') [pixel[0], pixel[2]] = [pixel[2] ?? 0, pixel[0] ?? 0];
        expect(errors, inspect(errors)).toEqual([]);
        return pixel;
      } finally {
        buffer.destroy();
      }
    };
    const originalFactor = assets.read(first).unwrap().values?.factor ?? 1;
    const red = await sample(first);
    expect(red[0]).toBeGreaterThan(150);
    expect(red[2]).toBeLessThan(5);
    assets.update(first, { values: { factor: 0.25 } }).unwrap();
    const dimmed = await sample(first);
    expect(dimmed[0]).toBeGreaterThan(20);
    expect(dimmed[0]).toBeLessThan((red[0] ?? 0) * 0.8);
    expect(dimmed[2]).toBeLessThan(5);
    assets.update(first, { values: { factor: originalFactor } }).unwrap();
    expect(await sample(first)).toEqual(red);
    expect(await sample(inherited)).toEqual(red);
    const overlay = firstContent.passes?.find((pass) => pass.name === 'Overlay');
    if (overlay === undefined) throw new Error('missing independent Overlay pass');
    const projection = assets.getMaterialProjectionForPayload(materialContent(first));
    const overlayProgram = projection?.passes.find((pass) => pass.name === overlay.name)
      ?.programs[0];
    if (overlayProgram === undefined) throw new Error('missing published Overlay program');
    if (firstContent.parent !== undefined)
      throw new Error('expected the published first material to be a root material');
    const overlayMaterial: MaterialAsset = {
      ...firstContent,
      passes: [
        {
          ...overlay,
          program: { ...overlay.program, module: overlayProgram.specializationKey },
          renderState: { ...overlay.renderState, tags: { LightMode: 'Forward' } },
        },
      ],
    };
    const overlayHandle = assets.create(overlayMaterial).unwrap();
    const green = await sample(overlayHandle);
    expect(green[0]).toBeLessThan(5);
    expect(green[1]).toBeGreaterThan(150);
    expect(green[2]).toBeLessThan(5);
    const waitFor = async (accept: (value: Awaited<ReturnType<typeof catalog>>) => boolean) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const next = await catalog();
        if (accept(next)) return next;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      const last = await catalog();
      throw new Error(
        `material publication did not settle: ${inspect({
          authority: last.authority,
          entries: last.entries.map((row) => ({
            guid: row.guid,
            revision: row.revision,
            lifecycle: row.lifecycle,
          })),
          diagnostics: last.diagnostics,
        })}`,
      );
    };
    await options.update('blue');
    const changed = await waitFor(
      (next) =>
        next.authority === 'authoritative' &&
        next.entries.some(
          (row) => row.guid === firstGuid && row.packageUrl !== firstRow.packageUrl,
        ),
    );
    const changedFirstRow = changed.entries.find((row) => row.guid === firstGuid);
    const changedOtherRow = changed.entries.find((row) => row.guid === otherGuid);
    if (changedFirstRow === undefined || changedOtherRow === undefined)
      throw new Error('missing changed material Catalog row');
    const changedPublication = publicationFor(changedFirstRow);
    const changedOtherPublication = publicationFor(changedOtherRow);
    expect(changedPublication.generation).toBeGreaterThan(baselinePublication.generation);
    expect(changedOtherRow.packageUrl).toBe(otherRow.packageUrl);
    expect(changedOtherPublication.generation).toBe(baselineOtherPublication.generation);
    expect(changedOtherPublication.digest).toBe(baselineOtherPublication.digest);
    expect(changedOtherPublication.outputSetDigest).toBe(baselineOtherPublication.outputSetDigest);
    const changedCookedGenerations = await cookedGenerationsFor(changedFirstRow);
    expect(changedCookedGenerations.publicationGeneration).toBe(changedPublication.generation);
    expect(changedCookedGenerations.cookGeneration).toBe(changedPublication.generation);
    const previousFirst = assets.copy(first).unwrap();
    {
      const reloaded = await assets.reload(first, { conflict: 'overwrite' });
      reloaded.unwrap();
    }
    const revised = await load(firstGuid);
    expect(await load(otherGuid)).toBe(other);
    const revisedProjection = assets.getMaterialProjectionForPayload(materialContent(revised));
    if (revisedProjection === undefined) throw new Error('missing revised material projection');
    // Authored pass modules remain stable semantic identities. Dependency
    // invalidation is observed through the immutable cooked publication key,
    // which is what the renderer selects for the new payload generation.
    expect(revisedProjection.specializationKey).not.toBe(firstProjection.specializationKey);
    expect(
      materialContent(revised).passes?.find((pass) => pass.name === 'Overlay')?.program.module,
    ).toBe(overlay.program.module);
    const blue = await sample(revised);
    expect(blue[2]).toBeGreaterThan(150);
    expect(blue[0]).toBeLessThan(5);
    expect(await sample(previousFirst)).toEqual(red); // An explicit copy retains the previous live program.
    expect(await sample(overlayHandle)).toEqual(green);
    expect(assets.shaderRegistry.findMaterialArtifact('forgeax::default-shadow-caster')).toEqual(
      shadow,
    );
    await options.update('broken');
    await waitFor((next) => next.authority !== 'authoritative');
    const lastGood = await fetch(new URL(changedFirstRow.packageUrl, options.binding.catalogUrl));
    // A failed producer preserves accepted bytes and live resources; a new
    // lazy import remains fenced until the author repairs the source.
    expect(lastGood.status).toBe(200);
    expect(
      (await fetch(`${options.binding.importUrlBase}/${firstGuid}`, { method: 'POST' })).status,
    ).toBe(409);
    expect(await sample(revised)).toEqual(blue);
    await options.update('red');
    const repaired = await waitFor(
      (next) =>
        next.authority === 'authoritative' &&
        (() => {
          const row = next.entries.find((candidate) => candidate.guid === firstGuid);
          const publication = row?.publication;
          return (
            row !== undefined &&
            publication !== undefined &&
            row.packageUrl !== changedFirstRow.packageUrl &&
            publication.generation > changedPublication.generation
          );
        })(),
    );
    const repairedFirstRow = repaired.entries.find((row) => row.guid === firstGuid);
    const repairedOtherRow = repaired.entries.find((row) => row.guid === otherGuid);
    if (repairedFirstRow === undefined || repairedOtherRow === undefined)
      throw new Error('missing repaired material Catalog row');
    const repairedPublication = publicationFor(repairedFirstRow);
    const repairedOtherPublication = publicationFor(repairedOtherRow);
    const repairedCurrent = repairedPublication.current;
    if (repairedCurrent === undefined) throw new Error('missing repaired current locator');
    expect(repairedFirstRow.packageUrl).not.toBe(changedFirstRow.packageUrl);
    expect(repairedPublication.generation).toBeGreaterThan(changedPublication.generation);
    expect(repairedFirstRow.packageUrl.endsWith(repairedCurrent.packageUrl)).toBe(true);
    expect(repairedOtherRow.packageUrl).toBe(changedOtherRow.packageUrl);
    expect(repairedOtherPublication.generation).toBe(changedOtherPublication.generation);
    expect(repairedOtherPublication.digest).toBe(changedOtherPublication.digest);
    expect(repairedOtherPublication.outputSetDigest).toBe(changedOtherPublication.outputSetDigest);
    const repairedCookedGenerations = await cookedGenerationsFor(repairedFirstRow);
    expect(repairedCookedGenerations.publicationGeneration).toBe(repairedPublication.generation);
    expect(repairedCookedGenerations.cookGeneration).toBe(repairedPublication.generation);
    expect(repairedCookedGenerations.publicationGeneration).toBeGreaterThan(
      changedCookedGenerations.publicationGeneration,
    );
    {
      const reloaded = await assets.reload(first, { conflict: 'overwrite' });
      reloaded.unwrap();
    }
    expect(await sample(await load(firstGuid))).toEqual(red);
    expect(await load(otherGuid)).toBe(other);
    // The particle material crosses the same real Cook / HTTP / GUID path.
    // No source-module alias is installed into the shader manifest.
    world.despawn(entity).unwrap();
    const particleGuid = options.guids[3];
    const effectGuid = options.guids[4];
    if (particleGuid === undefined || effectGuid === undefined)
      throw new Error('missing particle fixture identity');
    const vfxAttached = await vfx.attachWorld({ world, assets });
    if (!vfxAttached.ok) throw vfxAttached.error;
    const particleMaterial = await load(particleGuid);
    expect(assets.getMaterialProjectionForPayload(materialContent(particleMaterial))).toBeDefined();
    expect(assets.shaderRegistry.findMaterialArtifact('game::published-particle').ok).toBe(false);
    const parsedEffectGuid = AssetGuid.parse(effectGuid);
    if (!parsedEffectGuid.ok) throw parsedEffectGuid.error;
    const loadedEffect = await assets.load(parsedEffectGuid.value, 'particle-effect');
    if (!loadedEffect.ok) throw loadedEffect.error;
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: {
          effect: loadedEffect.value,
          playing: true,
          seed: 1,
          timeScale: 1,
        },
      })
      .unwrap();
    const particlePixel = await sample();
    expect(particlePixel[0]).toBeGreaterThan(150);
    expect(particlePixel[1]).toBeLessThan(5);
    expect(particlePixel[2]).toBeGreaterThan(150);
    world.despawn(player).unwrap();
    const clearedPixel = await sample();
    expect(clearedPixel).not.toEqual(particlePixel);
    await vfx.detachWorld({ world });
    expect(errors, inspect(errors)).toEqual([]);
  } finally {
    const disposed = await renderer.dispose();
    target?.destroy();
    device?.destroy();
    if (!disposed.ok) errors.push(disposed.error);
    await recorder.dispose();
  }
  expect(errors, inspect(errors)).toEqual([]);
}
