import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { verifyDist, writeDistManifest } from '../../dist.js';
import type { ProjectFacts } from '../../types.js';
import { writeTauriProject } from '../tauri.js';

it('embeds unchanged browser resources with one native close owner and no native GPU dependency', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-tauri-package-'));
  try {
    await mkdir(resolve(root, 'assets'));
    await mkdir(resolve(root, 'shaders'));
    const wasm = new Uint8Array([0, 97, 115, 109, 0, 255]);
    await writeFile(resolve(root, 'index.html'), '<script src="./assets/game.js"></script>');
    await writeFile(resolve(root, 'assets/game.js'), 'export const game = true;');
    await writeFile(resolve(root, 'assets/game.wasm'), wasm);
    await writeFile(resolve(root, 'pack-index.json'), '[]');
    await writeFile(resolve(root, 'shaders/manifest.json'), '{}');
    await writeTauriProject({ id: 'test-game', name: 'Test Game' } as ProjectFacts, root);
    expect(new Uint8Array(await readFile(resolve(root, 'web/assets/game.wasm')))).toEqual(wasm);
    expect(await readFile(resolve(root, 'web/index.html'), 'utf8')).toBe(
      '<script src="./assets/game.js"></script>',
    );
    const config = JSON.parse(await readFile(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'));
    expect(config.build).toEqual({ frontendDist: '../web' });
    // Android refuses the zero version before compiling the generated project.
    expect(config.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(config.version).not.toBe('0.0.0');
    expect(config.identifier).toBe('com.forgeax.game.gtestgame');
    expect(config.app.windows).toEqual([]);
    expect(config.bundle.windows.wix.language['en-US'].localePath).toBe('locales/en-US.wxl');
    const locale = await readFile(resolve(root, 'src-tauri/locales/en-US.wxl'), 'utf8');
    expect(locale).toContain('Codepage="65001"');
    expect(locale).toContain('<String Id="TauriCodepage">1252</String>');
    // Tauri's static style nonce must not suppress runtime UiAsset inline CSS.
    expect(config.app.security.dangerousDisableAssetCspModification).toEqual(['style-src']);
    const directives = Object.fromEntries(
      config.app.security.csp.split(';').map((part: string) => {
        const [name, ...sources] = part.trim().split(/\s+/);
        return [name, sources];
      }),
    );
    expect(directives['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directives['script-src']).toEqual(["'self'", 'blob:', "'wasm-unsafe-eval'"]);
    // Vite may inline the wgpu provenance JSON that the WebGL2 fallback fetches.
    expect(directives['connect-src']).toEqual(["'self'", 'data:', 'ipc:', 'http://ipc.localhost']);
    expect(directives['font-src']).toEqual(["'self'", 'data:']);
    const cargo = await readFile(resolve(root, 'src-tauri/Cargo.toml'), 'utf8');
    expect(cargo).not.toMatch(/wgpu|rapier|blitz/);
    expect(cargo).toContain('crate-type = ["staticlib", "cdylib", "rlib"]');
    expect(cargo).toContain('tauri = { version = "=2.11.5"');
    const source = await readFile(resolve(root, 'src-tauri/src/lib.rs'), 'utf8');
    expect(source).toContain('await globalThis.__forgeaxTauriDispose?.()');
    expect(source).toContain('observation?.execution?.frame?.completed');
    expect(source).toContain('api.prevent_close()');
    const server = await readFile(resolve(root, 'src-tauri/src/asset_server.rs'), 'utf8');
    expect(server).toContain('TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))');
    expect(server).toContain('assets.get_for_scheme(path, false)');
    expect(server).toContain('include_str!("../capabilities/main.json")');
    // The intercepted document and real Worker server share one loopback origin.
    // An external Android document makes Wry inject Tauri initialization twice.
    expect(source).toContain('register_uri_scheme_protocol(asset_server::PROTOCOL');
    expect(server).toContain('pub const PROTOCOL: &str = "forgeax"');
    expect(server).toContain('request.uri().path().into()');
    expect(server).toContain('request.uri().port_u16() != Some(port)');
    const buildScript = await readFile(resolve(root, 'src-tauri/build.rs'), 'utf8');
    expect(buildScript).toContain('cargo:rustc-link-arg=-Wl,-z,max-page-size=16384');
    expect(buildScript).toContain('cargo:rustc-link-arg=-Wl,-z,common-page-size=16384');
    const network = await readFile(resolve(root, 'src-tauri/android/loopback-network.xml'), 'utf8');
    expect(network).toContain('<base-config cleartextTrafficPermitted="false" />');
    expect(network).toContain('<domain includeSubdomains="false">127.0.0.1</domain>');
    expect(network).toContain('<domain includeSubdomains="false">forgeax.localhost</domain>');
    const manifest = await writeDistManifest(
      { id: 'test-game', name: 'Test Game' } as ProjectFacts,
      './',
      root,
      'tauri',
    );
    expect(manifest.runtime).toEqual({
      packIndexUrl: 'web/pack-index.json',
      shaderManifestUrl: 'web/shaders/manifest.json',
    });
    expect(await verifyDist(root)).toEqual({ ok: true, value: manifest });
    await writeFile(resolve(root, 'web/assets/game.wasm'), new Uint8Array([0]));
    expect(await verifyDist(root)).toMatchObject({
      ok: false,
      error: { code: 'dist-artifact-mismatch' },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
