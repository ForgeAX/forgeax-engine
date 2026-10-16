import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const viewRoot = resolve(import.meta.dirname, '../../..');
const enginePackage = fileURLToPath(import.meta.resolve('@forgeax/engine/package.json'));
const engineRoot = resolve(dirname(enginePackage), '../..');
const viewerRoot = resolve(engineRoot, 'apps/rhi-debug-viewer');
const require = createRequire(resolve(viewerRoot, 'package.json'));

export const fixtureRhiStyle = resolve(viewRoot, 'dist/fixture/rhi-debug-viewer.css');
export const engineRhiStyle = resolve(engineRoot, 'tools/view-plugins/rhi-debug/viewer.css');

export async function generateFixtureRhiStyle() {
  const postcss = require('postcss');
  const tailwind = require('tailwindcss');
  const config = require('tailwindcss/loadConfig')(resolve(viewerRoot, 'tailwind.config.ts'));
  config.content = [resolve(viewerRoot, 'src/**/*.{ts,tsx}')];
  const source = await readFile(resolve(viewerRoot, 'src/styles/globals.css'), 'utf8');
  const style = await postcss([tailwind(config)]).process(source, { from: undefined });
  style.root.walkRules((rule) => {
    if (rule.parent?.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
    rule.selectors = rule.selectors.map((selector) => selector.includes(':root')
      ? selector.replace(':root', '[data-forgeax-diagnostic="rhi-debug"]')
      : `.fx-rhi-tool ${selector}`);
  });
  style.root.append(postcss.rule({ selector: '.fx-rhi-tool > .h-screen', nodes: [
    postcss.decl({ prop: 'height', value: '100%' }),
    postcss.decl({ prop: 'min-height', value: '0' }),
  ] }));
  await mkdir(dirname(fixtureRhiStyle), { recursive: true });
  await writeFile(fixtureRhiStyle, style.root.toString());
  return fixtureRhiStyle;
}
