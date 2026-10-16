import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { it } from 'vitest';
import { createShaderModule, requestAdapter } from '../../../rhi-webgpu/src/index.js';
import { controlsWorkflowRasterCase } from '../../../ui-blitz/src/__tests__/controls-workflow-gpu-fixture.js';
import type { UiWasmHost } from '../../../ui-blitz/src/index.js';
import { verifyGpuUiParity } from './gpu-ui-parity.fixture.js';

it('renders the composite inventory and settings workflow on Dawn', async () => {
  const bytes = await readFile(new URL('../../../ui-blitz/pkg/ui_blitz_bg.wasm', import.meta.url));
  const font = await readFile(
    new URL(
      '../../../devkit/node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2',
      import.meta.url,
    ),
  );
  const wasm: UiWasmHost = {
    readWasm: async () => bytes,
    instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
  };
  const device = (await (await requestAdapter()).unwrap().requestDevice()).unwrap();
  const directory = 'artifacts/ui-controls-workflow/dawn';
  await mkdir(directory, { recursive: true });
  const results = await verifyGpuUiParity({
    device,
    createReplacementDevice: async () =>
      (await (await requestAdapter()).unwrap().requestDevice()).unwrap(),
    wasm,
    font,
    fontFamily: 'Inventory Fixture',
    cases: [controlsWorkflowRasterCase],
    createShaderModule: async (owner, code) => (await createShaderModule(owner, { code })).unwrap(),
    save: async (name, width, expected, actual) => {
      await Promise.all([
        writeFile(`${directory}/${name}.cpu.rgba`, expected),
        writeFile(`${directory}/${name}.gpu.rgba`, actual),
        writeFile(
          `${directory}/${name}.json`,
          JSON.stringify({ width, height: expected.length / width / 4 }),
        ),
      ]);
    },
  });
  await writeFile(`${directory}/result.json`, JSON.stringify(results, null, 2));
}, 60_000);
