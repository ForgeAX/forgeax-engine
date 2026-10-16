#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = process.argv[2];
if (!root || process.argv.length > 3) {
  console.error('Usage: node scripts/workspace-timing-report.mjs <backend-root>');
  process.exitCode = 2;
} else {
  const key = createHash('sha256').update(resolve(root)).digest('hex');
  const logPath = join(tmpdir(), 'forgeax-backend', key, 'backend.log');
  const prefix = '[forgeax.workspace.timing] ';
  const stages = [
    'project-facts',
    'backend-bound',
    'vite-config',
    'vite-server-created',
    'vite-listening',
    'catalog-ready',
    'target-url-published',
    'browser-ready',
  ];
  try {
    const sessions = new Map();
    for (const line of readFileSync(logPath, 'utf8').split('\n')) {
      const start = line.indexOf(prefix);
      if (start < 0) continue;
      let event;
      try {
        event = JSON.parse(line.slice(start + prefix.length));
      } catch {
        continue;
      }
      if (event.root !== resolve(root) || typeof event.sessionId !== 'string') continue;
      const session = sessions.get(event.sessionId) ?? {
        targetId: event.targetId,
        timings: new Map(),
      };
      if (stages.includes(event.stage)) {
        session.timings.set(event.stage, event.stageMs);
        if (event.stage === 'browser-ready') session.totalMs = event.totalMs;
      }
      sessions.set(event.sessionId, session);
    }
    const completed = [...sessions.values()].filter((session) => session.totalMs !== undefined);
    if (completed.length === 0) {
      console.error(`No completed workspace timings in ${logPath}`);
      process.exitCode = 1;
    } else {
      const range = (values) => {
        const sorted = values.toSorted((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        const median =
          sorted.length % 2 === 0
            ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
            : sorted[middle];
        return `${median} (${sorted[0]}-${sorted.at(-1)})`;
      };
      console.log(`Completed targets: ${completed.length}`);
      console.log('Values are median (min-max) milliseconds across completed targets.');
      console.log(`Total to browser-ready: ${range(completed.map((session) => session.totalMs))}`);
      for (const stage of stages) {
        const values = completed
          .map((session) => session.timings.get(stage))
          .filter(Number.isFinite);
        if (values.length === 0) continue;
        const shares = completed
          .filter((session) => Number.isFinite(session.timings.get(stage)))
          .map((session) => Math.round((100 * session.timings.get(stage)) / session.totalMs));
        console.log(`${stage.padEnd(22)} ${range(values).padStart(18)}  ${range(shares)}%`);
      }
      console.log(`Log: ${logPath}`);
    }
  } catch (error) {
    console.error(`Cannot read ${logPath}: ${error.message}`);
    process.exitCode = 1;
  }
}
