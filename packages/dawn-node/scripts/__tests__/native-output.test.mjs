import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, unlinkSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativeOutputReady, sha, verifyWindowsX64 } from '../native-output.mjs';
import {
  git as sourceGit,
  nativeBuildCache,
  nativeBuildConcurrency,
  prepareGclientGit,
  runGclient,
  windowsBuildEnvironment,
  windowsNativeBuildProfile,
  verifyWindowsBuildCommands,
} from '../prepare-native.mjs';
const directory = mkdtempSync(join(tmpdir(), 'forgeax-dawn-output-'));

test('Windows MSBuild probe stays below MAX_PATH in a deep source checkout', { skip: process.platform !== 'win32' }, () => {
  const packageRoot = 'C:/Users/developer/projects/game-engine/deep-checkout/packages/dawn-node';
  const cache = nativeBuildCache(packageRoot, 'a'.repeat(64), 'win32');
  const stateFile = join(cache, 'host-toolchain/build/CMakeFiles/3.31.8/VCTargetsPath/x64/Debug/VCTargetsPath.tlog/VCTargetsPath.lastbuildstate');
  assert.ok(stateFile.length < 260, `MSBuild state path has ${stateFile.length} characters: ${stateFile}`);
  assert.equal(nativeBuildCache(packageRoot, 'b'.repeat(64), 'darwin'), resolve(packageRoot, '.native-build', 'b'.repeat(64)));
});

