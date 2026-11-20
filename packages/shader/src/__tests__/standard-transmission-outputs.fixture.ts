import { createHash } from 'node:crypto';
import { on } from 'node:events';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import {
  admitShaderTemplateManifest,
  type MaterialShaderManifestVariant,
  type ShaderProgramTemplate,
  selectShaderProgramDefines,
} from '../index.js';
import {
  loadEngineTemplateRegistry,
  STANDARD_PBR_IDENTIFIER,
} from './standard-template-registry.fixture.js';

const compilerUrl = new URL('../../../shader-compiler/dist/program.mjs', import.meta.url).href;
const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
async function compile() {
  const { prepareShaderProgramCompiler } = await import(workerData.compilerUrl);
  const compiler = (await prepareShaderProgramCompiler()).unwrap();
  return workerData.rows.map(({ key, defines }) => {
    const result = compiler.compile(workerData.template, defines);
    if (!result.ok) throw Error(key + ': ' + result.error.message);
    return [key, result.value.manifestEntry.wgsl];
  });
}
compile().then(entries => parentPort.postMessage({ entries }), error => parentPort.postMessage({ error: String(error) }));`;

type Row = Pick<MaterialShaderManifestVariant, 'definesKey' | 'defines'>;
type Reply = { entries: Array<[string, string]> } | { error: string };

async function compileBatch(
  template: ShaderProgramTemplate,
  rows: readonly Row[],
): Promise<Map<string, string>> {
  const requested = Number.parseInt(process.env.FORGEAX_SHADER_COMPILE_WORKERS ?? '', 10);
  const count = Math.max(1, Math.min(rows.length, 4, requested || availableParallelism() - 1));
  const batches = Array.from({ length: count }, (_, lane) =>
    rows
      .filter((_, index) => index % count === lane)
      .map(({ definesKey, defines }) => ({ key: definesKey, defines })),
  );
  const results = await Promise.allSettled(
    batches.map(async (batch) => {
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: { compilerUrl, template, rows: batch },
      });
      const replies = on(worker, 'message', { close: ['exit'] });
      try {
        const reply = await replies.next();
        if (reply.done) throw new Error('Shader compiler worker exited without results');
        const [message] = reply.value as [Reply];
        if ('error' in message) throw new Error(message.error);
        return message.entries;
      } finally {
        await replies.return?.();
        await worker.terminate();
      }
    }),
  );
  return new Map(
    results.flatMap((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    }),
  );
}

function expectResources(row: Row, code: string): void {
  const { defines, definesKey: key } = row;
  const extended = defines.CLUSTER_FORWARD_AVAILABLE && defines.EXTENDED_LIGHTING_AVAILABLE;
  for (const resource of ['iesProfileTexture', 'cookieTexture', 'ltcGgxTexture']) {
    const sampled = Boolean(
      extended && (resource === 'iesProfileTexture' || !defines.LEAN_LIGHTING),
    );
    expect(
      new RegExp(`textureSampleLevel\\(${resource}\\w*,`).test(code),
      `${key}: ${resource}`,
    ).toBe(sampled);
  }
  if (defines.CLUSTER_FORWARD_AVAILABLE && !defines.STORAGE_BUFFER_AVAILABLE) {
    expect(code, key).toMatch(/var\s+cluster_data_texture\w*\s*:\s*texture_2d<u32>/);
    expect(code, key).toMatch(/textureLoad\(cluster_data_texture\w*,/);
    expect(code, key).not.toMatch(/var\s*<\s*storage\b/);
  }
}

function expectProgramChoice(row: Row, code: string, choices: Map<string, string>): void {
  const { defines, definesKey: key } = row;
  // The original non-Water identity contract excludes the later lean/full-shadow rows.
  if (defines.LEAN_LIGHTING && !defines.DIRECTIONAL_SHADOW_SIMPLE) return;
  const unusedProjector =
    !defines.STORAGE_BUFFER_AVAILABLE &&
    !defines.CLUSTER_FORWARD_AVAILABLE &&
    !defines.TRANSMISSION_AVAILABLE;
  if (defines.LEAN_LIGHTING || unusedProjector) {
    expect(code, key).not.toMatch(/textureSampleLevel\(projectorTexture\w*,/);
  }
  const choice = unusedProjector
    ? key.replace(/PROJECTOR_AVAILABLE=(true|false)/, 'PROJECTOR_AVAILABLE=*')
    : key;
  const digest = createHash('sha256').update(code).digest('hex');
  const previous = choices.get(digest);
  if (previous !== undefined) expect(choice, key).toBe(previous);
  choices.set(digest, choice);
}

export async function testStandardTransmissionOutputs(
  waves: boolean,
  rgba16: boolean,
  expectedRows: number,
): Promise<void> {
  const { wire, registry } = await loadEngineTemplateRegistry();
  const declaration = wire.materialShaders.find(
    ({ identifier }) => identifier === STANDARD_PBR_IDENTIFIER,
  );
  if (declaration === undefined) throw new Error('Missing Standard PBR template declaration');
  const program = admitShaderTemplateManifest(wire).unwrap().programs.get(declaration.program);
  if (program === undefined) throw new Error('Missing admitted Standard PBR template');
  const standard = [...registry.materialShaderManifestEntries()].find(
    ({ identifier }) => identifier === STANDARD_PBR_IDENTIFIER,
  );
  if (standard === undefined) throw new Error('Missing Standard PBR registry row');
  const rows = standard.variants
    .filter(
      ({ defines }) =>
        defines.WATER_WAVES_AVAILABLE === waves && defines.WATER_INFO_RGBA16 === rgba16,
    )
    .map(({ defines, definesKey }) => ({
      defines: selectShaderProgramDefines(program, defines).unwrap().defines,
      definesKey,
    }));
  expect(rows).toHaveLength(expectedRows);
  const choices = new Map<string, string>();
  const compiled = new Set<string>();
  const batchSize = 128;
  const batches = Array.from({ length: Math.ceil(rows.length / batchSize) }, (_, i) =>
    rows.slice(i * batchSize, (i + 1) * batchSize),
  );
  describe.sequential(`compiled Standard transmission outputs with waves=${waves} and rgba16=${rgba16}`, () => {
    for (const [index, batch] of batches.entries()) {
      it(`checks batch ${index + 1} of ${batches.length}`, { timeout: 60_000 }, async () => {
        const result = await compileBatch(program.template, batch);
        expect(result.size).toBe(batch.length);
        for (const row of batch) {
          const code = result.get(row.definesKey);
          if (code === undefined)
            throw new Error(`Missing compiled Standard output ${row.definesKey}`);
          expectResources(row, code);
          if (!waves && !rgba16) expectProgramChoice(row, code, choices);
          compiled.add(row.definesKey);
        }
      });
    }
    afterAll(() => {
      expect(compiled.size).toBe(expectedRows);
      if (!waves && !rgba16) expect(choices.size).toBe(5776);
    });
  });
}
