// hello-gi build-time light bake: each scene's irradiance-field probe lattice is
// baked with the exact reference path integrator through the irradiance-volume
// NativeCooker and published as one Pack v2 asset (pack-index + pack + .fxiv
// artifact). The baked Renderer lane loads it from the Catalog by GUID and never
// traces. Output directories are build artifacts (gitignored), never sources.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as gi from './gi-dawn.mjs';

/**
 * Lattice the live field would plan for the same scene config: probes on the
 * Global SDF interior at `probeSpacing`, so baked and live lanes sample one grid.
 * `density` > 1 subdivides it (the baked lane has no per-frame cost per probe).
 */
export function bakeLatticeFor(field, density = 1) {
  const grid = field.region.grid;
  const spacing = Math.fround(field.probeSpacing / density);
  return {
    origin: grid.origin.map((v) => Math.fround(v + grid.spacing)),
    spacing,
    dimensions: grid.dimensions.map(
      (n) => Math.floor(((n - 3) * grid.spacing) / spacing + 1e-6) + 1,
    ),
  };
}

/**
 * Cook one volume. `ray` is the exact ray scene ({ scene, materials, resolveTexture? })
 * and `settings` the bake budget; the result carries the cooked product, bake
 * time and resident sizes for the bake table.
 */
export async function cookVolume({ guid, device, compile, ray, lights, lattice, settings }) {
  const render = await import('@forgeax/engine-render/internal');
  const { NativeCookerRegistry } = await import('@forgeax/engine-pack/native-cooker');
  const registry = new NativeCookerRegistry();
  registry.register(render.createIrradianceVolumeCooker());
  const started = performance.now();
  const heapBefore = process.memoryUsage().rss;
  const product = (
    await registry.runDraft(render.IRRADIANCE_VOLUME_KIND, {
      guid,
      device,
      compile,
      kernel: await gi.compilePathKernel(),
      scene: ray.scene,
      materials: ray.materials,
      ...(ray.resolveTexture === undefined ? {} : { resolveTexture: ray.resolveTexture }),
      lights,
      lattice,
      settings,
    })
  ).unwrap();
  const bakeMs = performance.now() - started;
  const bytes = product.artifacts[render.IRRADIANCE_VOLUME_ARTIFACT].bytes;
  const probes = lattice.dimensions.reduce((a, b) => a * b, 1);
  return {
    product,
    bytes,
    stats: {
      guid,
      digest: product.payload.digest,
      fingerprint: product.inputFingerprint,
      dimensions: product.payload.dimensions,
      probes,
      spacing: lattice.spacing,
      raysPerProbe: settings.raysPerProbe,
      samples: settings.samples,
      maxBounces: settings.maxBounces,
      paths: probes * settings.raysPerProbe * settings.samples,
      bakeMs,
      artifactBytes: bytes.byteLength,
      // GPU-resident probe bytes: field-stride irradiance blocks (2 * 64 + 16
      // RGBA32F texels), 64 RG32F moments and 16 B meta per probe.
      residentBytes: probes * (144 * 16 + 64 * 8 + 16),
      rssDeltaBytes: process.memoryUsage().rss - heapBefore,
    },
  };
}

/** Bake a procedural scene: the same exact ray instances and lights the reference traces. */
export async function bakeProceduralScene({ scene, cooked, guid, device, compile, settings, density }) {
  const { buildRaySurfaceScene } = await import('@forgeax/engine-render/internal');
  const { fieldFor, proceduralBounds } = await import('../src/scenes.ts');
  const instances = await gi.proceduralRayScene(scene, cooked, true);
  return cookVolume({
    guid,
    device,
    compile,
    ray: { scene: buildRaySurfaceScene(instances.instances).unwrap(), materials: instances.materials },
    lights: [gi.lightSnapshot(scene.light)],
    lattice: bakeLatticeFor(fieldFor(proceduralBounds(scene.boxes)), density),
    settings: {
      environment: scene.environment,
      maxDistance: scene.maxDistance,
      ...settings,
    },
  });
}

/**
 * Write cooked volumes as one served catalog directory: `pack-index.json`, one
 * Pack v2 descriptor per volume and its `.fxiv` artifact beside it. The layout is
 * what `installDistCatalog` (and the browser runtime) resolves.
 */
export async function writeBakedCatalog(dir, cooked) {
  const render = await import('@forgeax/engine-render/internal');
  mkdirSync(dir, { recursive: true });
  const index = [];
  for (const { product, bytes } of cooked) {
    const file = `${product.guid}.fxiv`;
    writeFileSync(resolve(dir, file), bytes);
    const pack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: product.guid,
          kind: render.IRRADIANCE_VOLUME_KIND,
          payload: product.payload,
          refs: [],
          artifacts: {
            [render.IRRADIANCE_VOLUME_ARTIFACT]: {
              path: file,
              mediaType: render.IRRADIANCE_VOLUME_MEDIA_TYPE,
              byteLength: bytes.byteLength,
            },
          },
        },
      ],
    };
    writeFileSync(resolve(dir, `${product.guid}.pack.json`), `${JSON.stringify(pack, null, 2)}\n`);
    index.push({
      guid: product.guid,
      packageUrl: `/${product.guid}.pack.json`,
      kind: render.IRRADIANCE_VOLUME_KIND,
      sourcePath: file,
    });
  }
  writeFileSync(resolve(dir, 'pack-index.json'), `${JSON.stringify(index, null, 2)}\n`);
  return dir;
}
