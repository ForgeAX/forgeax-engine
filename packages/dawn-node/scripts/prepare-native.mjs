import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync, renameSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve, join, delimiter, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nativeFiles, nativeOutputReady, sha, verifyWindowsX64 } from './native-output.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const nodeHead = '2f5fb632d9d9db9bcb3705bd868de69a6a2ae4e2';
const dawnHead = 'c5d549e250b9225744929ae860b369cb4304a767';
const patchSHA = 'bb1dc69fe563a1d77a1024c345caf021615e023ddac4bbf9a71061f23b24400c';
const patchedFiles = {
  'src/dawn/native/metal/DeviceMTL.h': '28810f496ab334abc7f11fd1d9dcb0cd822b4a35d3ce65e23693cde84b0567c6',
  'src/dawn/native/metal/DeviceMTL.mm': 'b81701dfd05820a27040abd3996897a3bb09efadd43d11edd8814894f691f5ff',
  'src/dawn/native/metal/CommandBufferMTL.mm': '374629b226a11dcc737f506aba20fffa7f5edec7ac0c497ad3769c8afc200678',
};
export function resolveMacOsSdk() {
  const result = spawnSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' });
  const sdk = result.stdout?.trim();
  if (result.error || result.status !== 0 || !sdk || !existsSync(join(sdk, 'SDKSettings.json')))
    throw new Error('dawn-native-sdk-unavailable: select an installed macOS SDK with xcode-select');
  return sdk;
}
function run(command, args, cwd, env, options = {}) {
  const result = spawnSync(command, args, { windowsHide: true, ...options, cwd, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`dawn-native-producer-failed:${command}:${result.status}`);
}
export function runGclient(tools, args, cwd, env = process.env) {
  if (process.platform !== 'win32') return run(join(tools, 'gclient'), args, cwd, env);
  if (args.some((arg) => !/^[a-z0-9-]+$/i.test(arg))) throw new Error('dawn-native-invalid-gclient-argument');
  // Expand the path once from env, inside quotes, even when it contains % or &.
  // The official wrapper supplies its pinned vpython dependencies.
  run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/cmd.exe'),
    ['/d', '/v:off', '/s', '/c', `""%FORGEAX_DAWN_GCLIENT%" ${args.join(' ')}"`], cwd,
    { ...env, DEPOT_TOOLS_UPDATE: '0', FORGEAX_DAWN_GCLIENT: join(tools, 'gclient.bat'),
      VPYTHON_VIRTUALENV_ROOT: env.VPYTHON_VIRTUALENV_ROOT ?? resolve(`${env.SystemDrive ?? 'C:'}/tmp/forgeax-dawn-vpython`) },
    { windowsVerbatimArguments: true });
}
export function prepareGclientGit(tools, env) {
  // Updating depot_tools is disabled for pinned builds. Render its official
  // bootstrap entry against the installed Git without changing global config.
  const found = spawnSync(join(env.SystemRoot ?? 'C:\\Windows', 'System32/where.exe'), ['git.exe'], { env, encoding: 'utf8', windowsHide: true });
  const executable = found.stdout?.trim().split(/\r?\n/)[0];
  if (found.error || found.status !== 0 || !executable || !existsSync(executable)) throw new Error('dawn-native-git-unavailable');
  const installation = dirname(dirname(executable));
  if (/[\r\n%"]/.test(executable)) throw new Error('dawn-native-invalid-git-path');
  const template = readFileSync(join(tools, 'bootstrap/git.template.bat'), 'utf8');
  // git_common also parses this stub to invoke the executable directly.
  const entry = template.replaceAll('${GIT_BIN_ABSDIR}', installation).replaceAll('${GIT_PROGRAM}', relative(installation, executable));
  if (/\$\{/.test(entry)) throw new Error('dawn-native-git-template-mismatch');
  writeFileSync(join(tools, 'git.bat'), entry);
}
export function git(path, args) {
  const policy = process.platform === 'win32' ? ['-c', 'core.longpaths=true', '-c', 'core.autocrlf=false'] : [];
  const result = spawnSync('git', [...policy, '-C', path, ...args], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw result.error ?? new Error('dawn-native-source-git-failed');
  return result.stdout.trim();
}
function verifyOfficialSource(source, dawn) {
  if (git(source, ['rev-parse', 'HEAD']) !== nodeHead || git(dawn, ['rev-parse', 'HEAD']) !== dawnHead) throw new Error('dawn-native-source-head-mismatch');
  // Official gclient may update the depot_tools gitlink; it may not change Node
  // producer/configuration source. Dawn is validated independently below.
  const nodeChanges = git(source, ['diff', 'HEAD', '--name-only']).split('\n').filter(Boolean);
  if (nodeChanges.some((path) => path !== 'third_party/dawn' && path !== 'third_party/depot_tools')) throw new Error('dawn-native-node-source-modification');
  const expectedPaths = Object.keys(patchedFiles).sort();
  const actualPaths = git(dawn, ['diff', 'HEAD', '--name-only']).split('\n').filter(Boolean).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) throw new Error('dawn-native-unexpected-source-modification');
  for (const [path, digest] of Object.entries(patchedFiles)) if (sha(join(dawn, path)) !== digest) throw new Error(`dawn-native-patched-source-integrity:${path}`);
}
export function nativeBuildCache(packageRoot, key, platform = process.platform) {
  // MSBuild's generated tracking files still require short paths, even when
  // Git longpaths is enabled. Keep the complete producer digest in the key.
  return platform === 'win32'
    ? resolve(`${process.env.SystemDrive ?? 'C:'}/tmp/forgeax-dawn-native`, key)
    : resolve(packageRoot, '.native-build', key);
}
export function nativeBuildConcurrency(platform, available = availableParallelism()) {
  const requested = process.env.CMAKE_BUILD_PARALLEL_LEVEL;
  const limit = requested === undefined ? Infinity : Number(requested);
  if (requested !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
    throw new Error('dawn-native-invalid-build-parallelism');
  if (platform !== 'win32') return { configureFlags: [], buildProcesses: Math.min(2, limit) };
  const compilerProcesses = Math.min(4, Math.max(1, available), limit);
  return {
    configureFlags: [
      `-DCMAKE_C_FLAGS=/MP${compilerProcesses}`,
      `-DCMAKE_CXX_FLAGS=/MP${compilerProcesses}`,
    ],
    buildProcesses: 1,
  };
}
export async function prepareNative() {
  if (!['darwin', 'win32'].includes(process.platform)) return;
  const windows = process.platform === 'win32';
  const python = windows ? 'python' : 'python3';
  if (!(windows ? ['x64'] : ['arm64', 'x64']).includes(process.arch)) throw new Error(`dawn-native-unsupported-architecture:${process.platform}:${process.arch}`);
  const patch = resolve(root, 'patches/metal-empty-compute.patch');
  if (sha(patch) !== patchSHA) throw new Error('dawn-native-source-patch-integrity');
  const key = createHash('sha256').update(JSON.stringify({ nodeHead, dawnHead, patchSHA, platform: process.platform, arch: process.arch, producerSHA: sha(fileURLToPath(import.meta.url)), outputContractSHA: sha(fileURLToPath(new URL('./native-output.mjs', import.meta.url))) })).digest('hex');
  const native = resolve(root, `dist/native/${process.platform}-${process.arch}`);
  if (nativeOutputReady(native, key, process.platform)) return;
  // Fail before fetching source when the host cannot run the official producer.
  for (const [command, args] of [['cmake', ['--version']], ['go', ['version']], [python, ['--version']]]) run(command, args, root, process.env);
  const cache = nativeBuildCache(root, key);
  mkdirSync(cache, { recursive: true });
  let sdk = windows ? undefined : resolveMacOsSdk();
  if (windows) {
    const probe = join(cache, 'host-toolchain');
    mkdirSync(probe, { recursive: true });
    writeFileSync(join(probe, 'CMakeLists.txt'), [
      "cmake_minimum_required(VERSION 3.24)",
      "project(forgeax_dawn_host LANGUAGES CXX)",
      "set(sdk_found FALSE)",
      "foreach(view IN ITEMS 64 32)",
      "  cmake_host_system_information(RESULT sdk_root QUERY WINDOWS_REGISTRY",
      "    \"HKLM/SOFTWARE/Microsoft/Windows Kits/Installed Roots\" VALUE KitsRoot10 VIEW ${view})",
      "  file(TO_CMAKE_PATH \"${sdk_root}\" sdk_root)",
      "  set(headers \"${sdk_root}/Include/${CMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION}\")",
      "  if(EXISTS \"${headers}/um/d3d12.h\" AND EXISTS \"${headers}/shared/dxgi1_4.h\")",
      "    file(WRITE \"${CMAKE_BINARY_DIR}/sdk.txt\" \"${sdk_root}",
      "${CMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION}\")",
      "    set(sdk_found TRUE)",
      "    break()",
      "  endif()",
      "endforeach()",
      "if(NOT sdk_found)",
      "  message(FATAL_ERROR \"dawn-native-windows-sdk-headers-unavailable\")",
      "endif()",
      '',
    ].join('\n'));
    run('cmake', ['-S', probe, '-B', join(probe, 'build'), '-A', 'x64'], cache, process.env);
    sdk = readFileSync(join(probe, 'build/sdk.txt'), 'utf8').trim().split(/\r?\n/);
  }
  const source = process.env.FORGEAX_DAWN_NATIVE_SOURCE_DIR ? resolve(process.env.FORGEAX_DAWN_NATIVE_SOURCE_DIR) : join(cache, 'node-webgpu');
  if (!existsSync(join(source, '.git'))) {
    if (process.env.FORGEAX_DAWN_NATIVE_SOURCE_DIR) throw new Error('dawn-native-explicit-source-unavailable');
    run('git', ['clone', '--config', 'core.autocrlf=false', '--config', 'core.longpaths=true', '--no-checkout', 'https://github.com/dawn-gpu/node-webgpu.git', source], cache, process.env);
    run('git', ['checkout', '--detach', nodeHead], source, process.env);
  }
  if (!process.env.FORGEAX_DAWN_NATIVE_SOURCE_DIR) run('git', ['-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', 'submodule', 'update', '--init'], source, process.env);
  const dawn = join(source, 'third_party/dawn');
  if (git(source, ['rev-parse', 'HEAD']) !== nodeHead || git(dawn, ['rev-parse', 'HEAD']) !== dawnHead) throw new Error('dawn-native-source-head-mismatch');
  const dirty = git(dawn, ['diff', 'HEAD', '--name-only']);
  if (!dirty) git(dawn, ['apply', '--whitespace=error', patch]);
  verifyOfficialSource(source, dawn);
  const tools = join(source, 'third_party/depot_tools');
  const env = { ...process.env, PATH: [tools, process.env.PATH, join(dawn, 'third_party/ninja')].join(delimiter), DEPOT_TOOLS_WIN_TOOLCHAIN: '0' };
  if (windows) {
    env.WINDOWSSDKDIR = sdk[0];
    env.WIN10_SDK_PATH = sdk[0];
    env.WIN10_SDK_VERSION = sdk[1];
    prepareGclientGit(tools, env);
    // gclient's own Git children must retain these source-byte/path invariants.
    const count = Number(env.GIT_CONFIG_COUNT ?? 0);
    for (const [offset, name, value] of [[0, 'core.longpaths', 'true'], [1, 'core.autocrlf', 'false']]) {
      env[`GIT_CONFIG_KEY_${count + offset}`] = name;
      env[`GIT_CONFIG_VALUE_${count + offset}`] = value;
    }
    env.GIT_CONFIG_COUNT = String(count + 2);
  }
  {
    const standalone = readFileSync(join(dawn, 'scripts/standalone-with-node.gclient'), 'utf8');
    const marker = '"custom_vars" : {';
    if (!standalone.includes(marker)) throw new Error('dawn-native-standalone-contract-mismatch');
    writeFileSync(join(dawn, '.gclient'), standalone.replace(marker, '"custom_deps" : {"third_party/swiftshader": None},\n    '+marker));
    runGclient(tools, ['metrics', '--opt-out'], dawn, env);
    // Windows uses installed MSVC/SDK through CMake, not GN bootstrap hooks.
    runGclient(tools, ['sync', '--no-history', ...(windows ? ['--nohooks'] : [])], dawn, env);
  }
  verifyOfficialSource(source, dawn);
  const output = process.env.FORGEAX_DAWN_NATIVE_BUILD_DIR ? resolve(process.env.FORGEAX_DAWN_NATIVE_BUILD_DIR) : join(cache, 'build'); mkdirSync(output, { recursive: true });
  const arch = process.arch === 'x64' ? 'x86_64' : 'arm64';
  const concurrency = nativeBuildConcurrency(process.platform);
  const configure = windows
    ? [
      '-A', 'x64', ...concurrency.configureFlags,
      '-DDAWN_ENABLE_D3D12=ON', '-DDAWN_USE_BUILT_DXC=ON', '-DDAWN_FORCE_SYSTEM_COMPONENT_LOAD=OFF',
    ]
    : ['-GNinja', `-DCMAKE_OSX_ARCHITECTURES=${arch}`, `-DCMAKE_OSX_SYSROOT=${sdk}`];
  run('cmake', [dawn, ...configure, '-DDAWN_BUILD_NODE_BINDINGS=ON', '-DDAWN_USE_X11=OFF', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_CXX_VISIBILITY_PRESET=hidden', '-DCMAKE_VISIBILITY_INLINES_HIDDEN=1'], output, env);
  run('cmake', [
    '--build', output, '--config', 'Release', '--target', 'dawn_node',
    '--parallel', String(concurrency.buildProcesses),
  ], output, env);
  verifyOfficialSource(source, dawn);
  const built = windows ? join(output, 'Release') : output;
  if (windows) {
    for (const name of nativeFiles('win32')) verifyWindowsX64(join(built, name));
  } else {
    const archResult = spawnSync('lipo', ['-archs', join(built, 'dawn.node')], { encoding: 'utf8' });
    if (archResult.status !== 0 || archResult.stdout.trim() !== arch) throw new Error('dawn-native-built-architecture-mismatch');
  }
  mkdirSync(native, { recursive: true });
  const files = {};
  for (const name of nativeFiles(process.platform)) {
    const target = join(native, name);
    const temporary = `${target}.new-${process.pid}`;
    copyFileSync(join(built, name), temporary); renameSync(temporary, target);
    files[name] = sha(target);
  }
  const provenance = join(native, 'provenance.json');
  const temporary = `${provenance}.new-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ inputKey: key, nodeHead, dawnHead, patchSHA, platform: process.platform, architecture: process.arch, ...(sdk ? { sdk } : {}), compiler: windows ? 'built-dxc' : 'metal', files }, null, 2)}\n`);
  renameSync(temporary, provenance);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await prepareNative();
