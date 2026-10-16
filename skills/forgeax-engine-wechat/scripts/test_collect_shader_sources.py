import contextlib
import copy
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import collect_shader_sources as runner
from wechatide import ToolFailure


IDENTITY = {'file': 'fixture', 'bytes': 1, 'digest': 'sha256:' + '0' * 64}


def prepared_plan():
    return {'version': 1, 'source': {name: IDENTITY for name in ('alignment', 'tape', 'publication', 'preparedPlan')},
            'operations': [
                {'method': 'clear', 'args': [256], 'workIndex': None, 'pipelineId': None, 'programOrdinal': None},
                {'method': 'drawArrays', 'args': [4, 0, 3], 'workIndex': 65, 'pipelineId': 'renderPipeline:810', 'programOrdinal': 1},
                {'method': 'drawArrays', 'args': [4, 0, 3], 'workIndex': 72, 'pipelineId': 'renderPipeline:811', 'programOrdinal': 2}],
            'programs': [{'ordinal': 1, 'pipelineId': 'renderPipeline:810', 'workIndices': [65], 'glEventIndices': [1]},
                         {'ordinal': 2, 'pipelineId': 'renderPipeline:811', 'workIndices': [72], 'glEventIndices': [2]}],
            'selectedPrograms': [2]}


class FakeOfficial:
    def __init__(self, plan, *, lost_install=False, lost_source=False, bad_page=False, partial=False, preexisting=False, refuse_release=False):
        self.plan, self.calls = plan, []
        self.lost_install, self.lost_source, self.bad_page = lost_install, lost_source, bad_page
        self.preexisting, self.refuse_release = preexisting, refuse_release
        self.owner = 'other' if preexisting else None
        self.text = '#version 300 es\n// \u6c49\u5b57\U0001f600"\\\n' * 1000
        self.sources = {(2, stage, kind): self.text + stage + kind for stage in ('vertex', 'fragment') for kind in ('original', 'translated') if not (partial and kind == 'original')}
        self.programs = []
        for value in plan['programs']:
            program = copy.deepcopy(value) | {'selected': value['ordinal'] == 2, 'availability': 'available' if value['ordinal'] == 2 else 'not-collected', 'shaders': []}
            if value['ordinal'] == 2:
                for stage in ('vertex', 'fragment'):
                    shader = {'stage': stage}
                    for kind in ('original', 'translated'):
                        text = self.sources.get((2, stage, kind))
                        shader[kind] = {'availability': 'available', 'chars': runner.utf16_length(text), 'utf8Bytes': len(runner.source_bytes(text))} if text is not None else {'availability': 'unavailable', 'reason': 'fixture-unavailable'}
                    program['shaders'].append(shader)
            self.programs.append(program)
        self.draws = [{'glEventIndex': 1, 'workIndex': 65, 'programOrdinal': 1}, {'glEventIndex': 2, 'workIndex': 72, 'programOrdinal': 2}]
        self.report = {'kind': 'bounded-aligned-shader-sources', 'phase': 'done', 'status': 'partial' if partial else 'complete', 'source': plan['source'],
                       'expectedOperations': 3, 'observedOperations': 3, 'expectedPrograms': 2, 'selectedPrograms': [2], 'expectedDraws': 2, 'observedDraws': 2,
                       'methodsRestored': True, 'restoreFailures': 0, 'retainedProgramHandles': 0,
                       'totalSourceBytes': sum(len(runner.source_bytes(text)) for text in self.sources.values())}

    def invoke(self, _config, args, directory, timeout):
        assert args[:3] == ['automation_evaluate', '--project', '/explicit/active-project']
        assert args[3] == '--fn-source' and 0 < timeout <= 30
        request = json.loads(args[-1].rpartition('return operate(')[2].removesuffix(');}'))
        self.calls.append(request)
        directory.mkdir()
        (directory / 'request.json').write_text(json.dumps(request))
        op = request['operation']
        if op == 'install':
            if self.preexisting:
                value = {'status': 'already-installed'}
            else:
                self.owner = request['collectionId']
                if self.lost_install:
                    self.lost_install = False
                    raise ToolFailure('installation reply lost after script ran')
                value = {'collectionId': self.owner, 'report': self.report | {'phase': 'aligning', 'status': 'armed'}}
        elif op == 'release':
            if self.owner is not None and self.owner != request['collectionId']:
                value = {'status': 'probe-owner-changed'}
            elif self.refuse_release:
                value = {'released': True, 'methodsRestored': False}
            else:
                self.owner = None
                value = {'released': True, 'methodsRestored': True}
        elif op == 'summary':
            value = self.report
        elif op in ('programs', 'draws'):
            rows = self.programs if op == 'programs' else self.draws
            offset, count = request['offset'], request['count']
            value = {'offset': offset, 'total': len(rows), 'rows': rows[offset:offset + count], 'nextOffset': min(len(rows), offset + count)}
        elif op == 'source':
            if self.lost_source:
                self.lost_source = False
                raise ToolFailure('one source reply lost')
            if request['count'] > 2048:
                value = {'status': 'page-too-large', 'retryCount': 2048}
            else:
                text = self.sources[request['ordinal'], request['stage'], request['kind']]
                offset, count = request['offset'], request['count']
                encoded = text.encode('utf-16-le')
                fragment = encoded[offset * 2:(offset + count) * 2].decode('utf-16-le', errors='ignore')
                value = {key: request[key] for key in ('ordinal', 'stage', 'kind', 'offset')} | {
                    'totalChars': runner.utf16_length(text), 'utf8Bytes': len(runner.source_bytes(text)), 'text': fragment,
                    'nextOffset': offset + runner.utf16_length(fragment)}
                if self.bad_page and offset > 0:
                    value['nextOffset'] += 1
        else:
            raise AssertionError(op)
        response = {'ok': True, 'tool': 'automation_evaluate', 'result': {'success': True, 'result': value}}
        (directory / 'result.json').write_text(json.dumps(response))
        return response, 0


