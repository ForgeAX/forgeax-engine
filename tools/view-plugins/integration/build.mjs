import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../..');
const view = resolve(root, 'tools/view');
if (!existsSync(resolve(view, 'package.json'))) throw new Error('view-source-missing: initialize the pinned tools/view submodule');
const require = createRequire(resolve(root, 'apps/rhi-debug-viewer/package.json'));
const postcss = require('postcss');
const tailwind = require('tailwindcss');
const { readFile } = await import('node:fs/promises');
const config = require('tailwindcss/loadConfig')(resolve(root, 'apps/rhi-debug-viewer/tailwind.config.ts'));
config.content = [resolve(root, 'apps/rhi-debug-viewer/src/**/*.{ts,tsx}')];
const style = await postcss([tailwind(config)]).process(await readFile(resolve(root, 'apps/rhi-debug-viewer/src/styles/globals.css'), 'utf8'), { from: undefined });
const dockview = postcss.parse(await readFile(require.resolve('dockview-react/dist/styles/dockview.css'), 'utf8'));
style.root.prepend(dockview.nodes);
style.root.walkRules(rule => {
 if (rule.parent?.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
 rule.selectors = rule.selectors.map(selector => `.fx-rhi-tool ${selector}`);
});
style.root.append(postcss.rule({selector:'.fx-rhi-tool > .rhi-viewer',nodes:[postcss.decl({prop:'height',value:'100%'})]}));
await writeFile(resolve(root, 'tools/view-plugins/rhi-debug/viewer.css'), style.root.toString());
const result = spawnSync('node', ['scripts/build-tool.mjs'], {
 cwd: view, stdio: 'inherit', env: { ...process.env,
 FORGEAX_VIEW_INPUT_ROOTS: JSON.stringify([resolve(root, 'tools/view-plugins'), resolve(root, 'apps/rhi-debug-viewer/src')]),
 FORGEAX_VIEW_PANELS_ENTRY: resolve(import.meta.dirname, 'panels.tsx'),
 FORGEAX_VIEW_FRONTEND_PLUGINS_ENTRY: resolve(import.meta.dirname, 'frontend-plugins.ts'),
 },
});
process.exit(result.status ?? 1);
