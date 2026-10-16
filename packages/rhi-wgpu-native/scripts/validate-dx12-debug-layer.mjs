// Opt-in Windows integration regression; no default build/test dependency.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'win32', 'this probe requires Windows DX12');
assert.ok(process.argv[2], 'output directory required');
const directory = resolve(process.argv[2]);
const scripts = dirname(fileURLToPath(import.meta.url));
const addon = resolve(process.env.FORGEAX_RHI_WGPU_NATIVE_ADDON ?? resolve(scripts, '../native/forgeax-rhi-wgpu-native.win32-x64.node'));
mkdirSync(directory, { recursive: true });
const child = resolve(directory, 'native-device.cjs');
writeFileSync(child, `
const assert = require('node:assert/strict');
const binding = require(process.argv[2]);
const adapter = binding.requestAdapter('high-performance', false);
assert.ok(adapter, 'physical DX12 adapter required');
const info = JSON.parse(adapter.info());
assert.equal(info.backend, 'Dx12');
assert.equal(info.isFallbackAdapter, false);
assert.ok(adapter.features().includes('wgpu-ray-query'));
const device = adapter.requestDevice(JSON.stringify({requiredFeatures:['wgpu-ray-query']}));
assert.ok(device);
console.log(JSON.stringify({adapter:info,deviceCreated:true,rayQuery:true}));
`);
const runs = [];
for (const enabled of [false, true]) {
  const name = enabled ? 'enabled' : 'disabled';
  const log = resolve(directory, `${name}.log`);
  const report = resolve(directory, `${name}-debug.json`);
  const request = resolve(directory, `${name}-request.json`);
  const env = { ...process.env, WGPU_VALIDATION: enabled ? '1' : '0', WGPU_GPU_BASED_VALIDATION: enabled ? '1' : '0', WGPU_DEBUG: '0' };
  writeFileSync(request, JSON.stringify({executable:process.execPath,arguments:[child,addon],cwd:directory,log,report,timeoutMs:90000}, null, 2));
  const result = spawnSync(resolve(process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-NonInteractive','-File',resolve(scripts,'collect-debug-output.ps1'),'-Request',request], {env,windowsHide:true,encoding:'utf8',timeout:105000,maxBuffer:16*1024*1024});
  writeFileSync(resolve(directory, `${name}-collector.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.error) throw result.error;
  const evidence = JSON.parse(readFileSync(report,'utf8').replace(/^\uFEFF/,''));
  const startup = evidence.debugStrings.filter(message => message.includes('GPU-Based Validation is enabled'));
  const errors = evidence.debugStrings.filter(message => /D3D Error|(?:D3D12|DXGI).*(?:ERROR|CORRUPTION)|\[\s*(?:EXECUTION|STATE_CREATION|RESOURCE_MANIPULATION)\s+(?:ERROR|CORRUPTION)/i.test(message));
  const output = readFileSync(log,'utf8').trim();
  const native = evidence.exitCode === 0 ? JSON.parse(output) : null;
  const run = {enabled,exitCode:evidence.exitCode,timedOut:evidence.timedOut,adapter:native?.adapter,deviceCreated:native?.deviceCreated,gpuValidationStartupMessages:startup.length,errors,graphicsModules:evidence.graphicsModules};
  runs.push(run);
  writeFileSync(resolve(directory,'report.json'),JSON.stringify({kind:'native-dx12-debug-layer-admission',hardwareWorkloadQualified:false,addon,addonSha256:createHash('sha256').update(readFileSync(addon)).digest('hex'),runs},null,2));
  assert.equal(result.status,0,output);
  assert.equal(evidence.exitCode,0);
  assert.equal(evidence.timedOut,false);
  assert.equal(native.deviceCreated,true);
  assert.equal(errors.length,0,errors.join('\n'));
  assert.equal(startup.length > 0,enabled,'actual D3D12 startup must follow the GPU validation switch');
  if (enabled) assert.ok(evidence.graphicsModules.some(module => /d3d12sdklayers\.dll/i.test(module)));
  console.log(`${name}: actual DX12 device; GPU validation startup=${startup.length}`);
}
