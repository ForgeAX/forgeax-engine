import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');

describe('GPU pass timing Dawn lifecycle', () => {
  it('collects unowned receipts while caller-owned old receipts remain observable', () => {
    const hostModule = pathToFileURL(resolve(repoRoot, 'packages/render/bench/gpu-pass-timing/dawn-fixture-built.mjs')).href;
    const output = execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      const { create, globals } = await import('@forgeax/engine-dawn-node');
      Object.assign(globalThis, globals);
      Object.defineProperty(globalThis, 'navigator', { value: { gpu: create([]) }, configurable: true });
      const { createDawnGpuPassTimingFixture } = await import(${JSON.stringify(hostModule)});
      const fixture = await createDawnGpuPassTimingFixture({ timingEnabled: false });
      const refs = [];
      let held;
      try {
        for (let i = 0; i < 48; i++) {
          fixture.world.update(1 / 60).unwrap();
          const receipt = fixture.renderer.draw({ leases: [fixture.lease],
            camera: { lease: fixture.lease }, environment: { lease: fixture.lease } }).unwrap();
          (await receipt.completed).unwrap();
          if (i === 0) held = receipt;
          else if (i < 47) refs.push(new WeakRef(receipt));
        }
        for (let i = 0; i < 8; i++) {
          await new Promise(resolve => setImmediate(resolve));
          global.gc();
        }
        assert.equal((await fixture.renderer.observe(held, { include: ['draws'] })).ok, true);
        const retained = refs.filter(ref => ref.deref() !== undefined).length;
        await fixture.renderer.dispose();
        assert.equal((await fixture.renderer.observe(held, { include: ['draws'] })).ok, false);
        console.log('receipt-lifetime=' + JSON.stringify({ retained }));
      } finally {
        await fixture.renderer.dispose();
        await fixture.releaseTargets();
      }
    `], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 });
    expect(output).toContain('receipt-lifetime={"retained":0}');
  }, 70_000);

  it(
    'releases the real device before post-report child exit',
    async () => {
      const tempRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-gpu-pass-timing-'));
      const outputPath = resolve(tempRoot, 'report.json');
      // Use the built carrier in the child. Importing the TypeScript fixture
      // would recompile the entire render graph and rebuild the shader
      // manifest before the lifecycle assertion starts.
      const hostModule = pathToFileURL(resolve(repoRoot, 'packages/render/bench/gpu-pass-timing/dawn-fixture-built.mjs')).href;
      const childSource = `
        import { writeFile } from 'node:fs/promises';
        const { create, globals } = await import('@forgeax/engine-dawn-node');
        Object.assign(globalThis, globals);
        const navigatorScope = {};
        Object.defineProperty(globalThis, 'navigator', {
          value: navigatorScope,
          configurable: true,
          writable: true,
        });
        const gpu = create([]);
        navigatorScope.gpu = gpu;
        let destroyCalls = 0;
        const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
        gpu.requestAdapter = async (...adapterArgs) => {
          const adapter = await originalRequestAdapter(...adapterArgs);
          if (adapter === null) return adapter;
          const originalRequestDevice = adapter.requestDevice.bind(adapter);
          adapter.requestDevice = async (...deviceArgs) => {
            const device = await originalRequestDevice(...deviceArgs);
            const originalDestroy = device.destroy.bind(device);
            device.destroy = () => {
              destroyCalls += 1;
              return originalDestroy();
            };
            return device;
          };
          return adapter;
        };
        const { createDawnGpuPassTimingFixture } = await import(${JSON.stringify(hostModule)});
        const fixture = await createDawnGpuPassTimingFixture();
        try {
          for (let frameIndex = 0; frameIndex < 3; frameIndex += 1) {
            fixture.world.update(1 / 60).unwrap();
            const drawn = fixture.renderer.draw({
              leases: [fixture.lease],
              camera: { lease: fixture.lease },
              environment: { lease: fixture.lease },
            });
            if (!drawn.ok) throw new Error(drawn.error.hint);
            const observed = await fixture.renderer.observe(drawn.value, { include: ['timings'] });
            if (!observed.ok) throw new Error(observed.error.hint);
          }
        } finally {
          await fixture.renderer.dispose();
          await fixture.releaseTargets();
        }
        await writeFile(${JSON.stringify(outputPath)}, JSON.stringify({ destroyCalls }));
        console.log('after-report-write destroyCalls=' + destroyCalls);
        if (destroyCalls !== 1) throw new Error('expected one real GPUDevice.destroy call');
      `;
      const runtime = process.env.FORGEAX_BUN_BIN ?? process.execPath;
      const runtimeArgs = ['--eval', childSource];
      const child = spawn(runtime, runtimeArgs, {
        cwd: repoRoot,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      const exitPromise = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
      }, 60_000);
      try {
        const [exitCode, signal] = await exitPromise;
        clearTimeout(timeout);
        expect(signal, `${stdout}\n${stderr}`).toBeNull();
        expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
        expect(stdout).toContain('after-report-write destroyCalls=1');
        expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual({ destroyCalls: 1 });
        expect(child.pid).toBeDefined();
        expect(() => process.kill(child.pid as number, 0)).toThrow();
      } finally {
        clearTimeout(timeout);
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
