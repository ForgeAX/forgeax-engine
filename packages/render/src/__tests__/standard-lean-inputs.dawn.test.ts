import { on } from 'node:events';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import {
  admitShaderTemplateManifest,
  type ShaderProgramTemplate,
  selectShaderProgramDefines,
} from '@forgeax/engine-shader';
import {
  buildEngineShaderTemplateManifest,
  publishedVariantDefines,
} from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { readEngineTemplates } from './engine-shader-templates.dawn.fixture';
import { generalComparison, validateStandardLeanRoster } from './standard-lean-oracle.fixture';

const identifier = 'forgeax::default-standard-pbr';
const compilerUrl = import.meta.resolve('@forgeax/engine-shader-compiler/program');
const workerSource = `
  const { parentPort, workerData } = require('node:worker_threads');
  const compiler = import(workerData.compilerUrl).then(async ({ prepareShaderProgramCompiler }) =>
    (await prepareShaderProgramCompiler()).unwrap(),
  );
  const generalFieldsByKey = new Map();
  parentPort.on('message', async ({ lean, general, generalKey }) => {
    try {
      const service = await compiler;
      const wgsl = service.compile(workerData.template, lean).unwrap().manifestEntry.wgsl;
      let generalFields = generalFieldsByKey.get(generalKey);
      if (generalFields === undefined) {
        const full = service.compile(workerData.template, general).unwrap().manifestEntry.wgsl;
        generalFields = /struct VsOut\\s*\\{([^}]*)\\}/.exec(full)?.[1];
        if (generalFields === undefined) throw new Error('missing general vertex output');
        generalFieldsByKey.set(generalKey, generalFields);
      }
      parentPort.postMessage({ wgsl, generalFields });
    } catch (error) {
      parentPort.postMessage({ error: error.message });
    }
  });`;

type Defines = Readonly<Record<string, boolean>>;
interface Comparison {
  readonly lean: Defines;
  readonly general: Defines;
  readonly generalKey: string;
  readonly key: string;
}

type WorkerResult =
  | { readonly wgsl: string; readonly generalFields: string }
  | { readonly error: string };

async function checkWorkerRows(
  template: ShaderProgramTemplate,
  rows: readonly Comparison[],
  device: GPUDevice,
): Promise<string[]> {
  const worker = new Worker(workerSource, { eval: true, workerData: { template, compilerUrl } });
  const replies = on(worker, 'message', { close: ['exit'] });
  const failures: string[] = [];
  try {
    for (const row of rows) {
      worker.postMessage(row);
      const reply = await replies.next();
      if (reply.done) throw new Error(`compiler worker exited during ${row.key}`);
      const [result] = reply.value as [WorkerResult];
      if ('error' in result) throw new Error(`${row.key}: ${result.error}`);
      const module = device.createShaderModule({ code: result.wgsl });
      const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error');
      if (errors.length > 0) failures.push(`${row.key}: ${errors[0]?.message}`);
      const fields = /struct VsOut\s*\{([^}]*)\}/.exec(result.wgsl)?.[1] ?? '';
      expect(fields, row.key).not.toMatch(/\b(?:uvPair[123]|positionOS|objectBasis\d)_?\s*:/);
      expect(fields, row.key).toMatch(/\bworldTangent_?\s*:/);
      expect(fields, row.key).toMatch(/\buvPair0_?\s*:\s*vec2<f32>/);
      expect(fields.length, row.key).toBeLessThan(result.generalFields.length);
    }
    return failures;
  } finally {
    await replies.return?.();
    await worker.terminate();
  }
}

it('validates every STANDARD_LEAN_INPUTS row and shrinks its vertex output', {
  timeout: 600_000,
}, async () => {
  const wire = await buildEngineShaderTemplateManifest();
  const admitted = admitShaderTemplateManifest(wire).unwrap();
  const declaration = wire.materialShaders.find((entry) => entry.identifier === identifier);
  const program =
    declaration === undefined ? undefined : admitted.programs.get(declaration.program);
  if (program === undefined) throw new Error('missing Standard PBR template');
  const registry = await readEngineTemplates(wire);
  const standard = [...registry.materialShaderManifestEntries()].find(
    (entry) => entry.identifier === identifier,
  );
  if (standard === undefined) throw new Error('missing Standard PBR manifest entry');
  const byKey = new Map(standard.variants.map((variant) => [variant.definesKey, variant]));
  const source = readFileSync(
    new URL('../../../shader/src/default-standard-pbr.wgsl', import.meta.url),
    'utf8',
  );
  const rows = validateStandardLeanRoster(standard.variants, publishedVariantDefines(source));
  const comparisons = rows.map((row): Comparison => {
    const general = generalComparison(row, byKey);
    return {
      lean: selectShaderProgramDefines(program, row.defines).unwrap().defines,
      general: selectShaderProgramDefines(program, general.defines).unwrap().defines,
      generalKey: general.definesKey,
      key: row.definesKey,
    };
  });
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('lean input validation requires a GPU adapter');
  const device = await adapter.requestDevice({ requiredFeatures: ['primitive-index'] });
  const requested = Number.parseInt(process.env.FORGEAX_SHADER_COMPILE_WORKERS ?? '', 10);
  const workers = Math.max(1, Math.min(6, requested || availableParallelism() - 1));
  const batches = Array.from({ length: workers }, (): Comparison[] => []);
  const generalLanes = new Map<string, Comparison[]>();
  for (const comparison of comparisons) {
    let batch = generalLanes.get(comparison.generalKey);
    if (batch === undefined) {
      batch = batches[generalLanes.size % workers] as Comparison[];
      generalLanes.set(comparison.generalKey, batch);
    }
    batch.push(comparison);
  }
  try {
    const results = await Promise.allSettled(
      batches.map((batch) => checkWorkerRows(program.template, batch, device)),
    );
    expect(
      results.flatMap((result) =>
        result.status === 'fulfilled' ? result.value : [String(result.reason)],
      ),
    ).toEqual([]);
  } finally {
    device.destroy();
  }
});
