import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShaderError } from '../../errors.js';
import { createShaderProgramCompiler } from '../../program-compiler.js';
import {
  createNodeMaterialProgramCompiler,
  mapMaterialVariants,
} from '../node-program-compiler.js';

const compilers: ReturnType<typeof createNodeMaterialProgramCompiler>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(compilers.splice(0).map((compiler) => compiler.close()));
});

function compiler(workers: number) {
  const result = createNodeMaterialProgramCompiler(workers);
  compilers.push(result);
  return result;
}

const source = `
@group(0) @binding(0) var<uniform> color: vec4<f32>;
@vertex fn vs_main() -> @builtin(position) vec4<f32> {
  return vec4<f32>(0.0, 0.0, 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return color; }
`;

describe('Node material program compilation', () => {
  it('publishes identical real Standard material bytes and identities through both routes', async () => {
    const run = promisify(execFile);
    const entry = import.meta.resolve('@forgeax/engine-shader-compiler');
    const types = import.meta.resolve('@forgeax/engine-types');
    const script = `
      import { createHash, getCiphers } from 'node:crypto';
      import { Worker } from 'node:worker_threads';
      import { createMaterialPackCooker } from ${JSON.stringify(entry)};
      import { standardSurfaceParameters } from ${JSON.stringify(types)};
      getCiphers();
      const encode = (value) => JSON.stringify(value, (_, entry) => ArrayBuffer.isView(entry)
        ? { type: entry.constructor.name, bytes: Buffer.from(entry.buffer, entry.byteOffset, entry.byteLength).toString('base64') }
        : entry);
      const workers = new Set();
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (...args) {
        if (args[0] !== null) workers.add(this);
        return post.apply(this, args);
      };
      const input = {
        guid: 'worker-material-parity',
        source: {
          kind: 'material',
          parameters: standardSurfaceParameters([{ name: 'baseColor', type: 'color' }]),
          passes: [
            { name: 'forward', program: { module: 'forgeax_material::standard' } },
            { name: 'shadow-caster', program: { module: 'forgeax::default-shadow-caster' } },
          ],
        },
      };
      const result = await createMaterialPackCooker([], { profile: 'webgpu-storage' }).cook(input);
      const firstWorkers = workers.size;
      const next = await createMaterialPackCooker([], { profile: 'webgpu-storage' }).cook(input);
      const expectedBytes = encode(next);
      const stableWorkers = firstWorkers === workers.size;
      const concurrent = await Promise.all(Array.from({ length: 4 }, () =>
        createMaterialPackCooker([], { profile: 'webgpu-storage' }).cook(input)));
      const bad = structuredClone(input);
      bad.source.passes[0].program.module = 'missing::module';
      let diagnostic;
      try { await createMaterialPackCooker([], { profile: 'webgpu-storage' }).cook(bad); }
      catch (error) {
        diagnostic = { code: error.code, message: error.message, expected: error.expected, hint: error.hint, detail: error.detail };
      }
      const totalWorkers = workers.size;
      let workerFailure = false;
      if (process.env.FORGEAX_SHADER_COMPILE_WORKERS !== '1') {
        let interrupted = false;
        Worker.prototype.postMessage = function (...args) {
          if (!interrupted) { interrupted = true; void this.terminate(); return; }
          return post.apply(this, args);
        };
        try { await createMaterialPackCooker([], { profile: 'webgpu-storage' }).cook(input); }
        catch { workerFailure = true; }
        finally { Worker.prototype.postMessage = post; }
        const recovered = await createMaterialPackCooker([], { profile: 'webgpu-storage' }).cook(input);
        if (encode(recovered) !== expectedBytes) throw new Error('worker recovery changed output');
      }
      const bytes = encode(result);
      console.log(JSON.stringify({
        digest: createHash('sha256').update(bytes).digest('hex'),
        programs: result.payload.cooked.programs.length,
        stableWorkers,
        totalWorkers,
        workerFailure,
        concurrentEqual: concurrent.every((draft) => encode(draft) === expectedBytes),
        diagnostic,
        firstWorkers,
        repeatedResult: bytes === expectedBytes,
      }));
    `;
    const outputs = [];
    // Isolate the two complete native runtimes; each route still exercises four concurrent cooks.
    for (const workers of ['1', '2']) {
      const started = Date.now();
      try {
        const result = await run(process.execPath, ['--input-type=module', '--eval', script], {
          env: { ...process.env, FORGEAX_SHADER_COMPILE_WORKERS: workers },
          timeout: 45_000,
        });
        outputs.push(JSON.parse(result.stdout));
      } catch (cause) {
        const failure = cause as {
          killed?: boolean;
          signal?: string;
          stdout?: string;
          stderr?: string;
        };
        throw new Error(
          `Material parity route ${workers} failed after ${Date.now() - started}ms; ` +
            `killed=${failure.killed}; signal=${failure.signal}; ` +
            `stdout=${failure.stdout?.slice(-2000)}; stderr=${failure.stderr?.slice(-4000)}`,
          { cause },
        );
      }
    }
    expect(outputs[0]?.programs).toBeGreaterThan(1);
    expect(outputs[1]?.digest).toBe(outputs[0]?.digest);
    expect(outputs[1]?.programs).toBe(outputs[0]?.programs);
    expect(outputs.map((output) => output.stableWorkers)).toEqual([true, true]);
    expect(outputs.map((output) => output.repeatedResult)).toEqual([true, true]);
    expect(outputs.map((output) => output.concurrentEqual)).toEqual([true, true]);
    expect(outputs[0]?.diagnostic).toBeDefined();
    expect(outputs[1]?.diagnostic).toEqual(outputs[0]?.diagnostic);
    expect(outputs[1]?.totalWorkers).toBeLessThanOrEqual(2);
    expect(outputs.map((output) => output.workerFailure)).toEqual([false, true]);
    expect(outputs[0]?.firstWorkers).toBe(0);
    expect(outputs[1]?.firstWorkers).toBeGreaterThan(0);
    expect(outputs[1]?.firstWorkers).toBeLessThanOrEqual(2);
    // Two isolated native processes, including recovery, also run under CI coverage.
  }, 60_000);

  it('keeps native bytes, reflected selections, mutable isolation and caller errors', async () => {
    const parallel = compiler(2);
    const serial = createShaderProgramCompiler();
    const options = {
      id: 'direct',
      renderEntries: {
        vertex: 'vs_main',
        fragment: 'fs_main',
        colorFormats: ['rgba8unorm'] as const,
      },
    };
    const inputs = [
      { source, options },
      { source, options: { ...options, dynamicOffsets: [{ group: 0, binding: 0 }] } },
      {
        source,
        options: { ...options, renderEntries: { ...options.renderEntries, vertex: 'missing' } },
      },
      { source: `#import absent::entry\n${source}`, options: { ...options, id: 'first-caller' } },
      { source: `#import absent::entry\n${source}`, options: { ...options, id: 'second-caller' } },
      { source: 'this is invalid WGSL', options: { id: 'syntax' } },
    ];
    const expected = [];
    for (const input of inputs) expected.push(await serial(input.source, input.options));
    const actual = await Promise.all(
      inputs.map((input) => parallel.compile(input.source, input.options)),
    );
    for (const [index, result] of actual.entries()) {
      const reference = expected[index];
      if (result.ok) {
        expect(result).toEqual(reference);
        expect(result.unwrap()).toBe(result.value);
        expect(result.unwrapOr(result.value)).toBe(result.value);
      } else {
        expect(result.error).toBeInstanceOf(ShaderError);
        expect(() => result.unwrap()).toThrow(result.error);
        expect(reference?.ok).toBe(false);
        if (reference !== undefined && !reference.ok) {
          for (const field of [
            'code',
            'message',
            'expected',
            'hint',
            'lineNum',
            'linePos',
            'detail',
          ] as const)
            expect(result.error[field]).toEqual(reference.error[field]);
        }
      }
    }
    const successful = actual[0];
    expect(successful?.ok).toBe(true);
    if (successful?.ok) successful.value.deps.push('caller-mutation');
    expect(await parallel.compile(source, options)).toEqual(expected[0]);
  }, 30_000);

  it('drains outstanding native work on close and rejects subsequent calls', async () => {
    const pool = compiler(2);
    const pending = pool.compile(source);
    const closed = pool.close();
    expect((await pending).ok).toBe(true);
    await closed;
    await expect(pool.compile(source)).rejects.toThrow('material compiler is closed');
  }, 30_000);

  it('retains the one-worker serial route', async () => {
    const pool = compiler(1);
    expect(pool.concurrency).toBe(1);
    const pending = pool.compile(source);
    const closed = pool.close();
    expect(await pending).toEqual(await createShaderProgramCompiler()(source));
    await closed;
  }, 30_000);

  it('rejects a failed worker job and permits a later fresh worker', async () => {
    const pool = compiler(2);
    const post = Worker.prototype.postMessage;
    let interrupted = false;
    const spy = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      ...args: Parameters<Worker['postMessage']>
    ) {
      if (!interrupted && args[0] !== null) {
        interrupted = true;
        void this.terminate();
        return;
      }
      return post.apply(this, args);
    });
    await expect(pool.compile(source)).rejects.toThrow('material compiler worker exited');
    spy.mockRestore();
    expect((await pool.compile(source)).ok).toBe(true);
  }, 30_000);

  it('snapshots queued imports before the caller mutates them', async () => {
    const pool = compiler(2);
    const imports = {
      colors: '#define_import_path colors\nfn get_color() -> vec4<f32> { return vec4<f32>(1.0); }',
    };
    const entry =
      '#import colors::get_color\n@fragment fn fs() -> @location(0) vec4<f32> { return get_color(); }';
    const expected = await createShaderProgramCompiler()(entry, { imports });
    const queued = pool.compile(entry, { imports });
    imports.colors = 'invalid mutated module';
    expect(await queued).toEqual(expected);
  }, 30_000);

  it('bounds variant work and preserves order after draining failures', async () => {
    let active = 0;
    let peak = 0;
    const completed: number[] = [];
    const results = await mapMaterialVariants([0, 1, 2, 3], 2, async (input) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      completed.push(input);
      active--;
      return input * 2;
    });
    expect(results).toEqual([0, 2, 4, 6]);
    expect(peak).toBe(2);
    expect(completed).toHaveLength(4);
    completed.length = 0;
    const authoredError = new Error('first authored failure');
    await expect(
      mapMaterialVariants([0, 1, 2], 2, async (input) => {
        if (input === 0) {
          await Promise.resolve();
          throw authoredError;
        }
        completed.push(input);
        if (input === 1) throw new Error('later fast failure');
        return input;
      }),
    ).rejects.toBe(authoredError);
    expect(completed).toEqual([1, 2]);
    await expect(mapMaterialVariants([0], 0, async (input) => input)).rejects.toThrow(RangeError);
  });
});
