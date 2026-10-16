#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const smoke = fileURLToPath(new URL('./smoke-browser.mjs', import.meta.url));

export const FALSIFICATION_VARIANTS = Object.freeze({
  'missing-derived-parent': Object.freeze({
    name: 'missing-derived-parent',
    description: 'remove the derived material parent before cooking',
    environment: 'FORGEAX_FALSIFY_MISSING_PARENT',
  }),
  'uv0-transform-loss': Object.freeze({
    name: 'uv0-transform-loss',
    description: 'force every texture slot to UV0 and ignore transforms',
    environment: 'FORGEAX_FALSIFY_UV0_TRANSFORM',
  }),
  'missing-normal-resource': Object.freeze({
    name: 'missing-normal-resource',
    description: 'remove the normal texture resource before material creation',
    environment: 'FORGEAX_FALSIFY_MISSING_NORMAL_RESOURCE',
  }),
  'swapped-normal-binding': Object.freeze({
    name: 'swapped-normal-binding',
    description: 'swap the base-color and normal texture resources',
    environment: 'FORGEAX_FALSIFY_SWAPPED_NORMAL_BINDING',
  }),
  'normal-slot-swap': Object.freeze({
    name: 'normal-slot-swap',
    description: 'replace only the normal texture resource with the base-color resource',
    environment: 'FORGEAX_FALSIFY_NORMAL_SLOT_SWAP',
  }),
});

export function falsificationEnvironment(variant) {
  const entry = FALSIFICATION_VARIANTS[variant];
  if (!entry) throw new Error(`unknown falsification variant: ${variant}`);
  return { [entry.environment]: '1' };
}

export async function runFalsificationVariant(variant) {
  const result = await execFileAsync(process.execPath, [smoke], {
    env: { ...process.env, ...falsificationEnvironment(variant) },
    cwd: fileURLToPath(new URL('../../../..', import.meta.url)),
    maxBuffer: 4 * 1024 * 1024,
  }).catch((error) => ({
    code: error.code ?? 1,
    stdout: error.stdout ?? '',
    stderr: error.stderr ?? String(error),
  }));
  return {
    variant,
    exitCode: typeof result.code === 'number' ? result.code : 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

export function assertFalsificationFailed(result) {
  if (result.exitCode === 0) {
    throw new Error(`falsification variant passed the original smoke: ${result.variant}`);
  }
  if (!result.output.includes(`FALSIFY_EXPECTED_FAILURE:${result.variant}`)) {
    throw new Error(`falsification variant lacks an attributed failure: ${result.variant}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const variant of Object.keys(FALSIFICATION_VARIANTS)) {
    const result = await runFalsificationVariant(variant);
    assertFalsificationFailed(result);
    console.log(`FALSIFY_EXPECTED_FAILURE:${variant}`);
  }
}
