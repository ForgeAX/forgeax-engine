import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspaceTimingPrefixes = [
  '[forgeax.workspace.timing]',
  '[forgeax.vite-config.timing]',
  '[forgeax.pack-startup.timing]',
  '[forgeax.authored-pack.timing]',
  '[forgeax.pack-commit.timing]',
];

export function streamViewBackendTimings(file, afterLine = 0, write = console.error) {
  const lines = readFileSync(file, 'utf8').split('\n');
  // Leave an incomplete final line for the next snapshot of the daemon log.
  const completeLines = lines.length - 1;
  for (let index = afterLine; index < completeLines; index++) {
    const line = lines[index];
    if (workspaceTimingPrefixes.some((prefix) => line.includes(prefix))) write(line);
  }
  return completeLines;
}

export function collectViewBackendDiagnostics({
  probePid,
  startedAt,
  outputDirectory,
  backendDirectory = join(tmpdir(), 'forgeax-backend'),
}) {
  if (!Number.isSafeInteger(probePid) || probePid <= 0) return [];
  let directories;
  try {
    directories = readdirSync(backendDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    let log;
    try {
      log = readFileSync(join(backendDirectory, directory.name, 'backend.log'), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EACCES') continue;
      throw error;
    }
    const owner = log.split('\n').find((line) => {
      if (!line.startsWith('{')) return false;
      try {
        const record = JSON.parse(line);
        return (
          record.scope === 'backend-startup' &&
          record.stage === 'daemon-spawn' &&
          record.event === 'spawned' &&
          record.hostPid === probePid &&
          Date.parse(record.time) >= startedAt
        );
      } catch {
        return false;
      }
    });
    if (owner === undefined) continue;
    // The daemon owns this log after its probe exits. Never collect session.json;
    // redact transport credentials if a native error contains its request URL.
    const redacted = log
      .replace(/([?&](?:token|frontendTicket|forgeaxWorkspaceToken)=)[^&\s"'<>]+/g, '$1[redacted]')
      .replace(/("(?:token|frontendTicket|forgeaxWorkspaceToken)"\s*:\s*")[^"]*/g, '$1[redacted]');
    mkdirSync(outputDirectory, { recursive: true });
    const file = join(outputDirectory, `${directory.name}.log`);
    writeFileSync(file, redacted, { mode: 0o600 });
    files.push(file);
  }
  return files;
}
