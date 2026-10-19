import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine/vite-plugin-shader';
import { build } from 'vite';

const revision = '9c46b0394ea4081e663cae1307c64990e0143e52';
const [source, destination, mode] = process.argv.slice(2);
assert.ok(source && destination && ['forgeax', 'reference'].includes(mode),
  'Usage: node build.mjs <upstream-checkout> <output-directory> <forgeax|reference>');
const root = resolve(source);
const outDir = resolve(destination);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), revision);
execFileSync('git', ['diff', '--exit-code', 'HEAD', '--'], { cwd: root, stdio: 'pipe' });
const native = mode === 'forgeax';
const upstream = dirname(dirname(fileURLToPath(import.meta.resolve('three'))));
assert.equal(JSON.parse(await readFile(`${upstream}/package.json`, 'utf8')).version, '0.184.0');
const diagnostics = fileURLToPath(new URL('./diagnostics.mjs', import.meta.url));
// Both renderers start with the same font pixels. Otherwise the smaller reference
// bundle can paint its CanvasTextures before the application's webfont arrives.
await writeFile(`${root}/.forgeax-migration-entry.mjs`, `
await document.fonts.load('400px MyFont');
await import('./main.js');
const { attachDiagnostics } = await import(${JSON.stringify(diagnostics)});
attachDiagnostics(${JSON.stringify(mode)});
`);
await build({
  configFile: false, root, base: './',
  plugins: [
    ...(native ? [forgeaxShader()] : []),
    { name: 'rubik-local-resources', transformIndexHtml: { order: 'pre', handler(html) {
      return html.replace('./dist/main.min.js', './.forgeax-migration-entry.mjs')
        .replace(/ integrity="[^"]+"/g, '')
        .replace('</head>', '<link rel="icon" href="data:,"></head>')
        .replace('https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.3.2/css/bootstrap.min.css', './node_modules/bootstrap/dist/css/bootstrap.min.css')
        .replace('https://cdnjs.cloudflare.com/ajax/libs/bootstrap-icons/1.11.3/font/bootstrap-icons.min.css', './node_modules/bootstrap-icons/font/bootstrap-icons.min.css')
        .replace('https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js', './vendor/jquery.min.js')
        .replace('https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.3.2/js/bootstrap.min.js', './vendor/bootstrap.min.js');
    } } },
  ],
  resolve: { alias: [
    { find: /^three$/, replacement: native ? fileURLToPath(import.meta.resolve('@forgeax/engine/three')) : `${upstream}/build/three.module.js` },
    // The upstream barrel imports only OrbitControls. This is an import-path
    // migration; it does not claim support for the complete addons barrel.
    { find: /^three\/addons$/, replacement: native ? fileURLToPath(import.meta.resolve('@forgeax/engine/three/addons/controls/OrbitControls.js')) : `${upstream}/examples/jsm/controls/OrbitControls.js` },
  ] },
  build: { target: 'esnext', outDir, emptyOutDir: true, sourcemap: true },
});
await mkdir(`${outDir}/vendor`, { recursive: true });
await cp(`${root}/node_modules/jquery/dist/jquery.min.js`, `${outDir}/vendor/jquery.min.js`);
await cp(`${root}/node_modules/bootstrap/dist/js/bootstrap.min.js`, `${outDir}/vendor/bootstrap.min.js`);
await cp(`${root}/LICENSE`, `${outDir}/LICENSE-RUBIK`);
await cp(`${upstream}/LICENSE`, `${outDir}/LICENSE-THREE`);
await cp(`${root}/node_modules/three.interaction/README.md`, `${outDir}/THREE-INTERACTION-README.md`);
await cp(`${root}/node_modules/three.interaction/package.json`, `${outDir}/THREE-INTERACTION-PACKAGE.json`);
await cp(`${root}/node_modules/bootstrap/LICENSE`, `${outDir}/LICENSE-BOOTSTRAP`);
await cp(`${root}/node_modules/bootstrap-icons/LICENSE`, `${outDir}/LICENSE-BOOTSTRAP-ICONS`);
await cp(`${root}/node_modules/jquery/LICENSE.txt`, `${outDir}/LICENSE-JQUERY`);
await writeFile(`${outDir}/provenance.json`, JSON.stringify({
  repository: 'https://github.com/HichemTab-tech/RubiksCube-threejs', revision,
  engineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim(),
  engineSourceDirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim().length > 0,
  mode, threeVersion: '0.184.0', businessSourceChanges: 0,
  imports: { three: native ? '@forgeax/engine/three' : 'three',
    'three/addons': native ? '@forgeax/engine/three/addons/controls/OrbitControls.js' : 'three/addons/controls/OrbitControls.js' },
  hostChanges: ['Local copies of the existing CDN resources', 'Shared webfont readiness before startup', 'External diagnostics panel'],
}, null, 2));
