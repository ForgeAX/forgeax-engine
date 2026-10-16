#!/usr/bin/env node
// Physical native gate: a selected profile with no evidence must save a report
// and exit unsuccessfully. Run under the existing GPU lease, never basic setup.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyConformanceReport } from './verify-conformance-report.mjs';

const [executable, output] = process.argv.slice(2);
if (!executable || !output) throw Error('CONFORMANCE_EXE OUTPUT required');
const root = resolve(output);
mkdirSync(root, { recursive: true });
const result = spawnSync(resolve(executable), ['--profile','upstream','--output-root',root], {
  encoding:'utf8',timeout:90000,windowsHide:true,
});
writeFileSync(resolve(root,'selection.log'),`${result.stdout ?? ''}${result.stderr ?? ''}`);
const directories = readdirSync(root,{withFileTypes:true}).filter(item=>item.isDirectory());
assert.equal(directories.length,1,'each selection gate needs a fresh output directory');
const {report,cases} = verifyConformanceReport(resolve(root,directories[0].name,'report.json'));
assert.equal(report.environment.capabilities.backend,'Dx12');
assert.equal(report.environment.capabilities.rayQuery,true);
assert.equal(result.status,1,'selected missing evidence must not return exit 0');
assert.equal(result.signal,null);
assert.equal(report.apiConformanceVerdict,'incomplete');
assert.equal(report.countsByProfile.upstream.notRun,3);
assert.equal(cases.filter(item=>item.profile==='upstream' && item.status==='not-run').length,3);
assert.match(result.stderr,/report saved to .*qualification failed/);
process.stdout.write(`${JSON.stringify({passed:true,expectedExitCode:1,runId:report.runId,missingUpstreamCases:3})}\n`);