test('Windows SDK discovery supplies the native Ninja MSVC toolchain', { skip: process.platform !== 'win32' }, () => {
  const source = join(directory, 'cmake-generator-probe');
  const build = join(source, 'build');
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, 'CMakeLists.txt'),
    [
      'cmake_minimum_required(VERSION 3.24)',
      'project(forgeax_dawn_generator_probe LANGUAGES CXX)',
      'find_program(host_ninja NAMES ninja.exe REQUIRED)',
      'file(WRITE "${CMAKE_BINARY_DIR}/native-tools.txt" "${CMAKE_GENERATOR_INSTANCE}\\n${CMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION}\\n${host_ninja}\\n${CMAKE_CXX_COMPILER}")',
      'set(CMAKE_CXX_STANDARD 20)',
      'add_executable(native_probe main.cpp)',
      '',
    ].join('\n'),
  );
  writeFileSync(join(source, 'main.cpp'), '#include <d3d12.h>\n#include <dxgi1_4.h>\n#include <span>\n#include <vector>\nint main() { std::vector<int> values{1, 2}; return std::span(values).size() == 2 ? 0 : 1; }\n');
  const result = spawnSync('cmake', ['-S', source, '-B', build, '-A', 'x64'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const cache = readFileSync(join(build, 'CMakeCache.txt'), 'utf8');
  assert.match(cache, /^CMAKE_GENERATOR:INTERNAL=Visual Studio \d+ \d{4}\r?$/m);
  assert.match(cache, /^CMAKE_GENERATOR_PLATFORM:INTERNAL=x64\r?$/m);
  const [installation, sdkVersion, hostNinja, compiler] = readFileSync(join(build, 'native-tools.txt'), 'utf8').trim().split(/\r?\n/);
  const env = windowsBuildEnvironment(installation, sdkVersion);
  // depot_tools carries a POSIX ninja launcher ahead of the host tools on PATH.
  const depotTools = join(source, 'depot_tools');
  mkdirSync(depotTools);
  writeFileSync(join(depotTools, 'ninja'), '#!/bin/sh\nexit 9\n');
  env.PATH = `${depotTools};${env.PATH}`;
  const ninja = join(source, 'ninja');
  for (const args of [
    ['-S', source, '-B', ninja, '-GNinja', `-DCMAKE_MAKE_PROGRAM=${hostNinja}`, `-DCMAKE_CXX_COMPILER=${compiler}`,
      ...windowsNativeBuildProfile],
    ['--build', ninja, '--parallel', String(nativeBuildConcurrency())],
  ]) {
    const compiled = spawnSync('cmake', args, { env, encoding: 'utf8', windowsHide: true });
    assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
  }
  const [{ command }] = JSON.parse(readFileSync(join(ninja, 'compile_commands.json'), 'utf8'));
  assert.match(command, /(?:^|\s)[/-]Od(?=\s|$)/);
  assert.match(command, /(?:^|\s)[/-]Ob0(?=\s|$)/);
  assert.match(command, /(?:^|\s)[/-]DNDEBUG(?=\s|$)/);
  verifyWindowsBuildCommands(ninja);
  assert.equal(spawnSync(join(ninja, 'native_probe.exe'), [], { env, windowsHide: true }).status, 0);
  // A dependency can override a configuration flag at target scope. Inspect
  // the real generated command, not just CMakeCache or a small probe's profile.
  const cmake = join(source, 'CMakeLists.txt');
  writeFileSync(cmake, `${readFileSync(cmake, 'utf8')}\ntarget_compile_options(native_probe PRIVATE /O2)\n`);
  const overridden = spawnSync('cmake', ['-S', source, '-B', ninja], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(overridden.status, 0, `${overridden.stdout}\n${overridden.stderr}`);
  assert.throws(() => verifyWindowsBuildCommands(ninja), /host-optimization-policy/);
});

test('native Ninja compilation has one CPU-bounded two-job budget', () => {
  assert.equal(nativeBuildConcurrency(1), 1);
  assert.equal(nativeBuildConcurrency(2), 2);
  assert.equal(nativeBuildConcurrency(8), 2);
  assert.ok(nativeBuildConcurrency() <= 2);
});

test('explicit CMake parallelism caps native preparation without changing platform defaults', () => {
  const previous = process.env.CMAKE_BUILD_PARALLEL_LEVEL;
  try {
    process.env.CMAKE_BUILD_PARALLEL_LEVEL = '1';
    assert.equal(nativeBuildConcurrency(12), 1);
    process.env.CMAKE_BUILD_PARALLEL_LEVEL = '8';
    assert.equal(nativeBuildConcurrency(12), 2);
    for (const invalid of ['0', '-1', 'NaN', '1.5']) {
      process.env.CMAKE_BUILD_PARALLEL_LEVEL = invalid;
      assert.throws(() => nativeBuildConcurrency(12), /invalid-build-parallelism/);
    }
  } finally {
    if (previous === undefined) delete process.env.CMAKE_BUILD_PARALLEL_LEVEL;
    else process.env.CMAKE_BUILD_PARALLEL_LEVEL = previous;
  }
});

test('Windows source integrity reads existing long paths instead of reporting deletions', { skip: process.platform !== 'win32' }, () => {
  const source = join(directory, 'source');
  mkdirSync(source);
  sourceGit(source, ['init']);
  sourceGit(source, ['config', 'core.longpaths', 'false']);
  sourceGit(source, ['config', 'core.autocrlf', 'false']);
  const file = join(source, 'nested/'.repeat(45), 'witness.txt');
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, 'source witness\n');
  sourceGit(source, ['-c', 'core.longpaths=true', 'add', '.']);
  sourceGit(source, ['-c', 'user.name=Source Witness', '-c', 'user.email=source@example.invalid', 'commit', '-m', 'witness']);
  assert.equal(sourceGit(source, ['diff', 'HEAD', '--name-only']), '');
});
after(() => {
  assert.equal(resolve(directory, '..'), resolve(tmpdir()));
  rmSync(directory, { recursive: true, force: true });
});

test('native cache rejects a missing or changed DLL even when dawn.node is unchanged', () => {
  const files = {};
  for (const name of ['dawn.node', 'dxcompiler.dll', 'dxil.dll', 'd3dcompiler_47.dll']) {
    writeFileSync(join(directory, name), name);
    files[name] = sha(join(directory, name));
  }
  writeFileSync(join(directory, 'provenance.json'), JSON.stringify({ inputKey: 'current', files }));
  assert.equal(nativeOutputReady(directory, 'current', 'win32'), true);
  assert.equal(nativeOutputReady(directory, 'old', 'win32'), false);
  unlinkSync(join(directory, 'dxil.dll'));
  assert.equal(nativeOutputReady(directory, 'current', 'win32'), false);
  writeFileSync(join(directory, 'dxil.dll'), 'different SDK bytes');
  assert.equal(nativeOutputReady(directory, 'current', 'win32'), false);
  writeFileSync(join(directory, 'dxil.dll'), 'dxil.dll');
  assert.equal(nativeOutputReady(directory, 'current', 'win32'), true);
  writeFileSync(join(directory, 'provenance.json'), '{"inputKey":');
  assert.equal(nativeOutputReady(directory, 'current', 'win32'), false);
});

