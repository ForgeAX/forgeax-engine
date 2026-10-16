import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stateProjectionAliases } from './state-projection-aliases.mjs';

const root = resolve(process.argv[2] ?? '.');
const output = resolve(process.argv[3] ?? 'artifacts/state-projection/browser');
const resultPath = resolve(output, 'result.json');
const consumer = resolve(import.meta.dirname, '../..');
const config = resolve(consumer, `.projection-browser-cost-${process.pid}.config.ts`);
// Explicit browser discovery must not enroll this carrier in concurrent unit runs.
const test = resolve(consumer, `packages/runtime/bench/.projection-cost-${process.pid}.cost.ts`);
const aliases = Object.entries(stateProjectionAliases(root))
  .sort(([a], [b]) => b.length - a.length)
  .map(([find, replacement]) => ({ find, replacement }));
mkdirSync(output, { recursive: true });
rmSync(resultPath, { force: true });
writeFileSync(
  test,
  readFileSync(resolve(consumer, 'packages/runtime/bench/state-projection.browser.ts')),
);
writeFileSync(
  config,
  `import { defineConfig } from 'vitest/config';
import { writeFileSync } from 'node:fs';
import { createBrowserProject } from './config/vitest-browser-project';
const project = createBrowserProject();
project.test.include = [${JSON.stringify(test)}];
project.cacheDir = ${JSON.stringify(resolve(output, 'vite-cache'))};
project.resolve = { ...project.resolve, alias: ${JSON.stringify(aliases)} };
project.test.browser.commands.writeStateProjectionCost = async (_context, result) => {
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result, null, 2) + '\\n');
};
export default defineConfig({ test: { projects: [project] } });
`,
);
try {
  let log = '';
  const child = spawn(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--project=browser', test],
    { cwd: consumer, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      log += chunk;
      writeFileSync(resolve(output, 'browser.log'), log);
    });
  const code = await new Promise((resolveExit, reject) => {
    child.on('error', reject);
    child.on('exit', resolveExit);
  });
  writeFileSync(resolve(output, 'browser.log'), log);
  if (code !== 0) throw new Error(`browser benchmark failed (${code}); see ${output}/browser.log`);
  if (!existsSync(resultPath)) throw new Error('browser benchmark omitted its result');
  console.log(`[projection-browser] ${resultPath}`);
} finally {
  rmSync(config, { force: true });
  rmSync(test, { force: true });
}
