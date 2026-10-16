import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { runBrowserCommand } from './run-browser-gate-with-retry.mjs';

const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');

function ownerDirectory(file) {
  let directory = path.dirname(file);
  while (!existsSync(path.join(directory, 'package.json'))) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`type test has no package owner: ${file}`);
    directory = parent;
  }
  return directory;
}

/** Compile the actual selected type files, including files excluded by build tsconfigs. */
export async function checkTypeTestProjects(context, filter) {
  const specifications = await context.globTestSpecifications(filter);
  const files = [
    ...new Set(
      specifications.filter((spec) => spec.pool === 'typescript').map((spec) => spec.moduleId),
    ),
  ].sort();
  if (files.length === 0) return context.start(filter);
  const owners = new Map();
  for (const file of files) {
    const owner = ownerDirectory(file);
    const selected = owners.get(owner) ?? [];
    selected.push(file);
    owners.set(owner, selected);
  }
  // One compiler process at a time preserves package-specific ambient types,
  // bounds memory, and avoids checking a file twice through the root project.
  for (const [owner, selected] of owners) {
    const configPath = path.join(owner, 'tsconfig.json');
    const config = ts.getParsedCommandLineOfConfigFile(
      configPath,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        },
      },
    );
    if (!config || config.errors.length) {
      throw new Error(`invalid type-test owner config: ${configPath}`);
    }
    const temporary = mkdtempSync(path.join(owner, '.forgeax-typecheck-'));
    try {
      const configFile = path.join(temporary, 'tsconfig.json');
      writeFileSync(
        configFile,
        JSON.stringify({
          extends: configPath,
          compilerOptions: {
            composite: false,
            incremental: true,
            noEmit: true,
            rootDir: context.config.root,
            tsBuildInfoFile: path.join(temporary, '.tsbuildinfo'),
          },
          // The build already checks the package's ordinary source roots.
          // Type tests need their actual imports plus the owner's ambient types,
          // not another full compilation of unrelated source and runtime tests.
          files: [
            ...new Set([
              ...config.fileNames.filter((file) => /\.d\.[cm]?ts$/.test(file)),
              ...selected,
            ]),
          ],
          include: [],
          exclude: [],
          references: config.projectReferences?.map((reference) => ({ path: reference.path })),
        }),
      );
      const label = path.relative(context.config.root, owner) || '.';
      process.stdout.write(
        `[typecheck] ${label}: ${selected.map((file) => path.relative(owner, file)).join(', ')}\n`,
      );
      const result = await runBrowserCommand(
        [process.execPath, tsc, '-p', configFile, '--pretty', 'false'],
        {
          cwd: owner,
          timeoutMs: 60_000,
          label: `typecheck:${label}`,
        },
      );
      if (result.status !== 0) {
        throw Object.assign(new Error(`TypeCheckError: ${label}`), {
          exitCode: result.cancelled || result.timedOut ? result.status : 1,
        });
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  process.stdout.write(`[typecheck] passed: files=${files.length}, owners=${owners.size}\n`);
}
