import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

from recover_simulator_report import recover, source


class RecoveryTest(unittest.TestCase):
    def exercise(self, mutate=None, *, expected=None):
        raw = json.dumps({'status': 'partial', 'failure': 'CPU validation failed',
                          'text': '\u4e2d\u6587 / \U0001f680'}, ensure_ascii=False).encode()
        operations = []

        def evaluate(fn, directory, cleanup=False):
            args = json.loads(re.search(r'const a = (.*);', fn).group(1))
            operation = args['operation']
            operations.append(operation)
            if mutate:
                special = mutate(operation, args)
                if special is not None:
                    return special
            if operation == 'open':
                return {'operation': 'open', 'bytes': len(raw)}
            if operation == 'close':
                self.assertTrue(cleanup)
                return {'operation': 'close', 'released': True}
            offset, length = args['offset'], args['length']
            return {'operation': 'read', 'offset': offset, 'length': length,
                    'base64': base64.b64encode(raw[offset:offset + length]).decode()}

        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary) / 'recovery'
            result = recover(evaluate, 'http://usr/report.json', len(raw),
                             expected or hashlib.sha256(raw).hexdigest(), out, chunk_bytes=7)
            if result['success']:
                self.assertEqual((out / 'recovered-report.json').read_bytes(), raw)
                self.assertEqual(result['reportStatus'], 'partial')
                self.assertEqual(result['reportFailure'], 'CPU validation failed')
                self.assertFalse(result['cleanFpsEvidence'])
            else:
                self.assertFalse((out / 'recovered-report.json').exists())
            self.assertEqual(operations[-1], 'close')
            return result

    def test_preserves_original_utf8_bytes_and_failure(self):
        self.assertTrue(self.exercise()['success'])

    def test_bad_sha_never_publishes_verified_report(self):
        result = self.exercise(expected='0' * 64)
        self.assertFalse(result['success'])
        self.assertTrue(result['snapshotReleased'])

    def test_wrong_chunk_range_stops_and_cleans_up(self):
        result = self.exercise(lambda op, _: {'operation': 'read', 'offset': 99, 'length': 7}
                               if op == 'read' else None)
        self.assertFalse(result['success'])
        self.assertEqual(result['chunks'], 0)

    def test_ambiguous_open_failure_attempts_cleanup(self):
        def fail(op, _):
            if op == 'open':
                raise ValueError('Truncated official response after remote read')
        result = self.exercise(fail)
        self.assertFalse(result['success'])
        self.assertTrue(result['snapshotReleased'])

    def test_serialized_cleanup_preserves_a_replacement_owner(self):
        program = '''
          const fs = require('node:fs'), vm = require('node:vm');
          const fn = JSON.parse(fs.readFileSync(0, 'utf8'));
          const foreign = {owner:'someone-else'};
          const g = {testKey:foreign};
          const result = vm.runInNewContext('(' + fn + ')()', {GameGlobal:{__gameContextWindow:g}});
          process.stdout.write(JSON.stringify({result,preserved:g.testKey === foreign}));
        '''
        result = subprocess.run(['node', '-e', program], input=json.dumps(source('close', 'testKey')),
                                text=True, capture_output=True, check=True)
        value = json.loads(result.stdout)
        self.assertTrue(value['preserved'])
        self.assertEqual(value['result'], {'operation': 'close', 'released': False, 'conflict': True})

    def test_serialized_js_reads_exact_bytes_without_native_base64_api(self):
        raw = bytes(range(256)) * 130
        calls = [source('open', 'testKey', path='http://usr/report.json', bytes=len(raw))]
        ranges = [(0, 32768), (32768, len(raw) - 32768), (0, 1), (1, 2)]
        calls += [source('read', 'testKey', offset=o, length=n) for o, n in ranges]
        calls += [source('close', 'testKey')]
        program = '''
          const fs = require('node:fs');
          const vm = require('node:vm');
          const input = JSON.parse(fs.readFileSync(0, 'utf8'));
          const raw = Uint8Array.from(Buffer.from(input.base64, 'base64')).buffer;
          const g = {wx: {env: {USER_DATA_PATH:'http://usr'},
            getFileSystemManager: () => ({readFileSync: () => raw})}};
          const context = vm.createContext({GameGlobal:{__gameContextWindow:g}});
          const replies = input.calls.map(fn => vm.runInContext('(' + fn + ')()', context));
          process.stdout.write(JSON.stringify({replies, released:!('testKey' in g)}));
        '''
        result = subprocess.run(['node', '-e', program], input=json.dumps({
            'base64': base64.b64encode(raw).decode(), 'calls': calls}),
            text=True, capture_output=True, check=True)
        output = json.loads(result.stdout)
        for reply, (offset, length) in zip(output['replies'][1:-1], ranges):
            self.assertEqual(base64.b64decode(reply['base64']), raw[offset:offset + length])
        self.assertTrue(output['released'])


if __name__ == '__main__':
    unittest.main()
