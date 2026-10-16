#!/usr/bin/env node

process.stderr.write(
  '[forgeax-view-host] removed. Use `forgeax backend start`, then `forgeax view start` for the interface; supply a Page to startView() for loop integration.\n',
);
process.exitCode = 1;