class ShaderRunnerTests(unittest.TestCase):
    def execute(self, directory, fixture, **kwargs):
        prepared = Path(directory) / 'prepared'
        prepared.mkdir()
        (prepared / 'install.js').write_text('(function(){})\n')
        (prepared / 'plan.json').write_text(json.dumps(fixture.plan))
        out = Path(directory) / 'capture'
        with patch('collect_shader_sources.invoke', fixture.invoke), patch('collect_shader_sources.time.sleep'), contextlib.redirect_stdout(io.StringIO()):
            result = runner.collect({}, '/explicit/active-project', prepared, out, canvas_selector='canvas#explicit', **kwargs)
        return result, out

    def test_full_unicode_transfer_is_exportable_with_actual_node_exporter(self):
        fixture = FakeOfficial(prepared_plan())
        with tempfile.TemporaryDirectory() as directory:
            result, out = self.execute(directory, fixture)
            self.assertTrue(result['success'], result)
            self.assertTrue(result['released'])
            self.assertFalse((out / 'assembled.partial.json').exists())
            assembled = json.loads((out / 'assembled.json').read_text())
            self.assertEqual(len(assembled['programs']), 2)
            self.assertEqual(assembled['programs'][0]['availability'], 'not-collected')
            for body in assembled['sources']:
                self.assertEqual(body['text'], fixture.sources[body['ordinal'], body['stage'], body['kind']])
            exported = subprocess.run(['node', str(Path(runner.__file__).with_name('shader_sources.mjs')), '--collected', str(out / 'assembled.json'), '--out', str(out / 'exported')], capture_output=True, text=True, timeout=10)
            self.assertEqual(exported.returncode, 0, exported.stderr)
            self.assertEqual(len(list((out / 'exported').glob('*.glsl'))), 2)
            self.assertEqual(len(list((out / 'exported').glob('*.translated.txt'))), 2)
        self.assertEqual(sum(row['operation'] == 'install' for row in fixture.calls), 1)
        self.assertEqual(fixture.calls[-1]['operation'], 'release')
        self.assertTrue(all(row.get('count', 0) <= 4096 for row in fixture.calls))

    def test_retry_is_same_read_offset_and_install_never_repeats(self):
        fixture = FakeOfficial(prepared_plan(), lost_source=True)
        with tempfile.TemporaryDirectory() as directory:
            result, _ = self.execute(directory, fixture)
        self.assertTrue(result['success'], result)
        reads = [row for row in fixture.calls if row['operation'] == 'source']
        self.assertEqual(reads[0], reads[1])
        self.assertEqual(sum(row['operation'] == 'install' for row in fixture.calls), 1)

    def test_lost_install_reply_still_releases_only_the_owned_probe(self):
        fixture = FakeOfficial(prepared_plan(), lost_install=True)
        with tempfile.TemporaryDirectory() as directory:
            result, out = self.execute(directory, fixture)
            self.assertFalse(result['success'])
            self.assertTrue(result['released'])
            self.assertTrue((out / 'assembled.partial.json').exists())
            self.assertFalse((out / 'assembled.json').exists())
        self.assertEqual([row['operation'] for row in fixture.calls], ['install', 'release'])

    def test_invalid_page_preserves_preceding_text_and_never_publishes_success(self):
        fixture = FakeOfficial(prepared_plan(), bad_page=True)
        with tempfile.TemporaryDirectory() as directory:
            result, out = self.execute(directory, fixture)
            self.assertFalse(result['success'])
            self.assertTrue(result['released'])
            value = json.loads((out / 'assembled.partial.json').read_text())
            self.assertGreater(value['inProgressSource']['offset'], 0)
            self.assertEqual(runner.utf16_length(value['inProgressSource']['text']), value['inProgressSource']['offset'])
            self.assertFalse((out / 'assembled.json').exists())

    def test_partial_original_availability_keeps_translations_and_metadata_without_pass(self):
        fixture = FakeOfficial(prepared_plan(), partial=True)
        with tempfile.TemporaryDirectory() as directory:
            result, out = self.execute(directory, fixture)
            self.assertFalse(result['success'])
            self.assertTrue(result['transferComplete'])
            value = json.loads((out / 'assembled.partial.json').read_text())
            self.assertEqual(len(value['sources']), 2)
            self.assertTrue(all(body['kind'] == 'translated' for body in value['sources']))
            self.assertEqual(value['report']['status'], 'partial')

    def test_existing_probe_and_failed_cleanup_are_not_success(self):
        for options in ({'preexisting': True}, {'refuse_release': True}):
            fixture = FakeOfficial(prepared_plan(), **options)
            with self.subTest(options=options), tempfile.TemporaryDirectory() as directory:
                result, out = self.execute(directory, fixture)
                self.assertFalse(result['success'])
                self.assertFalse(result['released'])
                self.assertFalse((out / 'assembled.json').exists())
                self.assertTrue((out / 'assembled.partial.json').exists())
            if options.get('preexisting'):
                self.assertEqual(fixture.owner, 'other')

    def test_overall_deadline_reserves_release_time(self):
        fixture = FakeOfficial(prepared_plan())
        original = fixture.invoke
        clock = [0.0]
        def slow(config, args, directory, timeout):
            op = json.loads(args[-1].rpartition('return operate(')[2].removesuffix(');}'))['operation']
            if op == 'summary':
                clock[0] += timeout
                raise ToolFailure('bounded summary timeout')
            clock[0] += 0.1
            return original(config, args, directory, timeout)
        fixture.invoke = slow
        with tempfile.TemporaryDirectory() as directory, patch('collect_shader_sources.time.monotonic', lambda: clock[0]):
            result, out = self.execute(directory, fixture, deadline_seconds=10)
            self.assertFalse(result['success'])
            self.assertTrue(result['released'])
            self.assertLessEqual(result['elapsedSeconds'], 10)
            self.assertTrue((out / 'assembled.partial.json').exists())

    def test_unsafe_or_existing_output_fails_before_installation(self):
        fixture = FakeOfficial(prepared_plan())
        with tempfile.TemporaryDirectory() as directory:
            result, out = self.execute(directory, fixture)
            self.assertTrue(result['success'])
            before = len(fixture.calls)
            with patch('collect_shader_sources.invoke', fixture.invoke), self.assertRaises(FileExistsError):
                runner.collect({}, '/explicit/active-project', out.parent / 'prepared', out, canvas_selector='canvas#explicit')
            self.assertEqual(len(fixture.calls), before)
        with self.assertRaises(ToolFailure):
            runner.collect({}, 'relative-project', Path('/absent'), Path('/absent'), canvas_selector='x')

    def test_javascript_owner_guard_and_explicit_bindings_are_executable(self):
        collection_id = 'fixture-owned-collection'
        installer = "function(options){globalThis.__forgeaxShaderSourceProbe={release(){delete globalThis.__forgeaxShaderSourceProbe;return {released:true,methodsRestored:true};}};return {selector:options.canvas};}"
        install = runner.evaluation({'operation': 'install', 'collectionId': collection_id}, installer, {}, "function(){return {canvas:'INSTALLER PLAN BINDINGS 😀',readReceipt:()=>({})};}")
        release = runner.evaluation({'operation': 'release', 'collectionId': collection_id})
        source = f'''import assert from 'node:assert/strict';
          const install=({install}),release=({release});
          const result=install();assert.equal(result.report.selector,'INSTALLER PLAN BINDINGS 😀');
          assert.equal(globalThis.__forgeaxShaderSourceProbe.__forgeaxHostCollector,{json.dumps(collection_id)});
          assert.equal(release().released,true);
          globalThis.__forgeaxShaderSourceProbe={{__forgeaxHostCollector:'other',release(){{throw Error('must preserve other owner');}}}};
          assert.equal(install().status,'already-installed');assert.equal(release().status,'probe-owner-changed');
        '''
        completed = subprocess.run(['node', '--input-type=module'], input=source, text=True, capture_output=True, timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)


if __name__ == '__main__':
    unittest.main()
