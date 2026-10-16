import { mkdir, mkdtemp, copyFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const uiRoot = resolve(import.meta.dirname, '..');
const root = resolve(uiRoot, '../..');
await mkdir(join(uiRoot, '.forgeax'), { recursive: true });
const temporary = await mkdtemp(join(uiRoot, '.forgeax/localization-types-'));
try {
  await copyFile(join(root, 'templates/game-3d/assets/guide.ui.i18n.json'), join(temporary, 'messages.json'));
  await writeFile(join(temporary, 'keys.ts'), `import messages from './messages.json';
import { createUiLocalization } from '@forgeax/engine-ui/localization';
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'guide';
    resources: typeof messages.resources.en;
    strictKeyChecks: true;
  }
}
async function verify() {
  const opened = await createUiLocalization({ guid: 'typed', html: '', css: '', localization: messages }, { lng: 'en' });
  if (!opened.ok) throw opened.error;
  opened.value.t('title');
  // @ts-expect-error: keys derive from the authored JSON, no duplicate union
  opened.value.t('not-a-game-key');
}
void verify;
`);
  await writeFile(join(temporary, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
    resolveJsonModule: true, skipLibCheck: true, noEmit: true,
  }, include: ['keys.ts', 'messages.json'] }));
  const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(temporary, 'tsconfig.json')], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`authored JSON key type gate failed: ${result.status}`);
  console.log('authored JSON key type gate: PASS');
} finally { await rm(temporary, { recursive: true, force: true }); }
