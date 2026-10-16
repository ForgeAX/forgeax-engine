import { after, test } from 'node:test';
import assert from 'node:assert/strict';
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
} from '../prepare-native.mjs';
const directory = mkdtempSync(join(tmpdir(), 'forgeax-dawn-output-'));

test('Windows MSBuild probe stays below MAX_PATH in a deep source checkout', { skip: process.platform !== 'win32' }, () => {
  const packageRoot = 'C:/Users/developer/projects/game-engine/deep-checkout/packages/dawn-node';
  const cache = nativeBuildCache(packageRoot, 'a'.repeat(64), 'win32');
  const stateFile = join(cache, 'host-toolchain/build/CMakeFiles/3.31.8/VCTargetsPath/x64/Debug/VCTargetsPath.tlog/VCTargetsPath.lastbuildstate');
  assert.ok(stateFile.length < 260, `MSBuild state path has ${stateFile.length} characters: ${stateFile}`);
  assert.equal(nativeBuildCache(packageRoot, 'b'.repeat(64), 'darwin'), resolve(packageRoot, '.native-build', 'b'.repeat(64)));
});

test('Windows CMake defaults to an installed Visual Studio generator for x64', { skip: process.platform !== 'win32' }, () => {
  const source = join(directory, 'cmake-generator-probe');
  const build = join(source, 'build');
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, 'CMakeLists.txt'),
    [
      'cmake_minimum_required(VERSION 3.24)',
      'project(forgeax_dawn_generator_probe LANGUAGES CXX)',
      '',
    ].join('\n'),
  );
  const result = spawnSync('cmake', ['-S', source, '-B', build, '-A', 'x64'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const cache = readFileSync(join(build, 'CMakeCache.txt'), 'utf8');
  assert.match(cache, /^CMAKE_GENERATOR:INTERNAL=Visual Studio \d+ \d{4}\r?$/m);
  assert.match(cache, /^CMAKE_GENERATOR_PLATFORM:INTERNAL=x64\r?$/m);
});

test('Windows Dawn source builds use bounded MSVC compiler and project parallelism', () => {
  assert.deepEqual(nativeBuildConcurrency('win32', 1), {
    configureFlags: ['-DCMAKE_C_FLAGS=/MP1', '-DCMAKE_CXX_FLAGS=/MP1'],
    buildProcesses: 1,
  });
  assert.deepEqual(nativeBuildConcurrency('win32', 2), {
    configureFlags: ['-DCMAKE_C_FLAGS=/MP2', '-DCMAKE_CXX_FLAGS=/MP2'],
    buildProcesses: 1,
  });
  assert.deepEqual(nativeBuildConcurrency('win32', 8), {
    configureFlags: ['-DCMAKE_C_FLAGS=/MP4', '-DCMAKE_CXX_FLAGS=/MP4'],
    buildProcesses: 1,
  });
  assert.deepEqual(nativeBuildConcurrency('darwin', 8), { configureFlags: [], buildProcesses: 2 });
  assert.deepEqual(nativeBuildConcurrency('darwin'), { configureFlags: [], buildProcesses: 2 });
  const windows = nativeBuildConcurrency('win32');
  assert.equal(windows.buildProcesses, 1);
  assert.match(windows.configureFlags[1], /^-DCMAKE_CXX_FLAGS=\/MP[1-4]$/);
});

test('explicit CMake parallelism caps native preparation without changing platform defaults', () => {
  const previous = process.env.CMAKE_BUILD_PARALLEL_LEVEL;
  try {
    process.env.CMAKE_BUILD_PARALLEL_LEVEL = '1';
    assert.equal(nativeBuildConcurrency('darwin', 12).buildProcesses, 1);
    assert.deepEqual(nativeBuildConcurrency('win32', 12), {
      configureFlags: ['-DCMAKE_C_FLAGS=/MP1', '-DCMAKE_CXX_FLAGS=/MP1'],
      buildProcesses: 1,
    });
    process.env.CMAKE_BUILD_PARALLEL_LEVEL = '8';
    assert.equal(nativeBuildConcurrency('darwin', 12).buildProcesses, 2);
    assert.deepEqual(nativeBuildConcurrency('win32', 12), {
      configureFlags: ['-DCMAKE_C_FLAGS=/MP4', '-DCMAKE_CXX_FLAGS=/MP4'],
      buildProcesses: 1,
    });
    for (const invalid of ['0', '-1', 'NaN', '1.5']) {
      process.env.CMAKE_BUILD_PARALLEL_LEVEL = invalid;
      assert.throws(() => nativeBuildConcurrency('darwin', 12), /invalid-build-parallelism/);
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
