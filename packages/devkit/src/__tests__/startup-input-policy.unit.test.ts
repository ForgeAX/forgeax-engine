import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

async function generatedStartup(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-startup-input-policy-'));
  try {
    await mkdir(resolve(root, 'assets'));
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        id: 'input-policy-game',
        name: 'Input Policy Game',
        schemaVersion: '3.0.0',
        roots: {},
      }),
    );
    await writeFile(resolve(root, 'package.json'), '{"name":"input-policy-game"}\n');
    await writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n');
    const facts = await readProjectFacts(root);
    expect(facts.ok).toBe(true);
    if (!facts.ok) return '';
    await createViteConfig(facts.value, 'build');
    return await readFile(resolve(root, '.forgeax/generated/main.ts'), 'utf8');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

interface StartupErrorProbe {
  readonly listener: (error: unknown) => void;
  readonly fail: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly executionReport: { fault: { code: string } | null };
}

/** Execute the emitted, self-contained startup onError consumer. */
function startupErrorProbe(generated: string): StartupErrorProbe | undefined {
  // The renderer-error tracker registers its own onError listener; pick the startup one.
  const callback = [...generated.matchAll(/app\.onError\(((\(error\) => \{[\s\S]*?\n\s*\}))\);/g)]
    .map((match) => match[1])
    .find((source) => source?.includes('app-pointer-lock-failed'));
  expect(callback).toBeDefined();
  if (callback === undefined) return undefined;
  const fail = vi.fn();
  const warn = vi.fn();
  const executionReport: StartupErrorProbe['executionReport'] = { fault: null };
  const sourceHelper = generated.match(/function rendererErrorSource\(error\) \{[\s\S]*?\n\}/)?.[0];
  expect(sourceHelper).toBeDefined();
  const listener = runInNewContext(`${sourceHelper}\n(${callback})`, {
    app: { execution: { report: () => executionReport } },
    startup: { fail },
    console: { warn },
  }) as (error: unknown) => void;
  return { listener, fail, warn, executionReport };
}

describe('generated startup input admission', () => {
  it('keeps the game running when the browser refuses a pointer lock', async () => {
    const probe = startupErrorProbe(await generatedStartup());
    if (probe === undefined) return;
    const { listener, fail, warn, executionReport } = probe;
    const refused = { code: 'app-pointer-lock-failed' };
    listener(refused);
    expect(fail).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(refused);
    const fatal = { code: 'app-system-update-failed' };
    executionReport.fault = fatal;
    listener(fatal);
    expect(fail).toHaveBeenCalledWith(fatal, executionReport);
  });

  it('keeps the game running when an optional RenderFeature lacks a device capability', async () => {
    const probe = startupErrorProbe(await generatedStartup());
    if (probe === undefined) return;
    const { listener, fail, warn } = probe;
    // The Render Worker shape: App wraps the renderer event, which wraps the
    // host's disabled-slot error; the innermost coded cause decides.
    const disabled = {
      code: 'app-system-update-failed',
      detail: {
        cause: {
          code: 'device-operation-failed',
          detail: {
            operation: 'renderer-event',
            cause: {
              code: 'render-feature-capability-missing',
              detail: {
                featureIdentity: 'forgeax.vfx-render.gpu-particles',
                capability: 'compute',
              },
            },
          },
        },
      },
    };
    listener(disabled);
    expect(fail).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(disabled);
    // A different nested renderer failure still stops startup.
    const lost = {
      code: 'app-system-update-failed',
      detail: {
        cause: { code: 'device-operation-failed', detail: { cause: { code: 'device-lost' } } },
      },
    };
    listener(lost);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail.mock.calls[0]?.[0]).toBe(lost);
  });

  it.each([
    false,
    true,
  ])('preserves the game pointer-lock policy %s across readiness', async (policy) => {
    const generated = await generatedStartup();
    // Execute the emitted consumer callback, rather than restating its logic.
    const callback = generated.match(
      /startup\?\.bindInput\?\.\((\(enabled\) => \{[\s\S]*?\n\s*\})\);/,
    )?.[1];
    expect(callback).toBeDefined();
    if (callback === undefined) return;
    let inputAllowed = true,
      pointerLockAllowed = true;
    const clear = vi.fn();
    const input = {
      setInputAllowed: (value: boolean) => {
        inputAllowed = value;
      },
      setPointerLockAllowed: (value: boolean) => {
        pointerLockAllowed = value;
      },
      clear,
    };
    const admit = runInNewContext(`(${callback})`, { app: { input } }) as (
      enabled: boolean,
    ) => void;
    admit(false);
    // The game applies while startup is still waiting for its first presentation.
    input.setPointerLockAllowed(policy);
    admit(true);
    expect(inputAllowed).toBe(true);
    expect(pointerLockAllowed).toBe(policy);
    // A later loading/failure boundary closes input without rewriting author policy.
    admit(false);
    expect(inputAllowed).toBe(false);
    expect(pointerLockAllowed).toBe(policy);
    expect(clear).toHaveBeenCalledTimes(2);
    admit(true);
    expect(inputAllowed).toBe(true);
    expect(pointerLockAllowed).toBe(policy);
  });
});
