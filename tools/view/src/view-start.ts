import { resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import type { ViewFrontendConfig } from '@forgeax/view-viewer/config';

const projectPath = (value: string) => {
  const absolute = resolve(value);
  // Match Engine's native realpath identity, including Windows short-path aliases.
  return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
};

export function resolveProjectRoot(argv: readonly string[] = [], env = process.env) {
  const index = argv.indexOf('--root');
  if (index >= 0 && (!argv[index + 1] || argv[index + 1].startsWith('--'))) {
    throw new TypeError('--root requires a backend workspace directory');
  }
  return resolve(index < 0 ? env.FORGEAX_PROJECT_ROOT ?? process.cwd() : argv[index + 1]);
}

export function resolveProjectIntent(argv: readonly string[] = [], backendRoot?: string) {
  const index = argv.indexOf('--project');
  if (index < 0) return backendRoot && existsSync(resolve(backendRoot, 'forge.json')) ? projectPath(backendRoot) : undefined;
  const value = argv[index + 1];
  if (!value?.trim() || value.startsWith('--')) throw new TypeError('--project requires a project directory');
  return projectPath(value);
}

export function withProjectIntent(status: unknown, project?: string) {
  if (!project || !status || typeof status !== 'object' || !('url' in status) || typeof status.url !== 'string' || !status.url) return status;
  const url = new URL(status.url);
  url.searchParams.set('project', project);
  return { ...status, url: url.href };
}

async function call(operation: string, argv: readonly string[], env: NodeJS.ProcessEnv, frontendConfig?: Pick<ViewFrontendConfig, 'layout'>) {
  if (argv.some(arg => ['--headless', '--software', '--serve'].includes(arg))) {
    throw new TypeError('View startup does not launch a browser. Open the returned URL in your browser; configure Engine runs separately.');
  }
  const { callDevKitBackend } = await import('@forgeax/engine/devkit');
  if (!callDevKitBackend) throw new Error('Install the matching Engine SDK with the independent backend capability.');
  return callDevKitBackend(resolveProjectRoot(argv, env), operation,
    frontendConfig === undefined ? {} : { frontendConfig });
}

export async function runViewStartInteractive(argv: readonly string[] = [], env = process.env, frontendConfig?: Pick<ViewFrontendConfig, 'layout'>) {
  const backendRoot = resolveProjectRoot(argv, env);
  const project = resolveProjectIntent(argv, backendRoot);
  return withProjectIntent(await call('view.start', argv, env, frontendConfig), project);
}
export const runViewStatus = (argv: readonly string[] = [], env = process.env) => call('view.status', argv, env);
export const runViewStop = (argv: readonly string[] = [], env = process.env) => call('view.stop', argv, env);
