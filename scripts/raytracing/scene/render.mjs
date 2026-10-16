import {
  buildRaySurfaceScene,
  createDiffuseGi,
  createRayDisplay,
  createRayPathTracer,
} from '../../../packages/render/dist/internal.mjs';
import { readbackTexturePixels } from '../../../packages/rhi-debug/dist/index.mjs';
import { sceneSnapshot } from './scene.mjs';
export async function readBuffer(device, buffer, size) {
  const staging = device.createBuffer({ size, usage: 9 }).unwrap();
  try {
    const e = device.createCommandEncoder({}).unwrap();
    e.copyBufferToBuffer(buffer, 0, staging, 0, size);
    device.queue.submit([e.finish().unwrap()]).unwrap();
    const mapped = (await staging.mapAsync(1)).unwrap();
    const result = new Uint8Array(mapped.getMappedRange().unwrap()).slice();
    mapped.unmap();
    return result;
  } finally {
    device.destroyBuffer(staging).unwrap();
  }
}
export async function renderScene(
  device,
  compile,
  prepared,
  options = {},
  recorder,
  progress = () => {},
) {
  const snapshot = sceneSnapshot(prepared, options),
    resolution = snapshot.settings.resolution;
  const { samples = 64 } = options;
  const disposables = [],
    textures = [];
  try {
    progress('Preparing scene');
    const gi = (
      await createDiffuseGi(device, compile, {
        kernel: prepared.kernel,
        sources: snapshot.sources,
        scene: snapshot.sources.map((s) => ({ ...s.instance, field: s.field })),
        lights: snapshot.lights,
        settings: snapshot.settings,
      })
    ).unwrap();
    disposables.push(gi);
    const pt = (
      await createRayPathTracer(device, compile, {
        kernel: prepared.pathKernel,
        scene: buildRaySurfaceScene(
          snapshot.sources.map((s) => ({ ...s.instance, materialId: s.sections[0].material.id })),
        ).unwrap(),
        materials: snapshot.materials,
        lights: snapshot.lights,
        settings: {
          width: resolution,
          height: resolution,
          camera: snapshot.camera,
          maxBounces: 2,
          seed: 47,
          environment: [0, 0, 0],
          maxDistance: gi.diagnostics.rayDistance,
        },
      })
    ).unwrap();
    disposables.push(pt);
    const panels = [];
    for (const mode of ['direct', 'gi', 'indirect', 'coverage', 'path']) {
      const display = (
        await createRayDisplay(device, compile, {
          kernel: prepared.displayKernel,
          buffer: mode === 'path' ? pt.buffers.accumulation : gi.buffers.field,
          resolution,
          mode,
          exposure: 1,
        })
      ).unwrap();
      disposables.push(display);
      const texture = device
        .createTexture({
          label: `scene.${mode}`,
          size: { width: resolution, height: resolution },
          format: 'rgba8unorm',
          usage: 17,
        })
        .unwrap();
      textures.push(texture);
      panels.push({ mode, display, texture, view: device.createTextureView(texture, {}).unwrap() });
    }
    // PT never samples the SDF, surface cache, or irradiance probes.
    for (let i = 0; i < samples; i += 4) {
      const e = device.createCommandEncoder({}).unwrap();
      for (let j = i; j < Math.min(i + 4, samples); j++) pt.recordSample(e).unwrap();
      device.queue.submit([e.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      progress(`Path reference ${Math.min(i + 4, samples)}/${samples}`);
    }
    progress('Gathering GI and presenting');
    const captured = recorder?.captureFrame();
    if (recorder) (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    gi.record(encoder).unwrap();
    for (const panel of panels) panel.display.record(encoder, panel.view).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    if (recorder) (await recorder.frameBoundary()).unwrap();
    const tape = captured ? (await captured).unwrap().bytes : undefined;
    const images = {};
    for (const panel of panels)
      images[panel.mode] = await readbackTexturePixels(
        device,
        panel.texture,
        resolution,
        resolution,
      );
    const raw = {
      probes: await readBuffer(
        device,
        gi.buffers.probes,
        gi.diagnostics.probeCount * snapshot.settings.samples * 32,
      ),
      surface: await readBuffer(device, gi.buffers.surface, gi.cards.width * gi.cards.height * 64),
      field: await readBuffer(device, gi.buffers.field, resolution * resolution * 80),
      reference: await readBuffer(device, gi.buffers.reference, resolution * resolution * 80),
      path: await readBuffer(device, pt.buffers.accumulation, resolution * resolution * 80),
    };
    const states = new Uint32Array(raw.field.buffer),
      counts = { background: 0, complete: 0, incomplete: 0, invalid: 0 },
      names = Object.keys(counts);
    for (let i = 0; i < resolution * resolution; i++) counts[names[states[i * 20 + 16]]]++;
    const gatherCounts = { probe: 0, local: 0 };
    for (let i = 0; i < resolution * resolution; i++)
      if (states[i * 20 + 16] !== 0) gatherCounts[states[i * 20 + 17] === 1 ? 'probe' : 'local']++;
    const f = new Float32Array(raw.field.buffer),
      p = new Float32Array(raw.path.buffer),
      roi = [0, 0, 0];
    let roiCount = 0,
      error = 0,
      referenceEnergy = 0;
    for (let i = 0; i < resolution * resolution; i++) {
      const x = (i % resolution) / resolution,
        y = Math.floor(i / resolution) / resolution;
      for (let c = 0; c < 3; c++) {
        error += Math.abs(f[i * 20 + 12 + c] - p[i * 20 + c]);
        referenceEnergy += p[i * 20 + c];
        if (x >= 0.2 && x < 0.31 && y >= 0.6 && y < 0.8)
          roi[c] += f[i * 20 + 4 + c] * f[i * 20 + 8 + c];
      }
      if (x >= 0.2 && x < 0.31 && y >= 0.6 && y < 0.8) roiCount++;
    }
    const radiometry = {
      boxIndirectMean: roi.map((v) => v / roiCount),
      relativeAbsoluteError: error / Math.max(referenceEnergy, 1e-20),
    };
    return {
      images,
      raw,
      tape,
      report: {
        options: {
          resolution,
          samples,
          light: options.light ?? 1,
          wall: options.wall ?? 'red',
          cameraX: options.cameraX ?? 0,
        },
        camera: snapshot.camera,
        lights: snapshot.lights.map((l) => ({
          ...l,
          position: Array.from(l.position),
          color: Array.from(l.color),
        })),
        counts,
        gatherCounts,
        radiometry,
        diagnostics: gi.diagnostics,
        geometry: {
          instances: snapshot.sources.length,
          triangles: snapshot.sources.reduce((sum, s) => sum + s.instance.indices.length / 3, 0),
        },
        exposure: 1,
        output: 'Reinhard + sRGB',
        pathBounces: 2,
        giSurfaceIterations: 0,
      },
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    for (const item of disposables.reverse()) item.dispose();
    for (const texture of textures) device.destroyTexture(texture).unwrap();
  }
}
