#!/usr/bin/env node

process.stderr.write(
  '[forgeax-view-host] removed. Use `node <installed-engine>/tools/view/start.mjs --project <game>` for the interface; supply a Page to startView() for loop integration.\n',
);
process.exitCode = 1;
