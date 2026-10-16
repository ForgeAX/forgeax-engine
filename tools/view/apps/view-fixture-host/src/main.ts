import { startFixtureHost } from './host.ts';

function options(argv: string[]) {
  let port = 0;
  let scenario = 'default';
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--port') {
      const value = argv[++index];
      port = Number(value);
      if (!value || !Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('--port requires an integer from 0 to 65535');
    } else if (flag === '--scenario') {
      scenario = argv[++index] ?? '';
    } else {
      throw new Error(`Unknown fixture option: ${flag}`);
    }
  }
  if (scenario !== 'default') throw new Error(`Unsupported fixture scenario: ${scenario}`);
  return { port, scenario };
}

try {
  const { port, scenario } = options(process.argv.slice(2));
  const fixture = await startFixtureHost({ port });
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    try { await fixture.dispose(); }
    catch (error) { console.error(error); process.exitCode = 1; }
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  console.log(JSON.stringify({ origin: fixture.origin, scenario }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
