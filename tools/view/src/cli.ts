#!/usr/bin/env node

import { workspaceDiagnosticRecord } from '@forgeax/view-workspace-core/command-error';

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { connectViewWorkspace } from '@forgeax/view-workspace-core/resident';
import { VIEW_WORKSPACE_OPERATIONS } from '@forgeax/view-workspace-core/contract';

const HELP = `forgeax-view workspace

Call the View workspace API through the resident Engine Host.

Usage:
  forgeax-view workspace --operation <operation> [--args <json>] [options]
  forgeax-view workspace --batch <json-array> [options]

Operations:
  ${VIEW_WORKSPACE_OPERATIONS.join(', ')}

Connection options:
  --endpoint <ws-url>   or FORGEAX_VIEW_WORKSPACE_ENDPOINT
  --token <token>       or FORGEAX_VIEW_WORKSPACE_TOKEN
  --client-id <id>      or FORGEAX_VIEW_CLIENT_ID (default: unique per process)
  --follow              keep plugins.watch subscribed until disconnect or abort

The JSON passed to --args is sent unchanged to the Engine-owned API. This
command does not implement project, asset, scene, or camera behavior locally.
Use --batch to keep one authenticated client connection for a camera
begin/update/commit transaction. Inspector watch requires --follow so the
authenticated subscription remains alive after the watch response.
`;

const OPERATIONS = new Set<string>(VIEW_WORKSPACE_OPERATIONS);

function valueAfter(argv: readonly string[], index: number, flag: string) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

type CliCall = { operation: string; args: Record<string, unknown> };
type CliArguments = { help: true } | ({ endpoint: string; token: string; clientId: string; follow: boolean } & (CliCall | { batch: CliCall[] }));
function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliArguments {
  let endpoint = env.FORGEAX_VIEW_WORKSPACE_ENDPOINT;
  let token = env.FORGEAX_VIEW_WORKSPACE_TOKEN;
  let clientId = env.FORGEAX_VIEW_CLIENT_ID;
  let operation: string | undefined;
  let input = '{}';
  let inputSeen = false;
  let batchInput: string | undefined;
  let follow = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === '--endpoint') {
      endpoint = valueAfter(argv, index, flag);
      index += 1;
    } else if (flag === '--token') {
      token = valueAfter(argv, index, flag);
      index += 1;
    } else if (flag === '--client-id') {
      clientId = valueAfter(argv, index, flag);
      index += 1;
    } else if (flag === '--operation') {
      operation = valueAfter(argv, index, flag);
      index += 1;
    } else if (flag === '--args') {
      input = valueAfter(argv, index, flag);
      inputSeen = true;
      index += 1;
    } else if (flag === '--batch') {
      batchInput = valueAfter(argv, index, flag);
      index += 1;
    } else if (flag === '--follow') {
      follow = true;
    } else if (flag === 'workspace' || flag === 'call') {
      // Keep the command prefix explicit but allow the operation to be the
      // first positional for a short shell form.
    } else if (operation === undefined && !flag.startsWith('--')) {
      operation = flag;
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  if (batchInput !== undefined && (operation !== undefined || inputSeen))
    throw new Error('--operation/--args cannot be combined with --batch');
  if (operation === undefined && batchInput === undefined) throw new Error('workspace operation is required');
  if (follow && (batchInput !== undefined || operation !== 'plugins.watch')) {
    throw new Error('--follow is only supported for plugins.watch');
  }
  if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    throw new Error('View workspace endpoint is required (--endpoint or FORGEAX_VIEW_WORKSPACE_ENDPOINT)');
  }
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error('View workspace token is required (--token or FORGEAX_VIEW_WORKSPACE_TOKEN)');
  }
  const parseObject = (raw: string, flag: string) => {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`${flag} must be valid JSON`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${flag} must be a JSON object`);
    }
    return value as Record<string, unknown>;
  };
  const parseOperation = (candidate: unknown) => {
    if (typeof candidate !== 'string' || !OPERATIONS.has(candidate)) {
      throw new Error(`unsupported workspace operation ${candidate}`);
    }
    return candidate;
  };
  if (operation === 'plugins.watch' && !follow && batchInput === undefined) {
    throw new Error('plugins.watch requires --follow to keep the subscription alive');
  }
  const client = clientId ?? `forgeax-cli-${randomUUID()}`;
  if (batchInput !== undefined) {
    let batch: unknown;
    try {
      batch = JSON.parse(batchInput);
    } catch {
      throw new Error('--batch must be valid JSON');
    }
    if (!Array.isArray(batch) || batch.length === 0) throw new Error('--batch must be a non-empty JSON array');
    const calls = batch.map((entry, index) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`--batch item ${index} must be an object`);
      }
      return {
        operation: parseOperation(entry.operation),
        args: entry.args === undefined ? {} : parseObject(JSON.stringify(entry.args), `--batch item ${index}.args`),
      };
    });
    return { endpoint, token, clientId: client, batch: calls, follow: false };
  }
  return {
    endpoint,
    token,
    clientId: client,
    operation: parseOperation(operation),
    args: parseObject(input, '--args'),
    follow,
  };
}

function resultError(error: unknown) {
  const failure = workspaceDiagnosticRecord(error);
  return {
    ok: false,
    error: {
      code: typeof failure.code === 'string' ? failure.code : 'view-cli-failed',
      ...(typeof failure.expected === 'string' ? { expected: failure.expected } : {}),
      hint: typeof failure.hint === 'string' ? failure.hint : typeof failure.message === 'string' ? failure.message : String(error),
      ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    },
  };
}

/** Execute one thin CLI request; all domain semantics stay in View/Engine API. */
export async function runViewWorkspaceCli(argv: readonly string[], { connect = connectViewWorkspace, signal }: { connect?: typeof connectViewWorkspace; signal?: AbortSignal } = {}) {
  let options;
  try {
    options = parseArgs(argv);
    if ('help' in options) return { exitCode: 0, value: HELP };
    const client = await connect({
      endpoint: options.endpoint,
      token: options.token,
      clientId: options.clientId,
    });
    try {
      let value: unknown;
      if (!('batch' in options)) {
        value = await client.call(options.operation, options.args, { signal });
      } else {
        const values: unknown[] = [];
        for (const call of options.batch)
          values.push(await client.call(call.operation, call.args, { signal }));
        value = values;
      }
      if (options.follow) {
        const events: unknown[] = [];
        const unsubscribe = client.subscribeInspector?.((event) => events.push(event));
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          const onAbort = () => {
            signal?.removeEventListener('abort', onAbort);
            removeDisconnect?.();
            resolve();
          };
          const removeDisconnect = client.onDisconnect?.(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          });
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        unsubscribe?.();
        return { exitCode: 0, value: { ok: true, value, events } };
      }
      return { exitCode: 0, value: { ok: true, value } };
    } finally {
      client.close?.('view CLI request complete');
    }
  } catch (error) {
    return { exitCode: 1, value: resultError(error) };
  }
}

function isDirectInvocation() {
  if (process.argv[1] === undefined) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(modulePath);
  } catch {
    return process.argv[1] === modulePath;
  }
}

if (isDirectInvocation()) {
  const result = await runViewWorkspaceCli(process.argv.slice(2));
  if (typeof result.value === 'string') process.stdout.write(result.value);
  else process.stdout.write(`${JSON.stringify(result.value, null, result.value?.ok ? 0 : 2)}\n`);
  process.exitCode = result.exitCode;
}
