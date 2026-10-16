#!/usr/bin/env python3
"""Observe 60 scene-ready Renderer completions and copy the official simulator screenshot."""
import argparse
import contextlib
import io
import json
import math
from pathlib import Path
import subprocess
import sys
import time

from wechatide import ToolFailure, invoke, load_config, outcome


GAME_STATE = '''function () {
  const game = typeof GameGlobal === 'object' ? GameGlobal.__gameContextWindow : undefined;
  const inspection = game?.__forgeaxGameInspection;
  if (typeof inspection?.renderer !== 'function') return {phase:'waiting-for-game'};
  const state = inspection.renderer();
  return JSON.parse(JSON.stringify({generation:state.generation,phase:state.phase,frame:state.frame,
    completed:state.completed,presented:state.presented,
    startupError:state.startupError,lastError:state.lastError},
    (key,value)=>value&&typeof value.message==='string'
      ? {...value,name:value.name,message:value.message,cause:value.cause}:value));
}'''


def read_state(response):
    """Admit the qualified official evaluation envelope, never driver/transport success alone."""
    result = response.get('result') if isinstance(response, dict) else None
    if (not isinstance(response, dict) or response.get('ok') is not True
            or outcome(response) != 0 or not isinstance(result, dict)
            or result.get('success') is not True):
        raise ToolFailure('game evaluation did not return a completed successful tool envelope')
    state = result.get('result')
    if not isinstance(state, dict) or not isinstance(state.get('phase'), str):
        raise ToolFailure('game evaluation returned no structured Host phase; check the game realm')
    return state


def state_outcome(state):
    if (state.get('phase') == 'failed' or state.get('startupError') is not None
            or state.get('lastError') is not None):
        return 'failed'
    if state.get('phase') != 'ready':
        return 'waiting'
    completed, presented = state.get('completed'), state.get('presented')
    if (type(completed) is not int or type(presented) is not int
            or not 0 <= presented <= completed):
        raise ToolFailure('ready Host state has invalid completed/presented counters')
    return 'ready' if presented >= 60 else 'waiting'


def screenshot_available(response, status):
    result = response.get('result') if isinstance(response, dict) else None
    return (status == 0 and isinstance(response, dict) and response.get('ok') is True and outcome(response) == 0
            and isinstance(result, dict) and result.get('success') is True
            and isinstance(result.get('artifact'), str) and Path(result['artifact']).is_file())


def observe(config, project, directory, timeout):
    if not Path(project).is_absolute():
        raise ToolFailure('project must be an absolute path on the DevTools machine')
    if not math.isfinite(timeout) or not 1 <= timeout <= 1800:
        raise ToolFailure('timeout must be between 1 and 1800 seconds')
    directory.mkdir(parents=True, exist_ok=False, mode=0o700)
    deadline = time.monotonic() + timeout
    state, failure, screenshot = None, None, None
    attempt = 0
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                response, status = invoke(config, ['automation_evaluate', '--project', project,
                    '--fn-source', GAME_STATE], directory / f'state-{attempt:03}', min(30, remaining))
            if status:
                failure = {'kind': 'tool', 'status': status, 'response': response}
                break
            state = read_state(response)
            print(json.dumps(state, ensure_ascii=False), flush=True)
            if state_outcome(state) != 'waiting':
                break
        except (ToolFailure, OSError, ValueError, subprocess.TimeoutExpired) as error:
            failure = {'kind': 'observation', 'message': str(error)}
            break
        attempt += 1
        time.sleep(max(0, min(2, deadline - time.monotonic())))
    if failure is None and (state is None or state_outcome(state) == 'waiting'):
        failure = {'kind': 'timeout', 'message': 'No 60 scene-ready completions before the deadline'}
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            screenshot, screenshot_status = invoke(config,
                ['simulator_screenshot', '--project', project], directory / 'screenshot', 30)
        if not screenshot_available(screenshot, screenshot_status):
            failure = failure or {'kind': 'screenshot', 'status': screenshot_status,
                                  'message': 'No successful locally copied simulator image'}
    except (ToolFailure, OSError, ValueError, subprocess.TimeoutExpired) as error:
        failure = failure or {'kind': 'screenshot', 'message': str(error)}
    passed = failure is None and state is not None and state_outcome(state) == 'ready'
    result = {'readyFramesPassed': passed, 'project': project, 'state': state,
              'screenshot': screenshot}
    if failure is not None:
        result['failure'] = failure
    summary = directory / 'summary.json'
    summary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    summary.chmod(0o600)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path, help='private machine JSON; see tooling.md')
    parser.add_argument('--project', required=True, help='absolute project path on the DevTools machine')
    parser.add_argument('--out', required=True, type=Path, help='new local evidence directory')
    parser.add_argument('--timeout', type=float, default=120,
                        help='observation deadline in seconds; screenshot adds at most 30 seconds')
    args = parser.parse_args()
    result = observe(load_config(args.config), args.project, args.out, args.timeout)
    return 0 if result['readyFramesPassed'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ToolFailure, OSError, ValueError) as error:
        print(json.dumps({'success': False, 'error': str(error)}), file=sys.stderr)
        sys.exit(1)