test('Windows publication rejects wrong architecture and malformed PE offsets', () => {
  const path = join(directory, 'architecture.dll');
  const bytes = Buffer.alloc(128);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(0x8664, 68);
  writeFileSync(path, bytes);
  verifyWindowsX64(path);
  bytes.writeUInt16LE(0xaa64, 68);
  writeFileSync(path, bytes);
  assert.throws(() => verifyWindowsX64(path), /built-architecture-mismatch/);
  bytes.writeUInt32LE(0xffffffff, 0x3c);
  writeFileSync(path, bytes);
  assert.throws(() => verifyWindowsX64(path), /built-architecture-mismatch/);
  writeFileSync(path, Buffer.alloc(2));
  assert.throws(() => verifyWindowsX64(path), /invalid-pe/);
});

test('official Windows batch transport preserves paths, arguments and nonzero exits', { skip: process.platform !== 'win32' }, () => {
  const tools = join(directory, 'tools with spaces %FORGEAX_TRAP% &');
  mkdirSync(tools);
  writeFileSync(join(tools, 'gclient.bat'), '@echo off\r\necho %1,%2> "%FORGEAX_BATCH_RESULT%"\r\nexit /b %FORGEAX_BATCH_EXIT%\r\n');
  const output = join(directory, 'batch-result.txt');
  const env = { ...process.env, FORGEAX_TRAP: 'wrong-path', FORGEAX_BATCH_RESULT: output, FORGEAX_BATCH_EXIT: '0' };
  runGclient(tools, ['metrics', '--opt-out'], directory, env);
  assert.equal(readFileSync(output, 'utf8').trim(), 'metrics,--opt-out');
  assert.throws(() => runGclient(tools, ['sync', '--nohooks'], directory, { ...env, FORGEAX_BATCH_EXIT: '7' }), /producer-failed:.*:7/);
  assert.equal(readFileSync(output, 'utf8').trim(), 'sync,--nohooks');
});

test('Windows compiler environment preserves literal paths and stays process-local', { skip: process.platform !== 'win32' }, () => {
  const installation = join(directory, 'visual studio %FORGEAX_TRAP% &');
  const tools = join(installation, 'Common7/Tools');
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, 'VsDevCmd.bat'), '@echo off\r\nset "FORGEAX_NATIVE_ENV_PROBE=compiler scope"\r\nset "PATH=C:\\native tools;%PATH%"\r\nexit /b 0\r\n');
  const env = windowsBuildEnvironment(installation, '10.0.26100.0', { ...process.env, FORGEAX_TRAP: 'wrong-path' });
  assert.equal(env.FORGEAX_NATIVE_ENV_PROBE, 'compiler scope');
  assert.ok(env.PATH.startsWith('C:\\native tools;'));
  assert.equal(process.env.FORGEAX_NATIVE_ENV_PROBE, undefined);
  assert.throws(() => windowsBuildEnvironment(installation, '10.0&bad'), /sdk-version-invalid/);
});

test('pinned depot_tools bootstrap delegates to installed Git with a literal executable path', { skip: process.platform !== 'win32' }, () => {
  const tools = join(directory, 'git-tools');
  mkdirSync(join(tools, 'bootstrap'), { recursive: true });
  writeFileSync(join(tools, 'bootstrap/git.template.bat'), '@echo off\r\n"${GIT_BIN_ABSDIR}\\${GIT_PROGRAM}" %*\r\n');
  prepareGclientGit(tools, process.env);
  const entry = readFileSync(join(tools, 'git.bat'), 'utf8');
  const executable = entry.split(/\r?\n/)[1].split('"')[1];
  assert.ok(!executable.includes('%') && !executable.includes('${'));
  assert.match(sourceGit(directory, ['--version']), /^git version /);
  writeFileSync(join(tools, 'gclient.bat'), '@echo off\r\ncall "%~dp0git.bat" --version > "%FORGEAX_BATCH_RESULT%"\r\nexit /b %errorlevel%\r\n');
  const output = join(directory, 'git-version.txt');
  runGclient(tools, ['metrics'], directory, { ...process.env, FORGEAX_BATCH_RESULT: output });
  assert.match(readFileSync(output, 'utf8'), /^git version /);
});
