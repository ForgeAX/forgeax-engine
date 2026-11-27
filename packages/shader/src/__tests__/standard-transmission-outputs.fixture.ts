import { createHash } from 'node:crypto';
import { on } from 'node:events';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { afterAll, describe, expect, it, onTestFailed } from 'vitest';
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
const compiler = import(workerData.compilerUrl).then(async ({ prepareShaderProgramCompiler }) =>
  (await prepareShaderProgramCompiler()).unwrap());
parentPort.on('message', async (rows) => {
  try {
    const prepared = await compiler;
    const entries = rows.map(({ key, defines }) => {
      const result = prepared.compile(workerData.template, defines);
      if (!result.ok) throw Error(key + ': ' + result.error.message);
      return [key, result.value.manifestEntry.wgsl];
    });
    parentPort.postMessage({ entries });
  } catch (error) {
    parentPort.postMessage({ error: String(error) });
  }
});`;

type Row = Pick<MaterialShaderManifestVariant, 'definesKey' | 'defines'>;
type Reply = { entries: Array<[string, string]> } | { error: string };

function createBatchCompiler(template: ShaderProgramTemplate, maxRows: number) {
  const requested = Number.parseInt(process.env.FORGEAX_SHADER_COMPILE_WORKERS ?? '', 10);
  const count = Math.max(1, Math.min(maxRows, 4, requested || availableParallelism() - 1));
  // These workers validate the built compiler. Vitest still instruments the
  // source registry, selection, and validation path that requested the work.
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  const workers = Array.from({ length: count }, () => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { compilerUrl, template },
      env,
    });
    return { worker, replies: on(worker, 'message', { close: ['exit'] }) };
  });
  return {
    async compile(rows: readonly Row[]): Promise<Map<string, string>> {
      const results = await Promise.allSettled(
        workers.map(async ({ worker, replies }, lane) => {
          const batch = rows
            .filter((_, index) => index % count === lane)
            .map(({ definesKey, defines }) => ({ key: definesKey, defines }));
          worker.postMessage(batch);
          const reply = await replies.next();
          if (reply.done) throw new Error('Shader compiler worker exited without results');
          const [message] = reply.value as [Reply];
          if ('error' in message) throw new Error(message.error);
          return message.entries;
        }),
      );
      return new Map(
        results.flatMap((result) => {
          if (result.status === 'rejected') throw result.reason;
          return result.value;
        }),
      );
    },
    async close() {
      await Promise.all(
        workers.map(async ({ worker, replies }) => {
          await replies.return?.();
          await worker.terminate();
        }),
      );
    },
  };
}

function expectResources(row: Row, code: string): void {
  const { defines, definesKey: key } = row;
  for (const binding of [27, 28]) {
    expect(
      new RegExp(
        `@group\\(0\\)\\s*@binding\\(${binding}\\)\\s*var\\s+\\w+\\s*:\\s*texture_2d<f32>`,
      ).test(code),
      `${key}: Forward SSR binding ${binding}`,
    ).toBe(defines.FORWARD_INLINE_SSR);
  }
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
  let choice = key;
  if (unusedProjector)
    choice = choice.replace(/PROJECTOR_AVAILABLE=(true|false)/, 'PROJECTOR_AVAILABLE=*');
  // Extended lighting has no consumer in these unclustered rows once Inline SSR is off.
  if (
    defines.STORAGE_BUFFER_AVAILABLE &&
    defines.PROJECTOR_AVAILABLE &&
    !defines.COVERAGE_ONLY &&
    !defines.CLUSTER_FORWARD_AVAILABLE &&
    !defines.ATMOSPHERE_AVAILABLE &&
    !defines.FORWARD_INLINE_SSR
  )
    choice = choice.replace(
      /EXTENDED_LIGHTING_AVAILABLE=(true|false)/,
      'EXTENDED_LIGHTING_AVAILABLE=*',
    );
  const digest = createHash('sha256').update(code).digest('hex');
  const previous = choices.get(digest);
  if (previous !== undefined) expect(choice, key).toBe(previous);
  choices.set(digest, choice);
}

// Resource assertions depend on these flags. For the wet
// slices, cross each remaining define with every reachable resource path.
// The dry slice still compiles every row for its full program-identity oracle.
function resourceWitnesses(rows: readonly Row[]): Row[] {
  const resourceFlags = [
    'CLUSTER_FORWARD_AVAILABLE',
    'EXTENDED_LIGHTING_AVAILABLE',
    'FORWARD_INLINE_SSR',
    'LEAN_LIGHTING',
    'STORAGE_BUFFER_AVAILABLE',
  ];
  const seen = new Set<string>();
  return rows.filter(({ defines }) => {
    const path = resourceFlags.map((flag) => String(defines[flag])).join('/');
    let witness = false;
    for (const [flag, value] of Object.entries(defines)) {
      if (resourceFlags.includes(flag)) continue;
      const interaction = `${path}/${flag}=${value}`;
      if (seen.has(interaction)) continue;
      seen.add(interaction);
      witness = true;
    }
    return witness;
  });
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
  expect(rows.filter(({ defines }) => !defines.FORWARD_INLINE_SSR)).toHaveLength(expectedRows);
  expect(rows.filter(({ defines }) => defines.FORWARD_INLINE_SSR)).toHaveLength(
    !waves && rgba16 ? 96 : 544,
  );
  const witnesses = waves || rgba16 ? resourceWitnesses(rows) : rows;
  expect(witnesses.length).toBeGreaterThan(0);
  const choices = new Map<string, string>();
  const compiled = new Set<string>();
  const batchSize = 128;
  const batches = Array.from({ length: Math.ceil(witnesses.length / batchSize) }, (_, i) =>
    witnesses.slice(i * batchSize, (i + 1) * batchSize),
  );
  describe.sequential(`compiled Standard transmission outputs with waves=${waves} and rgba16=${rgba16}`, () => {
    let compiler: ReturnType<typeof createBatchCompiler> | undefined;
    for (const [index, batch] of batches.entries()) {
      it(`checks batch ${index + 1} of ${batches.length}`, { timeout: 60_000 }, async () => {
        onTestFailed(async () => {
          await compiler?.close();
          compiler = undefined;
        });
        compiler ??= createBatchCompiler(program.template, batchSize);
        const result = await compiler.compile(batch);
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
    afterAll(async () => {
      await compiler?.close();
      expect(compiled.size).toBe(witnesses.length);
      if (!waves && !rgba16) {
        // The identity oracle skips 96 baseline and 24 SSR full-shadow lean rows. The dry
        // no-storage color slice aliases one projector pair per alpha/clip,
        // vertex color and reflection choice. Coverage keys stay distinct.
        const fullShadowLeanRows = 96 + 24;
        const unusedProjectorPairs = 4 * 2 * 2;
        const unusedExtendedLightingPairs = 420;
        expect(choices.size).toBe(
          rows.length - fullShadowLeanRows - unusedProjectorPairs - unusedExtendedLightingPairs,
        );
      }
    });
  });
}
