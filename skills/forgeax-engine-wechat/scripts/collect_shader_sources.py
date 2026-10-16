#!/usr/bin/env python3
"""Collect bounded shader-source pages from an explicitly selected active project."""
import argparse
import contextlib
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid

from wechatide import ToolFailure, invoke, load_config


PROBE = '__forgeaxShaderSourceProbe'
OWNER = '__forgeaxHostCollector'
MAX_SOURCE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 16 * 1024 * 1024


def integer(value, minimum=0, maximum=2**53 - 1):
    return type(value) is int and minimum <= value <= maximum


def utf16_length(text):
    return len(text.encode('utf-16-le', errors='surrogatepass')) // 2


def source_bytes(text):
    # Match JavaScript TextEncoder/Node Buffer for lone UTF-16 surrogates too.
    return text.encode('utf-16-le', errors='surrogatepass').decode('utf-16-le', errors='replace').encode('utf-8')


def identity(path, data):
    return {'file': path.name, 'bytes': len(data), 'digest': 'sha256:' + hashlib.sha256(data).hexdigest()}


def write_json(path, value):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=True, indent=2) + '\n', encoding='utf-8')
    temporary.chmod(0o600)
    temporary.replace(path)


def selector_bindings(selector):
    return '''function(){
      const canvases=GameGlobal.document.querySelectorAll(SELECTOR);
      if(canvases.length!==1) throw Error('canvas selector must match exactly one canvas');
      return {canvas:canvases[0],readReceipt:()=>GameGlobal.__gameContextWindow.__forgeaxGameInspection.renderer()};
    }'''.replace('SELECTOR', json.dumps(selector))


def evaluation(request, installer=None, plan=None, bindings=None):
    """One official evaluation; the owner marker lives only on this probe instance."""
    if request['operation'] == 'install':
        operation = ("if(globalThis[KEY]) return {status:'already-installed'};const bindings=(" + bindings + ')();'
                     'const report=(' + installer.strip() + ')({...bindings,plan:' + json.dumps(plan, separators=(',', ':')) + '});'
                     'if(globalThis[KEY]) Object.defineProperty(globalThis[KEY],OWNER,{value:request.collectionId,configurable:true});'
                     'return {collectionId:request.collectionId,report};')
    else:
        operation = '''
          const probe=globalThis[KEY];
          if(!probe) return request.operation==='release'?{released:true,absent:true}:{status:'probe-absent'};
          if(probe[OWNER]!==request.collectionId) return {status:'probe-owner-changed'};
          if(request.operation==='release') return probe.release();
          if(request.operation==='summary') return probe.report();
          if(request.operation==='draws') return probe.readDraws(request.offset,request.count);
          if(request.operation==='source') return probe.readSource(request.ordinal,request.stage,request.kind,request.offset,request.count);
          if(request.operation==='programs') {
            const total=probe.report().expectedPrograms;
            const rows=Array.from({length:Math.min(request.count,total-request.offset)},(_,i)=>probe.program(request.offset+i+1));
            const page={offset:request.offset,total,rows,nextOffset:request.offset+rows.length};
            const text=JSON.stringify({ok:true,tool:'automation_evaluate',clientName:'Codex',result:{success:true,result:page}},null,2);
            const bytes=value=>{
              let size=0;for(let i=0;i<value.length;i++){
                const c=value.charCodeAt(i);
                if(c<128)size++;else if(c<2048)size+=2;
                else if(c>=0xd800&&c<=0xdbff&&i+1<value.length&&value.charCodeAt(i+1)>=0xdc00&&value.charCodeAt(i+1)<=0xdfff){size+=4;i++;}
                else size+=3;
              }return size;
            };
            if(Math.max(bytes(text),bytes(JSON.stringify(text)))+4096>32768) return {status:'page-too-large',retryCount:Math.max(1,Math.floor(request.count/2))};
            return page;
          }
          return {status:'unknown-operation'};
        '''
    return ('function(){const KEY=' + json.dumps(PROBE) + ',OWNER=' + json.dumps(OWNER) + ';'
            'function operate(request){' + operation + '}return operate('
            + json.dumps(request, separators=(',', ':')) + ');}')


def unwrap(response, status):
    if status or not isinstance(response, dict) or response.get('ok') is not True:
        raise ToolFailure(f'official evaluation failed (status {status}); retain call result')
    result = response.get('result')
    if not isinstance(result, dict) or result.get('success') is not True or not isinstance(result.get('result'), dict):
        raise ToolFailure('official evaluation did not return a successful object')
    return result['result']


