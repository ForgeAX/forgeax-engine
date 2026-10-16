import { cpSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runUnifiedCli } from '@forgeax/engine/devkit';

export interface CliError {
  readonly code?: string;
  readonly expected?: string;
  readonly hint?: string;
  readonly detail?: Record<string, unknown>;
}

export interface CliEnvelope {
  readonly ok?: boolean;
  readonly command?: string;
  readonly value?: Record<string, unknown>;
  readonly error?: CliError;
}

export async function forgeax(args: readonly string[]): Promise<CliEnvelope> {
  return (await runUnifiedCli([...args, '--json'])) as CliEnvelope;
}

export function code(envelope: CliEnvelope): string {
  return envelope.ok === true ? 'ok' : (envelope.error?.code ?? 'no-code');
}

const TEMPLATE = resolve(import.meta.dirname, '../../../../../../templates/empty');

export interface ProjectFixture {
  readonly root: string;
  readonly dispose: () => void;
}

export function emptyProject(): ProjectFixture {
  const parent = mkdtempSync(join(tmpdir(), 'fl-cli-'));
  const root = join(parent, 'game');
  cpSync(TEMPLATE, root, {
    recursive: true,
    filter: (source) => !source.includes('node_modules'),
  });
  symlinkSync(realpathSync(join(TEMPLATE, 'node_modules')), join(root, 'node_modules'), 'dir');
  return { root, dispose: () => rmSync(parent, { recursive: true, force: true }) };
}
