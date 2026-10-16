import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
} from '../../../packages/rhi-debug/dist/index.mjs';
import * as gpu from '../../../packages/rhi-webgpu/dist/index.mjs';
import { renderScene } from './render.mjs';

const status = document.querySelector('#status'),
  button = document.querySelector('#render'),
  capture = document.querySelector('#capture');
let current,
  busy = false;
const errors = [];
try {
  const prepared = await (await fetch('/gi-prepared.json')).json();
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
      const result = await renderScene(
        device,
        recorder.backend.createShaderModule,
        prepared,
        options,
        recorder,
        (message) => (status.textContent = message),
      );
      if (errors.length) throw new Error(errors.join('\n'));
      for (const [name, pixels] of Object.entries(result.images)) {
        const canvas = document.querySelector(`#${name}`);
        canvas.width = canvas.height = result.report.options.resolution;
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
      status.textContent = `Rendered · ${result.report.counts.complete} complete / ${result.report.counts.incomplete} incomplete pixels · ${result.report.options.samples} PT samples`;
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
      wall: document.querySelector('#wall').value,
      cameraX: Number(document.querySelector('#camera').value),
      resolution: Number(document.querySelector('#resolution').value),
      samples: Number(document.querySelector('#samples').value),
    }).catch(console.error);
  capture.onclick = () => {
    const url = URL.createObjectURL(new Blob([current.tape]));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'diffuse-gi-scene.rhitape';
    a.click();
    URL.revokeObjectURL(url);
  };
  window.__giScene = {
    render,
    get result() {
      return current;
    },
    errors,
    async replay() {
      const tape = decodeTape(current.tape).unwrap(),
        model = buildFrameModel(tape);
      const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      const replay = (
        await openReplay(tape, { device: fresh, createShaderModule: gpu.createShaderModule })
      ).unwrap();
      try {
        const results = [];
        for (const [i, work] of model.works.slice(-5).entries()) {
          const result = (await replay.inspectWork(work.workIndex, ['pixels'])).unwrap();
          const mode = ['direct', 'gi', 'indirect', 'coverage', 'path'][i];
          const bytes = result.attachment.bytes,
            live = current.images[mode];
          if (bytes.length !== live.length || bytes.some((v, j) => v !== live[j]))
            throw new Error(`Replay differs: ${mode}`);
          results.push({ mode, workIndex: work.workIndex, byteEquality: true });
        }
        return { results, unseededResources: model.unseededResources };
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
    resolution: Number(query.get('resolution') ?? 256),
    samples: Number(query.get('samples') ?? 64),
  });
} catch (error) {
  status.textContent = `Startup failed: ${error.message}`;
  console.error(error);
}
