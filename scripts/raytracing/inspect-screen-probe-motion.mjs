import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? process.cwd()),
  directory = resolve(process.argv[3] ?? 'artifacts/screen-probe/dawn');
const debug = await import(pathToFileURL(resolve(root, 'packages/rhi-debug/dist/index.mjs')));
const native = await import(
  pathToFileURL(resolve(root, 'packages/rhi-wgpu-native/dist/index.mjs'))
);
const gpu = await import(pathToFileURL(resolve(root, 'packages/rhi-webgpu/dist/index.mjs')));
native.installNavigatorGpu().unwrap();
const output = resolve(directory, 'motion-replay');
await mkdir(output, { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const report = {
  qualification:
    'Actual fresh-device per-work replay of preserved production motion frames. This diagnoses resources and does not change the original motion thresholds or claim physical performance.',
  frames: [],
};
for (const mode of ['before', 'first', 'after7', 'converged']) {
  let bytes, tape, model;
  try {
    bytes = await readFile(resolve(directory, `motion-${mode}.rhitape`));
    tape = debug.decodeTape(bytes).unwrap();
    model = debug.buildFrameModel(tape);
  } catch (error) {
    report.frames.push({
      mode,
      failure: { stage: 'capture-read', message: String(error), code: error.code },
      reads: [],
      errors: [],
    });
    await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    continue;
  }
  const selected = [];
  const stageWorkCounts = {};
  for (const entry of [
    'resolveProbeRays',
    'temporalProbeRadiance',
    'filterProbeRadiance',
    'integrateScreenProbes',
    'temporalScreenProbes',
  ]) {
    const works = model.works.filter((w) => w.pipeline.shaders.some((s) => s.entryPoint === entry));
    stageWorkCounts[entry] = works.length;
    if (['integrateScreenProbes', 'temporalScreenProbes'].includes(entry) && works.length !== 1)
      throw Error(`Expected one ${entry}`);
    for (const work of works) {
      for (const binding of [
        0, 1, 2, 3, 7, 9, 11, 13, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
      ]) {
        if (!work.bindings.some((b) => b.groupIndex === 0 && b.binding === binding)) continue;
        selected.push({
          entry,
          binding,
          workIndex: work.workIndex,
          multipleWorks: works.length > 1,
          request: debug.bindingReadRequest(work, 0, binding).unwrap(),
        });
      }
    }
  }
  const adapter = (await gpu.rhi.requestAdapter()).unwrap(),
    device = (
      await adapter.requestDevice(debug.replayDeviceRequest(tape, adapter.features, adapter.limits))
    ).unwrap();
  const raw = gpu._internal_getRawDevice(device),
    errors = [];
  raw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  let session;
  const frame = {
    mode,
    tapeSha256: sha(bytes),
    tapeBytes: bytes.length,
    adapterInfo: raw.adapterInfo ?? null,
    reads: [],
    stageWorkCounts,
    errors,
  };
  report.frames.push(frame);
  try {
    session = (
      await debug.openReplay(tape, { device, createShaderModule: gpu.createShaderModule })
    ).unwrap();
    const batch = await session.readAtWorks(selected.map((s) => s.request));
    if (!batch.ok) {
      frame.failure = batch.error;
      continue;
    }
    for (let i = 0; i < batch.value.length; i++) {
      const result = batch.value[i],
        s = selected[i];
      if (!result.ok) {
        frame.reads.push({ ...s, error: result.error });
        continue;
      }
      const { bytes: readBytes, ...metadata } = result.value,
        file = `${mode}-${s.entry}${s.multipleWorks ? `-w${s.workIndex}` : ''}-b${s.binding}.bin`;
      await writeFile(resolve(output, file), readBytes);
      frame.reads.push({
        ...s,
        ...metadata,
        file,
        byteLength: readBytes.length,
        sha256: sha(readBytes),
      });
    }
  } catch (error) {
    frame.failure = { message: String(error), stack: error.stack };
  } finally {
    if (session) (await session.dispose()).unwrap();
    raw.destroy();
    await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(
    JSON.stringify({
      mode,
      reads: frame.reads.length,
      failures: frame.reads.filter((r) => r.error).length,
      errors,
      failure: frame.failure,
    }),
  );
}
if (report.frames.some((f) => f.failure || f.errors.length || f.reads.some((r) => r.error)))
  process.exitCode = 1;
