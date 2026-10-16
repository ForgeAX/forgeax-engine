import { verifyProvenance } from './provenance.mjs';
try {
  await verifyProvenance();
  process.stdout.write('[ui-blitz] generated WASM/glue match current source.\n');
} catch (cause) {
  console.error(
    `[ui-blitz] ${cause.message}\nRun pnpm -F @forgeax/engine-ui-blitz fetch-wasm or build:wasm, then retry.`,
  );
  process.exitCode = 1;
}
