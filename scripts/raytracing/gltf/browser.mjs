import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
} from '../../../packages/rhi-debug/dist/index.mjs';
import * as gpu from '../../../packages/rhi-webgpu/dist/index.mjs';
import { renderGltf } from './render.mjs';

const status = document.querySelector('#status'),
  button = document.querySelector('#render'),
  capture = document.querySelector('#capture');
let current,
  busy = false;
const errors = [];
try {
  const prepared = await (await fetch('/data/prepared.json')).json();
  const recorder = attachRecorder(gpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const raw = gpu._internal_getRawDevice(device._realDevice);
  raw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  async function render(options = {}) {
    if (busy) throw new Error('Wait for the active render to finish');
    busy = true;
    button.disabled = true;
    capture.disabled = true;
    try {
      current = undefined;
      const result = await renderGltf(
        device,
        recorder.backend.createShaderModule,
        prepared,
        async (name) => {
          const response = await fetch(`/data/${name}`);
          if (!response.ok) throw new Error(`Load failed: ${name}`);
          return new Uint8Array(await response.arrayBuffer());
        },
        options,
        recorder,
        (message) => (status.textContent = message),
      );
      if (errors.length) throw new Error(errors.join('\n'));
      for (const [name, pixels] of result.images.map((pixels, i) => [
        i ? 'indirect-reference' : 'direct-reference',
        pixels,
      ])) {
        const canvas = document.querySelector(`#${name}`);
        canvas.width = canvas.height = result.report.resolution;
        canvas
          .getContext('2d')
          .putImageData(
            new ImageData(new Uint8ClampedArray(pixels), canvas.width, canvas.height),
            0,
            0,
          );
      }
      current = result;
      document.querySelector('#report').textContent = JSON.stringify(result.report, null, 2);
      status.textContent = `Rendered · ${result.report.counts[1].incomplete === 0 ? result.report.resolution ** 2 : 0} complete / ${result.report.counts[1].incomplete} incomplete pixels · ${result.report.samples} PT samples`;
      capture.disabled = false;
      return result.report;
    } catch (error) {
      status.textContent = `Render failed: ${error.message}`;
      throw error;
    } finally {
      busy = false;
      button.disabled = false;
    }
  }
  button.onclick = () =>
    render({
      light: Number(document.querySelector('#light').value),
      camera: {
        origin: [-8, 1.6, Number(document.querySelector('#camera').value)],
        target: [2, 3, 0],
        up: [0, 1, 0],
        verticalFov: 1.05,
      },
      resolution: Number(document.querySelector('#resolution').value),
      samples: Number(document.querySelector('#samples').value),
    }).catch(console.error);
  capture.onclick = () => {
    const url = URL.createObjectURL(new Blob([current.tape.bytes]));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sponza.rhitape';
    a.click();
    URL.revokeObjectURL(url);
  };
  window.__gltfScene = {
    render,
    get result() {
      return current;
    },
    errors,
    async replay() {
      const tape = decodeTape(current.tape.bytes).unwrap(),
        model = buildFrameModel(tape);
      const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      const replayErrors = [];
      const freshRaw = gpu._internal_getRawDevice(fresh);
      freshRaw.addEventListener('uncapturederror', (event) =>
        replayErrors.push(event.error.message),
      );
      const replay = (
        await openReplay(tape, { device: fresh, createShaderModule: gpu.createShaderModule })
      ).unwrap();
      try {
        const results = [];
        const accumulations = model.works.filter((work) =>
          work.pipeline.shaders.some((shader) => shader.entryPoint === 'accumulate'),
        );
        if (accumulations.length !== 2) throw new Error('Expected both captured transport outputs');
        for (const [i, work] of model.works.slice(-2).entries()) {
          const result = (await replay.inspectWork(work.workIndex, ['pixels'])).unwrap();
          const mode = ['direct-reference', 'indirect-reference'][i];
          const bytes = result.attachment.bytes,
            live = current.images[i];
          if (bytes.length !== live.length || bytes.some((v, j) => v !== live[j]))
            throw new Error(`Replay differs: ${mode}`);
          const accumulated = accumulations[i];
          const buffer = accumulated.bindings.find((binding) => binding.binding === 6)?.resourceId;
          if (!buffer) throw new Error('Missing captured accumulation resource');
          const raw = (await replay.readResourceAtWork(buffer, accumulated.workIndex)).unwrap()
            .bytes;
          const expected = current.raw[i];
          if (
            raw.length !== expected.length ||
            raw.some((value, index) => value !== expected[index])
          )
            throw new Error(`Raw transport replay differs: ${mode}`);
          results.push({
            mode,
            workIndex: work.workIndex,
            accumulationWorkIndex: accumulated.workIndex,
            byteEquality: true,
            rawByteEquality: true,
          });
        }
        await fresh.queue.onSubmittedWorkDone();
        if (replayErrors.length) throw new Error(replayErrors.join('\n'));
        return { results, unseededResources: model.unseededResources, errors: replayErrors };
      } finally {
        await replay.dispose();
        gpu._internal_getRawDevice(fresh).destroy();
      }
    },
    async dispose() {
      (await recorder.dispose()).unwrap();
      raw.destroy();
    },
  };
  const query = new URLSearchParams(location.search);
  await render({
    resolution: Number(query.get('resolution') ?? 128),
    samples: Number(query.get('samples') ?? 8),
  });
} catch (error) {
  status.textContent = `Startup failed: ${error.message}`;
  console.error(error);
}
