#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runViewStartInteractive } from './view-start.ts';

const HELP = `forgeax-view-start

Serve View on an already-running Engine backend.

Usage:
  forgeax-view-start [--root <backend-workspace>] [--project <project>] [--json]

For normal one-file startup use node <installed-engine>/tools/view/start.mjs --project <game>.
With an already-running compatible Backend: forgeax view start --root <backend-workspace> --project <game>

Run forgeax backend start first. Open the returned URL in an ordinary browser.
--project admits the project on the Engine backend before returning a plain View URL.
The backend owns the project session; opening the URL attaches the Shell to its facts.
The command does not launch a browser or Play.

Environment:
  FORGEAX_PROJECT_ROOT             backend workspace when --root is omitted
`;

function parseHelp(argv: readonly string[]) {
  return argv.includes('--help') || argv.includes('-h');
}

export default async function main() {
  const argv = process.argv.slice(2);
  if (parseHelp(argv)) {
    process.stdout.write(HELP);
    return;
  }
  process.stdout.write(JSON.stringify(await runViewStartInteractive(argv)) + '\n');
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
  main().catch((error) => {
    process.stderr.write(`[forgeax-view] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
