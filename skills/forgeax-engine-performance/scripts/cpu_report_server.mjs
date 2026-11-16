import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { serveReport } from './report_server.mjs';

const REPORT_FILES = new Map([
  ['timeline.html', 'text/html; charset=utf-8'],
  ['timeline-inspector.html', 'text/html; charset=utf-8'],
  ['timeline.trace.json', 'application/json'],
  ['timeline.json', 'application/json'],
  ['analysis.json', 'application/json'],
  ['call-trees.json', 'application/json'],
  ['timeline.svg', 'image/svg+xml'],
  ['call-tree.svg', 'image/svg+xml'],
]);

export async function serveCpuReport(directory, options = {}) {
  return serveReport(directory, { ...options, entry: 'timeline.html', files: REPORT_FILES });
}

export async function serveCpuReportCli(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { port: { type: 'string', default: '0' } },
  });
  if (positionals.length !== 1) throw Error('Usage: cpu.mjs serve REPORT_DIRECTORY [--port 0]');
  const { server, url } = await serveCpuReport(positionals[0], { port: Number(values.port) });
  process.stdout.write(
    JSON.stringify({ status: 'serving', url, directory: resolve(positionals[0]), stop: 'Ctrl+C' }) +
      '\n',
  );
  const stop = () => server.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