def validate_summary(report, plan, terminal=False):
    if (not isinstance(report, dict) or report.get('kind') != 'bounded-aligned-shader-sources'
            or report.get('source') != plan.get('source')
            or report.get('expectedOperations') != len(plan['operations'])
            or report.get('expectedPrograms') != len(plan['programs'])
            or report.get('selectedPrograms') != plan['selectedPrograms']):
        raise ToolFailure('probe summary differs from the prepared plan')
    if terminal and (report.get('phase') != 'done' or report.get('status') not in ('complete', 'partial')
                     or report.get('methodsRestored') is not True or report.get('restoreFailures') != 0
                     or report.get('retainedProgramHandles') != 0
                     or report.get('observedOperations') != report['expectedOperations']
                     or report.get('observedDraws') != report.get('expectedDraws')):
        raise ToolFailure('collector did not finish a matched frame with restored methods: ' + str(report.get('status')))


def collect(config, project, prepared, out, *, canvas_selector=None, bindings_source=None, deadline_seconds=300):
    if not isinstance(project, str) or not project.startswith('/'):
        raise ToolFailure('project must be an explicit absolute active-project path')
    if bool(canvas_selector) == bool(bindings_source):
        raise ToolFailure('provide exactly one canvas selector or bindings function source')
    if not 10 <= deadline_seconds <= 3600:
        raise ToolFailure('deadline must be between 10 and 3600 seconds')
    prepared, out = Path(prepared), Path(out)
    installer_bytes = (prepared / 'install.js').read_bytes()
    plan_bytes = (prepared / 'plan.json').read_bytes()
    installer, plan = installer_bytes.decode('utf-8'), json.loads(plan_bytes)
    if (not isinstance(plan, dict) or plan.get('version') != 1 or not isinstance(plan.get('operations'), list)
            or not 2 <= len(plan['operations']) <= 512 or not isinstance(plan.get('programs'), list)
            or not 1 <= len(plan['programs']) <= 32 or not isinstance(plan.get('selectedPrograms'), list)
            or not plan['selectedPrograms'] or len(set(plan['selectedPrograms'])) != len(plan['selectedPrograms'])
            or any(not integer(value, 1, len(plan['programs'])) for value in plan['selectedPrograms'])):
        raise ToolFailure('prepared directory must come from shader_sources.mjs')
    bindings = bindings_source or selector_bindings(canvas_selector)
    out.mkdir(parents=True, exist_ok=False, mode=0o700)
    started = time.monotonic()
    deadline = started + deadline_seconds
    cleanup_reserve = min(15, deadline_seconds / 3)
    work_deadline = deadline - cleanup_reserve
    collection_id = uuid.uuid4().hex
    assembled = {'report': None, 'programs': [], 'draws': [], 'sources': []}
    active_source = None
    result = {'success': False, 'project': project, 'collectionId': collection_id, 'deadlineSeconds': deadline_seconds,
              'cleanupReserveSeconds': cleanup_reserve, 'prepared': {
                  'installer': identity(prepared / 'install.js', installer_bytes),
                  'plan': identity(prepared / 'plan.json', plan_bytes)}, 'released': False}
    calls = 0
    install_attempted = False
    transfer_complete = False

    def save_partial():
        value = dict(assembled)
        if active_source is not None:
            value['inProgressSource'] = {key: item for key, item in active_source.items() if key != 'chunks'} | {'text': ''.join(active_source['chunks'])}
        write_json(out / 'assembled.partial.json', value)
        write_json(out / 'result.json', result)

    def call(operation, *, retry=True, cleanup=False, **parameters):
        nonlocal calls
        request = {'operation': operation, 'collectionId': collection_id, **parameters}
        source = evaluation(request, installer, plan, bindings)
        for attempt in range(3 if retry else 1):
            remaining = (deadline if cleanup else work_deadline) - time.monotonic()
            if remaining <= 0:
                raise ToolFailure('overall deadline exhausted' if cleanup else 'collection deadline reached; time reserved for release')
            calls += 1
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    response, status = invoke(config, ['automation_evaluate', '--project', project, '--fn-source', source], out / f'call-{calls:05d}-{operation}', min(30, remaining))
                return unwrap(response, status)
            except (ToolFailure, OSError, subprocess.TimeoutExpired) as error:
                if not retry or attempt == 2:
                    raise
                print(json.dumps({'operation': operation, 'retry': attempt + 1, 'offset': parameters.get('offset'), 'reason': str(error)[:200]}), flush=True)
        raise AssertionError('unreachable')

    def page(operation, offset, count, **parameters):
        for _ in range(12):
            value = call(operation, offset=offset, count=count, **parameters)
            if value.get('status') not in ('page-too-large', 'page-too-small'):
                return value, count
            resized = value.get('retryCount')
            if (not integer(resized, 1, 4096 if operation == 'source' else 64)
                    or value['status'] == 'page-too-large' and resized >= count
                    or value['status'] == 'page-too-small' and resized <= count):
                raise ToolFailure('invalid page-size recovery')
            count = resized
        raise ToolFailure('page-size recovery did not converge')

    try:
        save_partial()
        install_attempted = True
        installed = call('install', retry=False)
        result['install'] = installed
        if installed.get('collectionId') != collection_id:
            raise ToolFailure('installation did not acquire this collector: ' + str(installed.get('status')))
        assembled['report'] = installed.get('report')
        validate_summary(assembled['report'], plan)
        while assembled['report'].get('phase') != 'done':
            if work_deadline - time.monotonic() <= 0:
                raise ToolFailure('collection deadline reached; time reserved for release')
            time.sleep(min(0.25, max(0, work_deadline - time.monotonic())))
            assembled['report'] = call('summary')
            validate_summary(assembled['report'], plan)
        report = assembled['report']
        validate_summary(report, plan, terminal=True)
        save_partial()
        print(json.dumps({'phase': 'sources-ready', 'status': report['status'], 'selectedPrograms': report['selectedPrograms']}), flush=True)

        offset, count = 0, 4
        while offset < report['expectedPrograms']:
            value, count = page('programs', offset, count)
            rows = value.get('rows')
            if (value.get('offset') != offset or value.get('total') != report['expectedPrograms'] or not isinstance(rows, list)
                    or not 1 <= len(rows) <= count or value.get('nextOffset') != offset + len(rows)):
                raise ToolFailure('invalid program metadata page')
            for index, program in enumerate(rows):
                expected = plan['programs'][offset + index]
                if (not isinstance(program, dict) or any(program.get(key) != expected.get(key) for key in ('ordinal', 'pipelineId', 'workIndices', 'glEventIndices'))
                        or program.get('selected') != (program.get('ordinal') in report['selectedPrograms']) or not isinstance(program.get('shaders'), list)):
                    raise ToolFailure('program metadata differs from prepared mapping')
            assembled['programs'].extend(rows)
            offset = value['nextOffset']
            save_partial()

        offset, count = 0, 32
        expected_draws = [{'glEventIndex': index, 'workIndex': operation['workIndex'], 'programOrdinal': operation['programOrdinal']}
                          for index, operation in enumerate(plan['operations']) if operation['workIndex'] is not None]
        if len(expected_draws) != report['expectedDraws']:
            raise ToolFailure('draw count differs from prepared plan')
        while offset < len(expected_draws):
            value, count = page('draws', offset, count)
            rows = value.get('rows')
            if (value.get('offset') != offset or value.get('total') != len(expected_draws) or not isinstance(rows, list)
                    or not 1 <= len(rows) <= count or value.get('nextOffset') != offset + len(rows)
                    or rows != expected_draws[offset:offset + len(rows)]):
                raise ToolFailure('draw correspondence changed during transfer')
            assembled['draws'].extend(rows)
            offset = value['nextOffset']
        save_partial()

        total_bytes = 0
        for program in assembled['programs']:
            seen_stages = set()
            for shader in program['shaders']:
                stage = shader.get('stage')
                if stage not in ('vertex', 'fragment') or stage in seen_stages:
                    raise ToolFailure('ambiguous shader stage metadata')
                seen_stages.add(stage)
                for kind in ('original', 'translated'):
                    metadata = shader.get(kind)
                    if not isinstance(metadata, dict) or metadata.get('availability') not in ('available', 'unavailable', 'failed'):
                        raise ToolFailure('invalid source availability metadata')
                    if metadata['availability'] != 'available':
                        continue
                    if not program['selected'] or not integer(metadata.get('chars'), 0, MAX_SOURCE_BYTES) or not integer(metadata.get('utf8Bytes'), 0, MAX_SOURCE_BYTES):
                        raise ToolFailure('invalid or unselected source metadata')
                    active_source = {'ordinal': program['ordinal'], 'stage': stage, 'kind': kind, 'offset': 0,
                                     'totalChars': metadata['chars'], 'utf8Bytes': metadata['utf8Bytes'], 'chunks': []}
                    offset, count = 0, 4096
                    while offset < metadata['chars']:
                        value, count = page('source', offset, count, ordinal=program['ordinal'], stage=stage, kind=kind)
                        text = value.get('text')
                        if (value.get('ordinal') != program['ordinal'] or value.get('stage') != stage or value.get('kind') != kind
                                or value.get('offset') != offset or value.get('totalChars') != metadata['chars'] or value.get('utf8Bytes') != metadata['utf8Bytes']
                                or not isinstance(text, str) or not 1 <= utf16_length(text) <= count
                                or value.get('nextOffset') != offset + utf16_length(text) or value['nextOffset'] > metadata['chars']):
                            raise ToolFailure('invalid source page identity, UTF-16 offset or advertised length')
                        active_source['chunks'].append(text)
                        offset = value['nextOffset']
                        active_source['offset'] = offset
                    text = ''.join(active_source['chunks'])
                    if utf16_length(text) != metadata['chars'] or len(source_bytes(text)) != metadata['utf8Bytes']:
                        raise ToolFailure('source body differs from advertised UTF-16/UTF-8 lengths')
                    total_bytes += metadata['utf8Bytes']
                    if total_bytes > MAX_TOTAL_BYTES:
                        raise ToolFailure('total source byte limit exceeded')
                    assembled['sources'].append({'ordinal': program['ordinal'], 'stage': stage, 'kind': kind, 'text': text})
                    active_source = None
                    save_partial()
                    print(json.dumps({'phase': 'source-collected', 'ordinal': program['ordinal'], 'stage': stage, 'kind': kind, 'bytes': metadata['utf8Bytes']}), flush=True)
        if total_bytes != report.get('totalSourceBytes'):
            raise ToolFailure('total collected source bytes differ from probe report')
        transfer_complete = True
        if report['status'] != 'complete':
            raise ToolFailure('collector returned partial original sources; available bodies were preserved')
    except (Exception, KeyboardInterrupt) as error:
        result['error'] = str(error)[:500] or type(error).__name__
    finally:
        if install_attempted:
            try:
                release = call('release', cleanup=True)
                result['release'] = release
                result['released'] = release.get('released') is True and (release.get('absent') is True or release.get('methodsRestored') is True)
                if not result['released']:
                    result['releaseError'] = 'release did not confirm this probe was removed with methods restored'
            except (Exception, KeyboardInterrupt) as error:
                result['releaseError'] = str(error)[:500] or type(error).__name__
        result.update({'transferComplete': transfer_complete, 'calls': calls, 'elapsedSeconds': time.monotonic() - started,
                       'collectionStatus': assembled.get('report', {}).get('status') if isinstance(assembled.get('report'), dict) else None,
                       'sourceBodies': len(assembled['sources'])})
        result['success'] = transfer_complete and result['released'] and not result.get('error') and not result.get('releaseError')
        if result['success']:
            write_json(out / 'assembled.json', assembled)
            (out / 'assembled.partial.json').unlink(missing_ok=True)
            result['artifact'] = str(out / 'assembled.json')
            write_json(out / 'result.json', result)
        else:
            result['partialArtifact'] = str(out / 'assembled.partial.json')
            save_partial()
    print(json.dumps(result), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--project', required=True)
    parser.add_argument('--prepared', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--deadline', type=float, default=300, help='overall seconds, including reserved cleanup time (default 300)')
    binding = parser.add_mutually_exclusive_group(required=True)
    binding.add_argument('--canvas-selector', help='explicit unique selector in GameGlobal.document; uses the game inspection renderer receipt')
    binding.add_argument('--bindings', type=Path, help='JavaScript function expression returning {canvas, readReceipt}')
    args = parser.parse_args()
    result = collect(load_config(args.config), args.project, args.prepared, args.out,
                     canvas_selector=args.canvas_selector, bindings_source=args.bindings.read_text() if args.bindings else None,
                     deadline_seconds=args.deadline)
    return 0 if result['success'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ToolFailure, OSError, ValueError) as error:
        print(json.dumps({'success': False, 'error': str(error)}), file=sys.stderr)
        sys.exit(1)
