#!/usr/bin/env python3
"""Run with python3 test_scripts.py; no installed DevTools required."""
import base64
import contextlib
import io
import json
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest
import sys
sys.dont_write_bytecode = True
from unittest.mock import patch

from download_info import select
from wechatide import ToolFailure, command, extract_images, fetch_screenshot, invoke, outcome, parse_response


class ToolTests(unittest.TestCase):
    def test_local_arguments_are_not_shell_source(self):
        config = {'cli': '/Applications/WeChat Tools/wechatide'}
        fn = 'function () { return "$(touch /tmp/unwanted) `uname`"; }'
        self.assertEqual(command(config, ['automation_evaluate', '--fn-source', fn]),
                         [config['cli'], '-c', 'Codex', 'automation_evaluate', '--fn-source', fn])

    def test_remote_shell_roundtrip_preserves_special_characters(self):
        config = {'cli': '/Applications/WeChat Tools/wechatide', 'ssh': 'user@host', 'port': 2222}
        arguments = ['automation_evaluate', '--project', "/tmp/game's folder", '--fn-source',
                     'function () { return "$(echo injected) `uname`\\n"; }']
        argv = command(config, arguments)
        self.assertEqual(shlex.split(argv[-1]), [config['cli'], '-c', 'Codex', *arguments])
        self.assertIn('StrictHostKeyChecking=yes', argv)
        self.assertEqual(argv[-2], 'user@host')

    def test_rejects_host_injection_and_relative_executable(self):
        for config in ({'cli': 'wechatide'}, {'cli': '/wechatide', 'ssh': '-oProxyCommand=x'},
                       {'cli': '/wechatide', 'ssh': 'host;uname'},
                       {'cli': '/wechatide', 'ssh': 'host', 'port': 70000}):
            with self.assertRaises(ToolFailure):
                command(config, ['project_list'])

    def test_parses_diagnostics_and_nested_error(self):
        response = parse_response('diagnostic\n{bad json}\n' + json.dumps({
            'ok': True, 'result': {'content': [{'type': 'text', 'text':
            '{"success":false,"error":{"code":"APPID_ERROR"}}'}]}}))
        self.assertEqual(outcome(response), 1)
        with self.assertRaises(ToolFailure):
            parse_response('Tool: project_import\nOptions: --project')

    def test_pending_is_never_success(self):
        self.assertEqual(outcome({'ok': True, 'result': {'success': True, 'status': 'pending'}}), 3)
        self.assertEqual(outcome({'ok': True, 'result': {'success': True, 'status': 'completed'}}), 0)
        for status in ('failed', 'cancelled', 'expired', 'rejected'):
            self.assertEqual(outcome({'ok': True, 'result': {'status': status}}), 1)
        self.assertEqual(outcome({'result': {'isError': True}}), 1)

    def test_nested_image_saved_without_printing_base64(self):
        with tempfile.TemporaryDirectory() as root:
            value = {'result': {'content': [{'type': 'image', 'mimeType': 'image/png',
                                           'data': base64.b64encode(b'example image').decode()}]}}
            result = extract_images(value, Path(root))
            item = result['result']['content'][0]
            self.assertNotIn('data', item)
            self.assertEqual(Path(item['artifact']).read_bytes(), b'example image')
            self.assertEqual(Path(item['artifact']).stat().st_mode & 0o777, 0o600)
            self.assertIn('data', value['result']['content'][0])

    def test_process_failure_is_not_tool_success_and_artifacts_never_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            out = Path(root) / 'run'
            result = subprocess.CompletedProcess([], 9, '{"ok":true,"result":{"success":true}}', 'failure')
            with patch('wechatide.subprocess.run', return_value=result) as run:
                with contextlib.redirect_stdout(io.StringIO()):
                    _, status = invoke({'cli': '/wechatide'}, ['project_list'], out, 2)
                self.assertEqual(status, 1)
                self.assertEqual(json.loads((out / 'result.json').read_text())['processExitCode'], 9)
                with self.assertRaises(FileExistsError):
                    invoke({'cli': '/wechatide'}, ['project_list'], out, 2)
                self.assertEqual(run.call_count, 1)


    def test_screenshot_copies_the_exact_remote_path_without_shell_expansion(self):
        with tempfile.TemporaryDirectory() as root:
            config = {'cli': '/wechatide', 'ssh': 'game-host'}
            source = "/tmp/capture's $(ignored).jpg"
            data = b'\xff\xd8\xfftest'
            response = {'result': {'success': True, 'path': source}}
            with patch('wechatide.subprocess.run', return_value=subprocess.CompletedProcess([], 0, data, b'')) as run:
                fetch_screenshot(config, response, Path(root), 10)
            self.assertEqual(shlex.split(run.call_args.args[0][-1]), ['cat', source])
            self.assertEqual(Path(response['result']['artifact']).read_bytes(), data)
            self.assertEqual(response['result']['path'], source)

    def test_process_timeout_retains_raw_output_without_printing_it_or_command_arguments(self):
        with tempfile.TemporaryDirectory() as root:
            tool = Path(root) / 'wechatide'
            tool.write_text(f'#!{sys.executable}\nimport os, time\n'
                            'os.write(1, b"private-stdout\\xff")\n'
                            'os.write(2, b"private-stderr")\n'
                            'time.sleep(10)\n')
            tool.chmod(0o700)
            out = Path(root) / 'timeout'
            printed = io.StringIO()
            with contextlib.redirect_stdout(printed):
                response, status = invoke({'cli': str(tool)},
                                          ['open_project_window', '--project', 'private-argument'],
                                          out, 0.3)
            self.assertEqual(status, 1)
            self.assertFalse(response['ok'])
            self.assertEqual(response['error']['code'], 'process-timeout')
            self.assertEqual((out / 'stdout.txt').read_bytes(), b'private-stdout\xff')
            self.assertEqual((out / 'stderr.txt').read_bytes(), b'private-stderr')
            record = json.loads((out / 'result.json').read_text())
            self.assertTrue(record['timedOut'])
            self.assertIsNone(record['processExitCode'])
            self.assertEqual(record['timeoutSeconds'], 0.3)
            self.assertNotIn('private-', printed.getvalue())
            self.assertNotIn('private-', (out / 'result.json').read_text())
            for name in ['stdout.txt', 'stderr.txt', 'result.json']:
                self.assertEqual((out / name).stat().st_mode & 0o777, 0o600)

    def test_failed_screenshot_transfer_retains_the_successful_tool_response(self):
        with tempfile.TemporaryDirectory() as root:
            result = subprocess.CompletedProcess([], 0, json.dumps({
                'ok': True, 'result': {'success': True, 'path': '/missing/capture.jpg'}}), '')
            with patch('wechatide.subprocess.run', return_value=result):
                with contextlib.redirect_stdout(io.StringIO()):
                    _, status = invoke({'cli': '/wechatide'}, ['simulator_screenshot'], Path(root) / 'run', 2)
            self.assertEqual(status, 1)
            record = json.loads((Path(root) / 'run/result.json').read_text())
            self.assertTrue(record['response']['result']['success'])
            self.assertIn('artifactError', record)

    def test_offline_download_requires_exact_target_and_trusted_origin(self):
        config = {'channels': [{'id': 'nightly', 'version': '1.2.3', 'downloads': [
            {'os': 'macOS', 'arch': 'ARM64', 'url': 'https://devtools.wxqcloud.qq.com.cn/test.pkg'}]}]}
        self.assertEqual(select(config, 'nightly', 'macOS', 'ARM64')['version'], '1.2.3')
        for args in [('stable', 'macOS', 'ARM64'), ('nightly', 'Windows', '64')]:
            with self.assertRaises(ValueError):
                select(config, *args)
        config['channels'][0]['downloads'][0]['url'] = 'http://example.com/untrusted.pkg'
        with self.assertRaises(ValueError):
            select(config, 'nightly', 'macOS', 'ARM64')


if __name__ == '__main__':
    unittest.main()
