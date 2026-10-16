#!/usr/bin/env python3
"""Deterministic offline checks; no device, browser or native GPU calls."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from analyze_phone_lifetime import GL_FIELDS, KINDS, LANES, MAX_COUNTER, analyze, markdown

HERE = Path(__file__).resolve().parent
SHA = 'a' * 64


def report(capacities=(1024, 2048, 2048, 2048)):
    samples = [{'at': 10000 + i*1000, 'memory': {'status': 'available', 'byteLength': size},
                'calls': {kind: i*100 if kind == 'submit' else 0 for kind in KINDS},
                'frees': {'explicit': i, 'finalizer': 0, 'missing': 0, 'other': 0}}
               for i, size in enumerate(capacities)]
    gl_samples = []
    for i in range(len(samples)):
        row = {'at': 10000 + i*1000}
        for lane in LANES:
            row[lane] = {method: dict.fromkeys(fields, 0) for method, fields in GL_FIELDS.items()}
        row['insideSubmit']['fenceSync'].update(calls=i*2, nonNull=i*2)
        row['insideSubmit']['deleteSync']['calls'] = max(0, i*2-2)
        gl_samples.append(row)
    return {'startedAt': 10000, 'finishedAt': samples[-1]['at']+500,
            'source': {'manifestSha256': SHA},
            'nativeWasmErrors': {'laterThrows': 0, 'skippedInstances': 0, 'instances': [
                {'id': 1, 'initialMemory': samples[0]['memory'], 'failures': [],
                 'lifetime': {'samples': samples, 'droppedSamples': 0, 'sampler': 'stopped', 'exports': [
                     {'name': 'rhiwgputexture_createView', 'kind': 'create', 'calls': 3, 'throws': 1},
                     {'name': '__wbg_rhiwgputextureview_free', 'kind': 'free', 'calls': 1, 'throws': 0,
                      'freeArguments': {'explicit': 0, 'finalizer': 1, 'missing': 0, 'other': 0, 'ptrZero': 0, 'ptrNonzero': 1, 'ptrOther': 0}}]}}]},
            'nativeGlErrors': {'laterThrows': 0, 'skippedContexts': 0, 'contexts': [
                {'id': 1, 'failures': [], 'lifetime': {**{lane: copy.deepcopy(gl_samples[-1][lane]) for lane in LANES},
                    'samples': gl_samples, 'droppedSamples': 0, 'sampler': 'stopped'}}]}}


class LifetimeAnalysisTests(unittest.TestCase):
    def test_growth_and_constant_suffix_do_not_become_leak_free(self):
        result = analyze(report(), SHA)
        capacity = result['wasmInstances'][0]['capacity']
        self.assertEqual(capacity['status'], 'capacity-growth-observed')
        self.assertEqual(capacity['capacityGrowthBytes'], 1024)
        self.assertEqual(capacity['constantSuffix']['durationMs'], 2000)
        self.assertEqual(capacity['constantSuffix']['nativeSubmitCallDelta'], 200)
        steady = analyze(report(), SHA, 100)['wasmInstances'][0]['capacity']
        self.assertEqual(steady['status'], 'constant-capacity-observed')
        self.assertIsNone(result['sceneFrames']['observed'])
        self.assertEqual(result['wasmInstances'][0]['exports'][0]['calls'], 3)
        self.assertNotIn('success', result['wasmInstances'][0]['exports'][0])

    def test_missing_memory_counter_and_empty_report_stay_unknown(self):
        source = report()
        source['nativeWasmErrors']['instances'][0]['lifetime']['samples'][1]['memory'] = {'status': 'read-failed'}
        del source['nativeGlErrors']['contexts'][0]['lifetime']['insideSubmit']['deleteSync']['calls']
        result = analyze(source, SHA)
        self.assertIsNone(result['wasmInstances'][0]['capacity']['capacityGrowthBytes'])
        self.assertIsNone(result['glContexts'][0]['terminal']['fenceSyncCallsMinusDeleteSyncCalls'])
        empty = analyze({}, SHA)
        self.assertIsNone(empty['wasmInstances'])
        self.assertIsNone(empty['runtimeThrows']['gl']['capturedCount'])

    def test_clock_rollback_duplicate_counter_reset_and_saturation(self):
        for mode in ('backward', 'duplicate', 'reset', 'saturated', 'capacity-reset'):
            source = report()
            rows = source['nativeWasmErrors']['instances'][0]['lifetime']['samples']
            if mode == 'backward': rows[-1]['at'] = 1
            elif mode == 'duplicate': rows[-1]['at'] = rows[-2]['at']
            elif mode == 'reset': rows[-1]['calls']['submit'] = 1
            elif mode == 'saturated': rows[-1]['calls']['submit'] = MAX_COUNTER
            else: rows[-1]['memory']['byteLength'] = 1
            with self.subTest(mode=mode):
                result = analyze(source, SHA)['wasmInstances'][0]
                self.assertEqual(result['capacity']['status'], 'insufficient-evidence')
                self.assertTrue(result['issues'])

    def test_instances_and_contexts_never_merge(self):
        source = report()
        extra = copy.deepcopy(source['nativeWasmErrors']['instances'][0])
        extra['id'] = 2
        for row in extra['lifetime']['samples']: row['memory']['byteLength'] = 8192
        source['nativeWasmErrors']['instances'].append(extra)
        extra_gl = copy.deepcopy(source['nativeGlErrors']['contexts'][0]); extra_gl['id'] = 2
        extra_gl['lifetime']['insideSubmit']['fenceSync']['calls'] = 9
        source['nativeGlErrors']['contexts'].append(extra_gl)
        result = analyze(source, SHA)
        self.assertEqual([row['capacity']['endCapacityBytes'] for row in result['wasmInstances']], [2048, 8192])
        self.assertEqual([row['terminal']['fenceSyncCallsMinusDeleteSyncCalls'] for row in result['glContexts']], [2, 5])

    def test_gl_attempts_return_bins_and_unknown_depth_are_not_live_fences(self):
        source = report()
        gl = source['nativeGlErrors']['contexts'][0]['lifetime']
        gl['unknownSubmitDepth']['fenceSync'].update(calls=5, nonNull=2, null=1, other=1, throws=1)
        gl['outsideSubmit']['clientWaitSync'].update(calls=3, timeoutExpired=2, waitFailed=1)
        result = analyze(source, SHA)['glContexts'][0]
        self.assertEqual(result['terminal']['totals']['fenceSync']['calls'], 11)
        self.assertEqual(result['terminal']['totals']['fenceSync']['nonNull'], 8)
        self.assertEqual(result['terminal']['totals']['clientWaitSync']['timeoutExpired'], 2)
        self.assertEqual(result['terminal']['fenceSyncCallsMinusDeleteSyncCalls'], 7)
        self.assertNotIn('live', result['terminal'])
        self.assertNotIn('retired', result['terminal'])

    def test_runtime_throw_separate_from_coverage_and_sensitive_text_omitted(self):
        source = report()
        gl = source['nativeGlErrors']
        gl['contexts'][0]['failures'] = [
            {'method': 'drawingBufferWidth', 'reason': 'accessor-unavailable'},
            {'method': 'getExtension', 'reason': 'owned-method-replaced'},
            {'method': 'deleteSync', 'reason': 'restore-failed'},
            {'method': '/private/account', 'reason': '/private/unknown'}]
        gl['first'] = {'at': 11000, 'method': 'bufferData', 'context': 1, 'message': 'wx1234567890abcdef /data/private', 'stack': 'Bearer secret'}
        gl['laterThrows'] = 2
        result = analyze(source, SHA)
        self.assertEqual(result['runtimeThrows']['gl']['capturedCount'], 3)
        notes = result['glContexts'][0]['coverage']['notes']
        self.assertEqual([note['category'] for note in notes], ['coverage-unavailable','later-owner-preserved','restoration-failed','unknown'])
        text = json.dumps(result) + markdown({'reports': [result]})
        for secret in ('wx1234567890abcdef', '/data/private', '/private/', 'Bearer secret'):
            self.assertNotIn(secret, text)

    def test_eviction_and_terminal_counters_keep_separate_boundaries(self):
        source = report()
        lifetime = source['nativeWasmErrors']['instances'][0]['lifetime']
        lifetime['samples'] = lifetime['samples'][2:]
        lifetime['droppedSamples'] = 2
        source['lifetimeSerialization'] = {'maxBytes': 2097152, 'droppedSamples': 1, 'status': 'trimmed'}
        result = analyze(source, SHA)
        owner = result['wasmInstances'][0]
        self.assertEqual(owner['window']['firstAfterMs'], 2000)
        self.assertEqual(owner['droppedSamples'], 2)
        self.assertEqual(result['lifetimeSerialization']['droppedSamples'], 1)
        del source['startedAt']
        self.assertEqual(analyze(source, SHA)['wasmInstances'][0]['window']['origin'], 'first-retained-sample')
        self.assertEqual(analyze(source, SHA)['wasmInstances'][0]['window']['firstAfterMs'], 0)

    def test_cli_rejects_existing_output_and_supports_multiple_reports(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); src = base/'private-source.json'; src.write_text(json.dumps(report()))
            command = [sys.executable, str(HERE/'analyze_phone_lifetime.py'), '--report', str(src), '--report', str(src), '--out', str(base/'out')]
            first = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            result = json.loads((base/'out/summary.json').read_text())
            self.assertEqual(len(result['reports']), 2)
            self.assertNotIn(directory, json.dumps(result))
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_partial_throw_record_and_invalid_numeric_types_stay_unknown(self):
        source = report()
        source['nativeWasmErrors']['laterThrows'] = 4
        source['nativeWasmErrors']['instances'][0]['lifetime']['samples'][0]['memory']['byteLength'] = True
        source['nativeGlErrors']['contexts'][0]['failures'] = [{'method': 'bufferData', 'reason': {'truncated': True}}]
        result = analyze(source, SHA)
        self.assertIsNone(result['runtimeThrows']['wasm']['capturedCount'])
        self.assertIsNone(result['wasmInstances'][0]['capacity']['capacityGrowthBytes'])
        self.assertEqual(result['glContexts'][0]['coverage']['notes'][0]['category'], 'unknown')

    def test_real_collectors_emit_supported_shape(self):
        # Execute production collectors with deterministic JS calls and timers.
        # This qualifies their serialization boundary, not native WebGL execution.
        script = r'''
import {pathToFileURL} from 'node:url';
const root=process.argv[1];
const {observeNativeWasmErrors}=await import(pathToFileURL(root+'/phone_native_wasm_errors.js'));
const {observeNativeGlErrors}=await import(pathToFileURL(root+'/phone_native_gl_errors.js'));
let now=1000;const timers=[];Date.now=()=>now;globalThis.setTimeout=f=>(timers.push(f),f);globalThis.clearTimeout=()=>{};
const gl={fenceSync(){return{}},deleteSync(){},getSyncParameter(){return 0x9119},clientWaitSync(){return 0x911b},getExtension(){return null}};
Object.defineProperty(gl,'drawingBufferWidth',{get(){throw Error('getter must not run')}});
const canvas={getContext(){return gl}},wx={createCanvas(){return canvas}};
const memory={buffer:new ArrayBuffer(16)};
const exports={memory,rhiwgpuqueue_writeBuffer(){},rhiwgpuqueue_submit(){gl.deleteSync(gl.fenceSync())},rhiwgputexture_createView(){},__wbg_rhiwgputextureview_free(){}};
const owner={async instantiate(){return{module:{},instance:{exports}}}};
const wasm=observeNativeWasmErrors(owner,{lifetime:true});
const gpu=observeNativeGlErrors(wx,undefined,{lifetime:true,readSubmitDepth:wasm.submitDepth});
wx.createCanvas().getContext('webgl2');const native=(await owner.instantiate('wgpu.wasm', {'./wgpu_wasm_bg.js':{}})).instance.exports;
for(let i=0;i<3;i++){native.rhiwgpuqueue_submit();native.rhiwgputexture_createView();native.__wbg_rhiwgputextureview_free(-1,1);now+=1000;for(const tick of timers.splice(0))tick();}
gl.getExtension=()=>null;gpu.release();wasm.release();
console.log(JSON.stringify({startedAt:1000,finishedAt:now,nativeWasmErrors:wasm.report,nativeGlErrors:gpu.report}));
'''
        run = subprocess.run(['node', '--input-type=module', '-e', script, str(HERE)], capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        result = analyze(json.loads(run.stdout), SHA)
        self.assertEqual(result['wasmInstances'][0]['capacity']['sampledSubmitCallDelta'], 3)
        self.assertEqual(result['wasmInstances'][0]['capacity']['status'], 'constant-capacity-observed')
        self.assertEqual(result['glContexts'][0]['terminal']['lanes']['insideSubmit']['fenceSync']['calls'], 3)
        self.assertEqual(result['glContexts'][0]['terminal']['fenceSyncCallsMinusDeleteSyncCalls'], 0)
        self.assertEqual(result['runtimeThrows']['gl']['capturedCount'], 0)
        self.assertEqual([n['category'] for n in result['glContexts'][0]['coverage']['notes']], ['coverage-unavailable','later-owner-preserved'])
        free = next(r for r in result['wasmInstances'][0]['exports'] if r['kind'] == 'free')
        self.assertEqual(free['freeArguments']['finalizer'], 3)
        self.assertEqual(free['freeArguments']['ptrNonzero'], 3)


if __name__ == '__main__':
    unittest.main()
