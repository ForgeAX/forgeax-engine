import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'";
let fixture;

export const productionCspCommands = {
  async releaseWgpuProductionFixture() {
    if (!fixture) return;
    const { server, output } = fixture;
    fixture = undefined;
    try {
      if (server) await server.close();
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  },
  async prepareWgpuProductionFixture(_context, inline) {
    await productionCspCommands.releaseWgpuProductionFixture();
    const output = await mkdtemp(join(tmpdir(), 'forgeax-wgpu-csp-'));
    fixture = { output };
    try {
      const provenance = JSON.parse(await readFile(join(packageRoot, 'pkg/provenance.json'), 'utf8'));
      await build({
        configFile: false,
        root: packageRoot,
        publicDir: false,
        logLevel: 'silent',
        build: {
          outDir: output,
          emptyOutDir: true,
          minify: false,
          assetsInlineLimit: inline ? 4096 : 0,
          rolldownOptions: {
            input: join(packageRoot, 'src/index.ts'),
            preserveEntrySignatures: 'strict',
            output: { entryFileNames: 'loader.js' },
          },
        },
      });
      const loader = await readFile(join(output, 'loader.js'), 'utf8');
      if (loader.includes('data:application/json;base64,') !== inline)
        throw new Error('Production provenance inlining did not match the requested fixture');
      await writeFile(join(output, 'index.html'), '<script type="module" src="/page.js"></script>');
      await writeFile(
        join(output, 'page.js'),
        `globalThis.dataProbe = fetch('data:application/json,%7B%7D').then(
          () => 'unexpected-success', (error) => error.name);
        globalThis.result = new Promise((resolve) => {
          const worker = new Worker('/worker.js', { type: 'module' });
          worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
          worker.onerror = (event) => resolve({ ok: false, error: event.message });
        });
        Promise.all([globalThis.dataProbe, globalThis.result]).then(([dataProbe, result]) =>
          parent.postMessage({ ...result, dataProbe }, '*'));`,
      );
      await writeFile(
        join(output, 'worker.js'),
        `try {
          const { ensureReady, getCompilerFingerprint } = await import('./loader.js');
          const ready = ensureReady();
          const wasm = await ready;
          postMessage({ ok: true,
            fingerprint: await getCompilerFingerprint(),
            singleton: ready === ensureReady(),
            hasRhi: typeof wasm.RhiWgpuInstance.create === 'function' });
        } catch (error) { postMessage({ ok: false, error: String(error) }); }`,
      );
      fixture.server = await preview({
        configFile: false,
        root: packageRoot,
        logLevel: 'silent',
        build: { outDir: output },
        preview: {
          host: '127.0.0.1',
          port: 0,
          headers: {
            'Content-Security-Policy': csp,
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Resource-Policy': 'cross-origin',
          },
        },
      });
      return {
        url: fixture.server.resolvedUrls.local[0],
        fingerprint: provenance.compilerFingerprint,
      };
    } catch (error) {
      await productionCspCommands.releaseWgpuProductionFixture();
      throw error;
    }
  },
};
