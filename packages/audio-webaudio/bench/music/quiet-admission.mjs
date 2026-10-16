import { cpus, loadavg } from 'node:os';
import { execFileSync } from 'node:child_process';

const swapUnits = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
export function preparationProcess(command) {
  const executable = command.split(/\s+/)[0];
  // Terminal launch environments can retain a .cargo PATH after work ends.
  // Scan their real children; total OS CPU and load still include the service.
  const heavy = /(?:^|\/)tmux$/.test(executable) ? undefined : command.match(/(?:scripts\/(?:build[^\s]*|typecheck[^\s]*|forgeax\/(?:prepare-shader[^\s]*|(?:build|verify|check)-sdk[^\s]*)|ci\/(?:run[^\s]*|build[^\s]*)|smoke[^\s]*)|bench\/[^\s]+\/(?:prepare|run)\.[cm]?[jt]s|typescript\/(?:bin\/tsc|lib\/(?:tsc|_tsc)\.js)|\b(?:rustc|cargo|ninja|clang|vitest|tsc)\b|\b(?:pnpm|bun)\s+(?:[^\s]+\s+)?(?:build|test|typecheck)[^\s]*)/);
  return { executable, heavy: heavy?.[0] };
}
export function quietSnapshot() {
  const memory = execFileSync('sysctl', ['kern.memorystatus_vm_pressure_level', 'vm.swapusage'], { encoding: 'utf8' });
  const pressure = Number(memory.match(/kern\.memorystatus_vm_pressure_level: (\d+)/)?.[1]);
  const swap = memory.match(/used = ([\d.]+)([KMG])/);
  if (!swap || !Number.isFinite(pressure)) throw new Error('native memory admission facts unavailable');
  const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,command='], { encoding: 'utf8' })
    .trim().split('\n').flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
      if (!match) return [];
      const [, pid, parent, cpu, rss, command] = match;
      // Do not record arbitrary process arguments, including possible credentials.
      return [{ pid: Number(pid), parent: Number(parent), cpu: Number(cpu), rssKiB: Number(rss),
        ...preparationProcess(command) }];
    });
  const own = new Set([process.pid]);
  // The maintained bounded entry owns this direct child and its lease holder.
  // Its argv includes the prepared probe, so counting it as foreign would
  // reject a quiet slot merely because the owner moved outside this module.
  if (process.env.FORGEAX_LOCAL_GPU_LEASE_HELD === '1') own.add(process.ppid);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of processes) if (own.has(row.parent) && !own.has(row.pid)) { own.add(row.pid); changed = true; }
  }
  return { time: new Date().toISOString(), ticks: cpus().map(cpu => cpu.times), load: loadavg(), pressure,
    swapUsedBytes: Number(swap[1]) * swapUnits[swap[2]], processes,
    competingHeavy: processes.filter(row => row.heavy && !own.has(row.pid)) };
}
function busy(before, after) {
  const sum = ticks => ticks.reduce((total, row) => total + Object.values(row).reduce((value, tick) => value + tick, 0), 0);
  const total = sum(after.ticks) - sum(before.ticks);
  const idle = after.ticks.reduce((value, row, index) => value + row.idle - before.ticks[index].idle, 0);
  if (!(total > 0)) throw new Error('native CPU admission interval unavailable');
  return 100 * (total - idle) / total;
}
export async function quietPreflight(retain) {
  const snapshots = [quietSnapshot()];
  for (let index = 0; index < 12; index++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    snapshots.push(quietSnapshot());
  }
  const intervals = snapshots.slice(1).map((row, index) => ({
    busyPercent: busy(snapshots[index], row), load1: row.load[0], pressure: row.pressure,
    swapGrowthBytes: row.swapUsedBytes - snapshots[index].swapUsedBytes,
    competingHeavy: row.competingHeavy,
  }));
  const pass = snapshots.every(row => row.pressure === 1 && row.load[0] <= 3 && row.competingHeavy.length === 0)
    && intervals.every(row => row.busyPercent <= 20 && row.swapGrowthBytes <= 0);
  const result = { seconds: 60, pass, snapshots, intervals };
  await retain(result);
  if (!pass) throw new Error('frozen quiet admission failed; no performance probe started');
  return result;
}
