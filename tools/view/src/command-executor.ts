import { workspaceDiagnosticRecord } from '@forgeax/view-workspace-core/command-error';
import type { ViewFrontendConfig } from '@forgeax/view-viewer/config';
type OwnerArgs = { root?: string };
type StartArgs = OwnerArgs & { frontendConfig?: Pick<ViewFrontendConfig, 'layout'> };
import { resolve } from 'node:path';
import { runViewProjectOpen } from './view-project-open.ts';
import { runViewStartInteractive, runViewStatus, runViewStop } from './view-start.ts';

const ownerEnv = (args: OwnerArgs) => ({ ...process.env, FORGEAX_PROJECT_ROOT: resolve(args.root ?? process.cwd()) });
const ownerArgv = (args: OwnerArgs) => ['--root', ownerEnv(args).FORGEAX_PROJECT_ROOT];
export async function start(args: StartArgs) {
  const argv = ownerArgv(args);
  return { ok: true, value: await runViewStartInteractive(argv, ownerEnv(args), args.frontendConfig) };
}

export async function status(args: OwnerArgs) {
  return { ok: true, value: await runViewStatus(ownerArgv(args), ownerEnv(args)) };
}

export async function stop(args: OwnerArgs) {
  return { ok: true, value: await runViewStop(ownerArgv(args), ownerEnv(args)) };
}

function commandError(error: unknown) {
  const failure = workspaceDiagnosticRecord(error);
  const nested = workspaceDiagnosticRecord(failure.detail);
  const wrapped = failure.code === 'tool-domain-failed' && failure.detail && typeof failure.detail === 'object'
    ? nested.code
    : undefined;
  let code = typeof wrapped === 'string' ? wrapped : failure.code;
  let hint = typeof failure.hint === 'string' ? failure.hint : (typeof failure.message === 'string' ? failure.message : String(error));
  let expected = typeof failure.expected === 'string' ? failure.expected : hint;
  let detail = failure.code === 'tool-domain-failed' ? nested.payload : failure.detail;
  if (code === 'tool-run-cancelled') {
    code = 'view-not-started';
    expected = 'View to keep running';
    hint = 'View has stopped. Run forgeax view start again when needed.';
    detail = undefined;
  }
  return {
    ok: false,
    error: {
      code: typeof code === 'string' ? code : 'view-project-open-failed',
      expected,
      hint,
      ...(detail === undefined ? {} : { detail }),
    },
  };
}

export async function projectOpen(args: OwnerArgs & { project?: string } = {}) {
  const argv = ['--root', resolve(args.root ?? process.cwd())];
  if (args.project !== undefined) argv.push('--project', String(args.project));
  try {
    const value = await runViewProjectOpen(argv, ownerEnv(args));
    return { ok: true, value };
  } catch (error) {
    return commandError(error);
  }
}
