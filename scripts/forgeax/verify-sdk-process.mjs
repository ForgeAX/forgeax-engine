import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { collectViewBackendDiagnostics } from '../ci/view-backend-diagnostics.mjs';

const execute = promisify(execFile);

function findCorepackEntrypoint(execPath, env) {
  const directories = [dirname(execPath), ...(env.PATH ?? env.Path ?? '').split(delimiter)];
  const roots = new Set();
  for (const directory of directories.filter(Boolean)) {
    roots.add(resolve(directory, 'node_modules', 'corepack'));
    roots.add(resolve(directory, '..', 'node_modules', 'corepack'));
    roots.add(resolve(directory, '..', 'corepack'));
  }
  for (const root of roots) {
    try {
      const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
      const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.corepack;
      if (manifest.name === 'corepack' && typeof entry === 'string') {
        const path = resolve(root, entry);
        if (existsSync(path)) return path;
      }
    } catch {}
  }
  return undefined;
}

export function createSdkVerifierProcess(packageManager, runtime = {}) {
  const platform = runtime.platform ?? process.platform;
  const execPath = runtime.execPath ?? process.execPath;
  const env = runtime.env ?? process.env;
  const getPackageManager =
    typeof packageManager === 'function' ? packageManager : () => packageManager;
  let corepackEntrypoint;
  const resolveCommand = (file, args) => {
    if (platform !== 'win32' || (file !== 'corepack' && file !== 'pnpm')) return [file, args];
    const actualArgs = file === 'pnpm' ? [getPackageManager(), ...args] : args;
    if (file === 'pnpm' && !String(actualArgs[0]).startsWith('pnpm@'))
      throw new Error('sdk-source-package-manager');
    if (corepackEntrypoint === undefined)
      corepackEntrypoint = findCorepackEntrypoint(execPath, env) ?? null;
    return corepackEntrypoint
      ? [execPath, [corepackEntrypoint, ...actualArgs]]
      : ['corepack', actualArgs];
  };
  return {
    execFileAsync(file, args, { streamOutput = false, backendEvidenceDirectory, ...options } = {}) {
      const [command, commandArgs] = resolveCommand(file, args);
      const startedAt = Date.now();
      const pending = execute(command, commandArgs, options);
      if (streamOutput) {
        // Keep long source-build progress visible while reserving stdout for the final report.
        pending.child.stdout.on('data', (chunk) => process.stderr.write(chunk));
        pending.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
      }
      if (backendEvidenceDirectory === undefined) return pending;
      const observed = pending.catch((error) => {
        try {
          collectViewBackendDiagnostics({
            probePid: pending.child.pid,
            startedAt,
            outputDirectory: backendEvidenceDirectory,
          });
        } catch (cause) {
          console.error('[sdk View backend evidence]', String(cause));
        }
        throw error;
      });
      observed.child = pending.child;
      return observed;
    },
    spawn(file, args, options) {
      const [command, commandArgs] = resolveCommand(file, args);
      return spawn(command, commandArgs, options);
    },
  };
}

/** Read through the installed candidate's public exports, never the verifier checkout. */
export async function readSdkProjectDocument(execFileAsync, project, path, kind = 'json') {
  if (kind !== 'json' && kind !== 'catalog' && kind !== 'direct-pack')
    throw new Error(`sdk-project-document-kind:${kind}`);
  const readDocument = `
    import { readFile } from 'node:fs/promises';
    import { decodeDocumentText } from '@forgeax/engine/codec';
    const text = await decodeDocumentText(await readFile(process.argv[1]));
    if (!text.ok) throw new Error(text.error.code);
    let value = JSON.parse(text.value);
    if (process.argv[2] === 'catalog') {
      const { decodeCatalogWire } = await import('@forgeax/engine/pack');
      value = decodeCatalogWire(value).unwrap();
    } else if (process.argv[2] === 'direct-pack') {
      const { parsePackSourceJson, projectDirectPackJson } = await import('@forgeax/engine/pack/source');
      const pack = parsePackSourceJson(value).unwrap();
      if (pack.format !== 'direct') throw new Error('sdk-project-document-not-direct-pack');
      value = projectDirectPackJson(pack);
    }
    console.log(JSON.stringify(value));
  `;
  const documentRead = await execFileAsync(
    process.execPath,
    ['--input-type=module', '--eval', readDocument, path, kind],
    { cwd: project },
  );
  return JSON.parse(documentRead.stdout);
}
