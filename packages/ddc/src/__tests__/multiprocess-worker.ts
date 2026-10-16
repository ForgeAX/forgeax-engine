import { execFileSync, spawn } from 'node:child_process';

const bunWorkerArgvSentinel = '__forgeax_ddc_worker__';
const bunBootstrap = `
  // Bun 1.2 exposes its virtual -e entry as process.argv[1].
  if (process.argv[1]?.endsWith('[eval]')) {
    process.argv.splice(1, 1);
  }
  if (process.argv[1] === '${bunWorkerArgvSentinel}') {
    process.argv.splice(1, 1);
  }
  const load = (specifier) => import(specifier);
`;
const nodeBootstrap = `
  import jitiPackage from 'jiti';
  const createJiti = jitiPackage.createJiti ?? jitiPackage.default ?? jitiPackage;
  const jiti = createJiti(import.meta.url, { interopDefault: false });
  const load = (specifier) => jiti.import(specifier);
`;

function resolveBunExecutable(): string | undefined {
  const configuredRuntime = process.env.FORGEAX_DDC_WORKER_RUNTIME;
  if (configuredRuntime === 'node') return undefined;
  if (configuredRuntime && configuredRuntime !== 'bun') return configuredRuntime;
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore' });
    return 'bun';
  } catch {
    return undefined;
  }
}

export function spawnDdcWorker(source: string, args: string[]) {
  const bunExecutable = resolveBunExecutable();
  const runtime = bunExecutable ? bunBootstrap : nodeBootstrap;
  const command = bunExecutable ?? process.execPath;
  const commandArgs = bunExecutable
    ? ['-e', `${runtime}\n${source}`, bunWorkerArgvSentinel, ...args]
    : ['--input-type=module', '-e', `${runtime}\n${source}`, ...args];
  return spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
}
