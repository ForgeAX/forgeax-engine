#!/usr/bin/env node
// Explicit contributor diagnostics; never a source setup or basic-test dependency.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectWindowsBinary, releaseFlags, sourceInputs } from './windows-artifact.mjs';

const [gpuDirectory, nagaDirectory, outputDirectory] = process.argv.slice(2).map(value => resolve(value));
if (!gpuDirectory || !nagaDirectory || !outputDirectory) throw Error('GPU_ARTIFACT NAGA_ARTIFACT OUTPUT required');
mkdirSync(outputDirectory, { recursive: true });
const dx12Compiler = process.env.WGPU_DX12_COMPILER ?? 'staticdxc';
if (dx12Compiler !== 'staticdxc' && dx12Compiler !== 'dxc') throw Error('ray-query-requires-dxc');
const manifest = JSON.parse(readFileSync(resolve(gpuDirectory, 'manifest.json')));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
if (manifest.kind !== 'upstream-gpu-diagnostic' || manifest.wgpuCommit !== sourceInputs().wgpuCommit ||
    manifest.rustFlags !== releaseFlags || manifest.diagnosticSourceRoot !== 'C:/w/forgeax-upstream-dx12') {
  throw Error('upstream-artifact-source-admission-failed');
}
for (const name of ['wgpu-info.exe', 'wgpu-gpu.exe', 'wgpu-examples.exe']) {
  const bytes = readFileSync(resolve(gpuDirectory, name));
  const entry = manifest.binaries[name];
  if (!entry || digest(bytes) !== entry.sha256 || JSON.stringify(inspectWindowsBinary(bytes)) !== JSON.stringify(entry.imports)) {
    throw Error(`upstream-binary-admission-failed:${name}`);
  }
}
const sourceRoot = manifest.diagnosticSourceRoot;
for (const [path, expected] of Object.entries(manifest.fixtures)) {
  if (!/^examples\/features\/src\/(ray_[a-z_]+\/[^/]+|skybox\/models\/rustacean-3d\.(obj|mtl))$/.test(path)) throw Error(`invalid-fixture:${path}`);
  const bytes = readFileSync(resolve(gpuDirectory, 'fixtures', path));
  if (digest(bytes) !== expected || digest(readFileSync(resolve('third_party/wgpu', path))) !== expected) throw Error(`fixture-source-mismatch:${path}`);
  const destination = resolve(sourceRoot, path);
  if (existsSync(destination) && digest(readFileSync(destination)) !== expected) throw Error(`existing-diagnostic-fixture-conflict:${path}`);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
}
const command = (name, executable, args) => {
  const started = Date.now();
  const result = spawnSync(resolve(gpuDirectory, executable), args, {
    encoding: 'utf8', cwd: sourceRoot, timeout: 90000, windowsHide: true, maxBuffer: 64*1024*1024,
    env: { ...process.env, WGPU_BACKEND: 'dx12', WGPU_DX12_COMPILER: dx12Compiler },
  });
  const log = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(resolve(outputDirectory, `${name}.log`), log);
  return { command:[executable,...args], exitCode:result.status, signal:result.signal,
    durationMs:Date.now()-started, error:result.error?.message, log };
};
const info = command('gpuconfig', 'wgpu-info.exe', ['--json', '--output', resolve(sourceRoot, '.gpuconfig')]);
if (info.exitCode !== 0) throw Error('native-gpuconfig-failed');
const config = JSON.parse(readFileSync(resolve(sourceRoot, '.gpuconfig')));
config.devices = config.devices.filter(({info}) => info.backend.toLowerCase() === 'dx12' && info.name === 'NVIDIA GeForce RTX 4080');
if (config.devices.length !== 1 || config.devices[0].info.device_type !== 'DiscreteGpu') throw Error('strict-native-RTX4080-DX12-adapter-missing');
writeFileSync(resolve(sourceRoot, '.gpuconfig'), JSON.stringify(config,null,2)+'\n');
writeFileSync(resolve(outputDirectory, 'gpuconfig.json'), JSON.stringify(config,null,2)+'\n');
const suites = [];
for (const [suiteName, executable, filter] of [
  ['wgpu-gpu-ray-tracing','wgpu-gpu.exe','wgpu_gpu::ray_tracing::'],
  ['wgpu-ray-tracing-examples','wgpu-examples.exe','ray_'],
]) {
  const listed = command(`${suiteName}-list`, executable, ['--list',filter]);
  const names = listed.log.split(/\r?\n/).filter(line=>line.endsWith(': test')).map(line=>line.slice(0,-6));
  if (listed.exitCode !== 0 || !names.length) throw Error(`upstream-test-enumeration-failed:${suiteName}`);
  const cases = [];
  for (const [index,name] of names.entries()) {
    const result = command(`${suiteName}-${index.toString().padStart(3,'0')}`, executable, ['--exact',name,'--nocapture','--test-threads','1']);
    const status = result.exitCode === 0 && /test result: ok\. 1 passed; 0 failed/.test(result.log)
      ? name.includes('[Unsupported:') ? 'unsupported' : 'pass' : 'fail';
    const {log,...evidence} = result;
    cases.push({name,status,...evidence});
    process.stdout.write(`${suiteName} ${index+1}/${names.length} ${status} ${name}\n`);
    writeFileSync(resolve(outputDirectory, `${suiteName}.partial.json`),JSON.stringify(cases,null,2)+'\n');
  }
  suites.push({name:suiteName,cases,passed:cases.some(c=>c.status==='pass')&&cases.every(c=>c.status!=='fail')});
}
// Reject upstream's implicit screenshot re-baselining if a fixture was unreadable.
for (const [path,expected] of Object.entries(manifest.fixtures)) {
  if (digest(readFileSync(resolve(sourceRoot,path))) !== expected) throw Error(`upstream-fixture-was-rewritten:${path}`);
}
if (readFileSync(resolve(nagaDirectory,'wgpu-commit.txt'),'utf8').trim() !== manifest.wgpuCommit) throw Error('naga-source-pin-mismatch');
const nagaCases = [];
for (const name of ['snapshots::convert_snapshots_wgsl','snapshots::convert_snapshots_spv','wgsl_errors::ray_query_vertex_return_enable_extension']) {
  const log = readFileSync(resolve(nagaDirectory,`${name.replaceAll('::','-')}.log`),'utf8');
  writeFileSync(resolve(outputDirectory,`${name.replaceAll('::','-')}.log`),log);
  nagaCases.push({name,status:log.includes(`test ${name} ...`) && /test result: ok\. 1 passed; 0 failed/.test(log) ? 'pass' : 'fail',execution:'upstream Linux CPU compiler suite'});
}
suites.push({name:'naga-ray-query',cases:nagaCases,passed:nagaCases.every(c=>c.status==='pass')});
const report = {schemaVersion:1,wgpuVersion:'30.0.1',wgpuTag:'v30.0.1',
  wgpuTagCommit:'40f4a34ebaf56f9a046231f54125ad046239d3f3',wgpuSourceCommit:manifest.wgpuCommit,
    producerEngineCommit:manifest.engineCommit,dx12Compiler,
    requestedDx12Environment:Object.fromEntries(['WGPU_DX12_AGILITY_SDK_VERSION','WGPU_DX12_AGILITY_SDK_REQUIRE',
      'WGPU_DX12_EXPERIMENTAL_SHADER_MODELS','WGPU_GPU_BASED_VALIDATION'].map(name=>[name,process.env[name]??null])),
    adapter:config.devices[0].info,suites};
const path = resolve(outputDirectory,'upstream-report.json');
writeFileSync(path,JSON.stringify(report,null,2)+'\n');
process.stdout.write(`${path}\n`);
if (suites.some(s=>!s.passed)) process.exitCode=1;
