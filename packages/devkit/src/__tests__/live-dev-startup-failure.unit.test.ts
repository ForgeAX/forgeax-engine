import { afterEach, expect, it, vi } from 'vitest';

const startup = vi.hoisted(() => ({ error: undefined as unknown }));
vi.mock('../project.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../project.js')>()),
  readProjectFacts: async () => ({ ok: true, value: {} }),
}));
vi.mock('../host.js', () => ({
  startDevProjectWithHost: async () => ({ ok: false, error: startup.error }),
}));

const { runLiveProjectProcess } = await import('../live-dev.js');

async function terminalLine(error: unknown): Promise<{ readonly error: string }> {
  startup.error = error;
  const stdout: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await runLiveProjectProcess('/project', '2');
  process.exitCode = undefined;
  return JSON.parse(stdout.join('').trim().split('\n').at(-1) ?? '{}');
}

afterEach(() => {
  vi.restoreAllMocks();
});

it('names the innermost structured cause instead of only the wrapper code', async () => {
  const line = await terminalLine({
    code: 'produce-failed',
    expected: 'the production task completes with a validated product',
    hint: 'inspect the source, repair the producer, rebuild, verify, and retry',
    detail: { stage: 'produce', subject: '/project/assets' },
    cause: {
      code: 'pack-source-key-invalid',
      expected: 'a sourceKey of "/"-separated lower-case segments',
      hint: 'use kebab-case: "material/rock-light"',
      detail: {
        sourcePath: '/project/assets/rocks.pack.ts',
        sourceKey: 'material/rockLight',
        suggestedSourceKey: 'material/rock-light',
      },
    },
  });
  expect(line.error).toBe(
    'produce-failed <- pack-source-key-invalid: expected a sourceKey of "/"-separated lower-case segments; hint: use kebab-case: "material/rock-light"; detail: {"sourcePath":"/project/assets/rocks.pack.ts","sourceKey":"material/rockLight","suggestedSourceKey":"material/rock-light"}; inspect /project/.forgeax/dev.log',
  );
});

it('keeps the code and hint form when there is no structured cause', async () => {
  const line = await terminalLine({
    code: 'dev-server-failed',
    expected: 'the ForgeaX command to complete',
    hint: 'Inspect the underlying diagnostic and repair the owning input.',
    detail: { reason: 'boom' },
  });
  expect(line.error).toBe(
    'dev-server-failed: Inspect the underlying diagnostic and repair the owning input.; inspect /project/.forgeax/dev.log',
  );
});
