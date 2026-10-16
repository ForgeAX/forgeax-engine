import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PKG_ROOT } from './content-key.mjs';
import { verifyArtifactProvenance, verifyProvenance } from './provenance.mjs';

let ready = false;
try {
  if (
    existsSync(join(PKG_ROOT, '../../.git')) ||
    existsSync(join(PKG_ROOT, '../../.forgeax-public-distribution'))
  ) {
    await verifyProvenance();
  } else await verifyArtifactProvenance();
  ready = true;
} catch (cause) {
  process.stderr.write(`[ui-blitz] ${cause.message}\n`);
}
if (ready) process.stdout.write('[ui-blitz] generated WASM/glue already verified.\n');
else if (existsSync(join(PKG_ROOT, '../../scripts/lib/ensure-wasm-lib.mjs'))) {
  // Published packages carry pkg/ and do not require the contributor helper.
  const { ensureWasm } = await import('../../../scripts/lib/ensure-wasm-lib.mjs');
  process.exitCode = ensureWasm({
    pkgLabel: 'ui-blitz',
    presenceMarkers: [],
    ready: false,
    fetchScript: join(PKG_ROOT, 'scripts/fetch-wasm.mjs'),
    skipEnv: 'FORGEAX_SKIP_UI_BLITZ_FETCH',
    buildHint:
      'pnpm -F @forgeax/engine-ui-blitz fetch-wasm or build:wasm (Rust 1.99.0 and wasm-bindgen 0.2.129)',
  });
} else
  process.stderr.write(
    '[ui-blitz] Published package is incomplete; reinstall the same Engine version to restore its checked WASM and glue.\n',
  );
