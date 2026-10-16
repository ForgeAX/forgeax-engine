#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const appRoot = resolve(import.meta.dirname, '..');

export function expectedNativeBackend(platform = process.platform) {
  if (platform === 'darwin') return 'Metal';
  if (platform === 'win32') return 'Dx12';
  if (platform === 'linux') return 'Vulkan';
  throw new Error(`unsupported native Ray Query platform: ${platform}`);
}

export function verifyReport(reportPath, options = {}) {
  const absolute = resolve(reportPath);
  const report = JSON.parse(readFileSync(absolute, 'utf8'));
  const schema = JSON.parse(readFileSync(resolve(appRoot, 'report.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(schema);
  if (!validate(report)) throw new Error(ajv.errorsText(validate.errors, { separator: '\n' }));

  if (report.verdict === 'unsupported' && options.allowUnsupported === true) {
    if (!['native-backend-unavailable', 'ray-query-unsupported'].includes(report.error?.code)) {
      throw new Error(`unexpected unsupported code: ${report.error?.code}`);
    }
    return report;
  }
  if (report.verdict !== 'ok') throw new Error(`strict smoke verdict is ${report.verdict}`);
  const expectedBackend = options.expectedBackend ?? expectedNativeBackend();
  if (report.capabilities?.backend !== expectedBackend || report.capabilities?.rayQuery !== true) {
    throw new Error(`strict smoke did not enable ${expectedBackend} Ray Query`);
  }
  if (report.positive?.triangleVisible !== true || report.positive?.barycentricVariation !== true) {
    throw new Error('positive frame lacks a varying barycentric triangle');
  }
  if (
    report.resized?.width !== 384 ||
    report.resized?.height !== 320 ||
    report.resized?.triangleVisible !== true ||
    report.resized?.barycentricVariation !== true
  ) {
    throw new Error('resized frame did not preserve the Ray Query triangle');
  }
  if (report.restored?.triangleVisible !== true || report.restored?.barycentricVariation !== true) {
    throw new Error('restored frame did not preserve the Ray Query triangle');
  }
  if (
    report.emptyTlas?.triangleVisible !== false ||
    report.emptyTlas?.nonBlackPixelCount !== 0 ||
    report.emptyTlasVerdict !== 'triangle-not-visible'
  ) {
    throw new Error('empty-TLAS falsification did not remove the triangle');
  }
  if (!existsSync(resolve(absolute, '../frame.png'))) throw new Error('frame.png is missing');
  if (!existsSync(resolve(absolute, '../frame-resized.png'))) {
    throw new Error('frame-resized.png is missing');
  }
  if (!existsSync(resolve(absolute, '../frame-restored.png'))) {
    throw new Error('frame-restored.png is missing');
  }
  const expectedCases = ['CREATE-01', 'RQ-01', 'TLAS-06', 'STAB-03', 'STAB-04'];
  const actualCases = report.coreCases.map(({ id, status }) => `${id}:${status}`).sort();
  if (JSON.stringify(actualCases) !== JSON.stringify(expectedCases.map((id) => `${id}:pass`).sort())) {
    throw new Error(`packaged lifecycle cases are incomplete: ${actualCases.join(', ')}`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reportPath = process.argv.find((arg) => arg.endsWith('.json'))
    ?? resolve(appRoot, 'report/native-ray-query-triangle/report.json');
  const allowUnsupported = process.argv.includes('--allow-unsupported');
  const report = verifyReport(reportPath, { allowUnsupported });
  process.stdout.write(`${JSON.stringify({ verdict: report.verdict, reportPath })}\n`);
}
