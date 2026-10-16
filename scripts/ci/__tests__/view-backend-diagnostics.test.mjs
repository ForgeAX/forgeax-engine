import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectViewBackendDiagnostics } from '../view-backend-diagnostics.mjs';

test('retains the failed probe daemon stderr without unrelated sessions or credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'view-backend-diagnostics-'));
  const backendDirectory = join(root, 'backends');
  const outputDirectory = join(root, 'evidence');
  mkdirSync(backendDirectory);
  const probe = join(root, 'probe.mjs');
  writeFileSync(
    probe,
    `import { spawnSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeSync } from 'node:fs';
import { join } from 'node:path';
const directory = join(process.argv[2], 'owned');
mkdirSync(directory);
const log = openSync(join(directory, 'backend.log'), 'w');
const child = spawnSync(process.execPath, ['-e', 'console.error("Error: actual daemon stopped; ws://localhost/?token=secret&frontendTicket=ticket&forgeaxWorkspaceToken=workspace-secret"); process.exit(23)'], { stdio: ['ignore', log, log] });
writeSync(log, JSON.stringify({ scope: 'backend-startup', stage: 'daemon-spawn', event: 'spawned', hostPid: process.pid, childPid: child.pid, time: new Date().toISOString() }) + '\\n');
closeSync(log);
process.exit(17);
`,
  );
  try {
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [probe, backendDirectory]);
    assert.equal(result.status, 17);
    for (const [name, hostPid, time] of [
      ['unrelated', result.pid + 1, startedAt],
      ['reused-pid', result.pid, startedAt - 60_000],
    ]) {
      mkdirSync(join(backendDirectory, name));
      writeFileSync(
        join(backendDirectory, name, 'backend.log'),
        `${JSON.stringify({ scope: 'backend-startup', stage: 'daemon-spawn', event: 'spawned', hostPid, childPid: 1, time: new Date(time).toISOString() })}\nUNRELATED\n`,
      );
    }
    writeFileSync(join(backendDirectory, 'owned', 'session.json'), '{"token":"PRIVATE"}');
    const files = collectViewBackendDiagnostics({
      probePid: result.pid,
      startedAt,
      backendDirectory,
      outputDirectory,
    });
    assert.equal(files.length, 1);
    const evidence = readFileSync(files[0], 'utf8');
    assert.match(evidence, /Error: actual daemon stopped/);
    assert.match(
      evidence,
      /token=\[redacted\]&frontendTicket=\[redacted\]&forgeaxWorkspaceToken=\[redacted\]/,
    );
    assert.doesNotMatch(evidence, /secret|ticket|PRIVATE|UNRELATED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
