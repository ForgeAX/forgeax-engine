#!/usr/bin/env python3
"""Run a bounded four-contact gameplay timeline through the official scrcpy server.

Run on the ADB-owning machine. Socket writes are not acknowledgements of native
input or gameplay. This driver records dispatch and guard costs separately.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import signal
import struct
import subprocess
import threading
import time

from android_game_capture import input_target
from android_game_input import validate_capture_target
from scrcpy_handshake import control_session
from wechatide import ToolFailure


ROLES = {1: 'move', 2: 'look', 3: 'run', 4: 'jump'}


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def validate_timeline(value, width, height):
    """Validate the shared snapshot format at the native device-pixel boundary."""
    if not isinstance(value, dict) or value.get('schemaVersion') != 'forgeax-gameplay-input/1':
        raise ToolFailure('Expected forgeax-gameplay-input/1 timeline')
    space = value.get('coordinateSpace')
    if (not isinstance(space, dict) or space != {'width': width, 'height': height, 'unit': 'device-px'}
            or type(space['width']) is not int or type(space['height']) is not int):
        raise ToolFailure('Timeline must use this capture\'s exact device-px display')
    duration = value.get('durationMs')
    if not number(duration) or not 1 <= duration <= 120_000:
        raise ToolFailure('Timeline duration must be between 1 and 120000 ms')
    phases = value.get('phases')
    if not isinstance(phases, list) or len(phases) != 4:
        raise ToolFailure('Timeline requires walk/run/jump/run-jump phases')
    previous = 0
    for name, phase in zip(('walk', 'run', 'jump', 'run-jump'), phases):
        if (not isinstance(phase, dict) or phase.get('name') != name
                or not number(phase.get('startMs')) or not number(phase.get('endMs'))
                or not previous == phase['startMs'] < phase['endMs'] <= duration):
            raise ToolFailure('Invalid, unordered or non-contiguous gameplay phase')
        previous = phase['endMs']
    if previous != duration:
        raise ToolFailure('Gameplay phases must cover durationMs')
    events = value.get('events')
    if not isinstance(events, list) or not 2 <= len(events) <= 20_000:
        raise ToolFailure('Timeline requires 2..20000 contact snapshots')
    previous = -1
    for event in events:
        if (not isinstance(event, dict) or not number(event.get('atMs'))
                or not previous < event['atMs'] <= duration):
            raise ToolFailure('Contact snapshots must have strictly increasing finite times')
        contacts = event.get('contacts')
        if not isinstance(contacts, list) or len(contacts) > 4:
            raise ToolFailure('At most four independent contacts are supported')
        seen = set()
        for contact in contacts:
            if not isinstance(contact, dict):
                raise ToolFailure('Invalid contact')
            pointer = contact.get('id')
            if (type(pointer) is not int or pointer not in ROLES or pointer in seen
                    or contact.get('role') != ROLES[pointer]):
                raise ToolFailure('Contacts require unique fixed IDs: 1 move, 2 look, 3 run, 4 jump')
            for field, extent in [('x', width), ('y', height)]:
                if type(contact.get(field)) is not int or not 0 <= contact[field] < extent:
                    raise ToolFailure('Contact must use integer coordinates inside the captured display')
            seen.add(pointer)
        previous = event['atMs']
    if events[0]['atMs'] != 0 or events[-1]['atMs'] != duration or events[-1]['contacts']:
        raise ToolFailure('Timeline must start at 0 and end with all contacts released at durationMs')
    return value


def touch_packet(action, contact, width, height):
    return struct.pack('>BBQiiHHHII', 2, action, contact['id'], contact['x'], contact['y'],
                       width, height, 0 if action == 1 else 0xffff, 0, 0)


def summary(values):
    ordered = sorted(values)
    if not ordered:
        return {'count': 0, 'mean': None, 'p95': None, 'p99': None, 'max': None}
    return {'count': len(ordered), 'mean': sum(ordered) / len(ordered),
            'p95': ordered[math.ceil(len(ordered) * .95) - 1],
            'p99': ordered[math.ceil(len(ordered) * .99) - 1], 'max': ordered[-1]}


class StopInput(Exception):
    pass


class TargetGuard:
    """One sparse observer; no ADB operation is performed on the dispatch thread."""
    def __init__(self, observe, expected, cancellation, period_ms=1000, max_age_ms=2500):
        self.observe = observe
        self.expected = expected
        self.cancellation = cancellation
        self.period_ms = period_ms
        self.max_age_ms = max_age_ms
        self.closed = threading.Event()
        self.lock = threading.Lock()
        self.thread = None
        self.last_started = None
        self.failure = None
        self.samples = []

    def sample(self):
        started = time.monotonic()
        failure = None
        try:
            current = self.observe()
            if current != self.expected:
                fields = [key for key in self.expected if current.get(key) != self.expected[key]]
                raise ToolFailure('Target changed: ' + ', '.join(fields))
        except Exception as error:
            if self.closed.is_set():
                return  # A shutdown-interrupted read is not a target mismatch.
            failure = f'{type(error).__name__}: {str(error)[:512]}'
        ended = time.monotonic()
        with self.lock:
            self.samples.append({'startedMonotonicMs': started * 1000,
                                 'durationMs': (ended - started) * 1000,
                                 'matched': failure is None})
            if failure:
                self.failure = failure
            else:
                # The oldest field was observed near sample start, not sample end.
                self.last_started = started

    def check(self):
        if self.cancellation.is_set():
            raise StopInput('cancelled')
        with self.lock:
            if self.failure:
                raise StopInput('guard-failed: ' + self.failure)
            if self.last_started is None or (time.monotonic() - self.last_started) * 1000 > self.max_age_ms:
                raise StopInput('guard-stale')

    def start(self):
        self.sample()  # After server setup, before timeline's timing origin.
        self.check()

        def poll():
            while not self.closed.wait(self.period_ms / 1000):
                self.sample()
                if self.failure or self.cancellation.is_set():
                    break
        self.thread = threading.Thread(target=poll, name='scrcpy-target-guard', daemon=True)
        self.thread.start()

    def close(self, timeout):
        self.closed.set()
        if self.thread:
            self.thread.join(timeout)
            if self.thread.is_alive():
                raise ToolFailure('Owned guard did not stop within its command timeout')

    def receipt(self):
        with self.lock:
            return {'periodMs': self.period_ms, 'maxAgeMs': self.max_age_ms,
                    'costMs': summary([sample['durationMs'] for sample in self.samples]),
                    'samples': list(self.samples), 'failure': self.failure,
                    'stopped': self.thread is None or not self.thread.is_alive()}


def dispatch_timeline(connection, timeline, check, cancellation, max_lateness_ms=100,
                      start_monotonic=None):
    """Diff snapshots, sending only native touch packets; release even after a guard stop."""
    held = {}
    stream_usable = True
    attempted = sent = cleanup_sent = 0
    send_costs, lateness = [], []
    prepared = time.monotonic()
    started = prepared if start_monotonic is None else start_monotonic
    if not number(started) or not 0 <= started - prepared <= 10:
        raise ToolFailure('External timeline start must be within the next 10 seconds')
    result = {'state': 'dispatched', 'startedAtUnixMs': (time.time() + started - prepared) * 1000,
              'startedMonotonicMs': started * 1000, 'eventsDispatched': 0,
              'phases': timeline['phases']}
    width, height = timeline['coordinateSpace']['width'], timeline['coordinateSpace']['height']
    connection.settimeout(.25)

    def send(action, contact, cleanup=False):
        nonlocal attempted, sent, cleanup_sent, stream_usable
        # A failed DOWN may already have reached Android, so retain it for cleanup.
        if action == 0:
            held[contact['id']] = contact
        attempted += 1
        before = time.monotonic()
        try:
            connection.sendall(touch_packet(action, contact, width, height))
        except OSError:
            # sendall may have sent a partial packet; further packets could corrupt
            # framing. Do not reconnect/replay or claim releases on a broken stream.
            stream_usable = False
            raise
        finally:
            send_costs.append((time.monotonic() - before) * 1000)
        sent += 1
        cleanup_sent += int(cleanup)
        if action == 1:
            held.pop(contact['id'], None)
        else:
            held[contact['id']] = contact

    try:
        for event in timeline['events']:
            deadline = started + event['atMs'] / 1000
            while True:
                check()
                if cancellation.is_set():
                    raise StopInput('cancelled')
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                cancellation.wait(min(remaining, .02))
            late = (time.monotonic() - deadline) * 1000
            lateness.append(late)
            if late > max_lateness_ms:
                raise StopInput('dispatch-deadline-missed')
            next_contacts = {contact['id']: contact for contact in event['contacts']}
            # Release removed contacts before adding or moving any next contacts.
            for pointer in sorted(set(held) - set(next_contacts)):
                check()
                send(1, held[pointer])
            for pointer, contact in sorted(next_contacts.items()):
                check()
                if pointer not in held:
                    send(0, contact)
                elif (held[pointer]['x'], held[pointer]['y']) != (contact['x'], contact['y']):
                    send(2, contact)
            result['eventsDispatched'] += 1
    except StopInput as error:
        result.update(state='cancelled' if str(error) == 'cancelled' else 'stopped', reason=str(error))
    except Exception as error:
        result.update(state='failed', reason=f'{type(error).__name__}: {str(error)[:512]}')
    finally:
        result['heldAtStop'] = sorted(held)
        for pointer in sorted(held):
            if not stream_usable:
                break
            try:
                send(1, held[pointer], cleanup=True)
            except Exception as error:
                result.update(state='failed', releaseError=f'{type(error).__name__}: {str(error)[:512]}')
                break
        result.update({
            'durationMs': (time.monotonic() - started) * 1000,
            'attemptedMessages': attempted, 'dispatchedMessages': sent,
            'cleanupUpMessages': cleanup_sent, 'unreleasedPointerIds': sorted(held),
            'releaseStatus': ('unknown' if held or not stream_usable else
                              'up-messages-dispatched' if sent else 'no-contact-started'),
            'sendCostMs': summary(send_costs), 'eventLatenessMs': summary(lateness),
            'maxLatenessMs': max_lateness_ms,
            'qualification': 'Socket dispatch only; no per-touch ACK or gameplay/performance pass.',
        })
    return result


def verify_inputs(serial, captured, manifest, screenshot, timeline):
    expected = validate_capture_target(captured, serial)
    selected = json.loads(manifest)
    if (hashlib.sha256(manifest).hexdigest() != captured['selectedManifestSha256']
            or not isinstance(selected, dict) or selected.get('target') != 'wechat'):
        raise ToolFailure('Selected WeChat manifest differs from the prepared capture')
    if (hashlib.sha256(screenshot).hexdigest() != captured['screenshotSha256']
            or len(screenshot) < 24 or not screenshot.startswith(b'\x89PNG\r\n\x1a\n')
            or struct.unpack('!II', screenshot[16:24]) != (expected['width'], expected['height'])):
        raise ToolFailure('Prepared screenshot hash or display extent does not match the capture')
    validate_timeline(timeline, expected['width'], expected['height'])
    return expected


def perform_timeline(adb, serial, cache, captured, manifest, screenshot, timeline, cancellation,
                     guard_period_ms=1000, max_guard_age_ms=2500, command_timeout=2,
                     max_lateness_ms=100, start_capture=None):
    receipt = {'state': 'blocked', 'attempted': False,
               'observedAtUtc': datetime.now(timezone.utc).isoformat()}
    guard = None
    try:
        if not Path(adb).is_absolute() or not Path(cache).is_absolute():
            raise ToolFailure('ADB and server cache paths must be absolute on the ADB machine')
        if (not number(guard_period_ms) or not 250 <= guard_period_ms <= 5000
                or not number(max_guard_age_ms) or not guard_period_ms < max_guard_age_ms <= 10000
                or not number(command_timeout) or not 0 < command_timeout <= 5
                or not number(max_lateness_ms) or not 1 <= max_lateness_ms <= 1000):
            raise ToolFailure('Invalid guard interval, freshness, command timeout or dispatch lateness bound')
        expected = verify_inputs(serial, captured, manifest, screenshot, timeline)
        receipt.update(serial=serial, captureTarget=expected,
                       selectedManifestSha256=captured['selectedManifestSha256'],
                       screenshotSha256=captured['screenshotSha256'])

        def read(arguments):
            if cancellation.is_set() or (guard is not None and guard.closed.is_set()):
                raise StopInput('cancelled')
            response = subprocess.run([adb, '-s', serial, *arguments], capture_output=True,
                                      timeout=command_timeout, check=False)
            if response.returncode:
                raise ToolFailure(f'ADB guard {arguments[0]} failed ({response.returncode})')
            if len(response.stdout) > 8 * 1024 * 1024:
                raise ToolFailure('ADB guard output exceeds 8 MiB')
            return response.stdout

        guard = TargetGuard(lambda: input_target(read, captured['activity']), expected,
                            cancellation, guard_period_ms, max_guard_age_ms)
        guard.sample()
        guard.check()  # Reject another app before server installation/connection.

        def execute(connection):
            result = None
            try:
                guard.start()
                start = start_capture() if start_capture else None
                result = dispatch_timeline(connection, timeline, guard.check, cancellation,
                                           max_lateness_ms, start_monotonic=start)
                receipt['attempted'] = result['attemptedMessages'] > 0
                return result
            finally:
                try:
                    guard.close(command_timeout + 1)
                except Exception as error:
                    if result is None:
                        raise
                    result.update(state='failed', guardCleanupError=str(error)[:512])

        receipt['session'] = control_session(adb, serial, Path(cache), execute)
        execution = receipt['session'].get('execution')
        if execution:
            receipt['state'] = execution['state']
        if receipt['session']['status'] != 'control-session-closed':
            receipt['state'] = 'failed'
        receipt['retryAutomatically'] = False
    except Exception as error:
        receipt['error'] = f'{type(error).__name__}: {str(error)[:1024]}'
    finally:
        if guard:
            try:
                guard.close(command_timeout + 1)
            except Exception as error:
                receipt.update(state='failed', cleanupError=str(error)[:512])
            receipt['guard'] = guard.receipt()
    return receipt, 0 if receipt['state'] == 'dispatched' else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--adb', required=True, help='Absolute local ADB executable')
    parser.add_argument('--serial', required=True, help='Explicit authorized device; retained privately')
    parser.add_argument('--cache', required=True, type=Path, help='Private absolute server cache')
    parser.add_argument('--capture-result', required=True, type=Path, help='Reviewed --for-input capture result')
    parser.add_argument('--screenshot', required=True, type=Path, help='Exact prepared capture PNG')
    parser.add_argument('--manifest', required=True, type=Path, help='Selected immutable forgeax-dist.json')
    parser.add_argument('--timeline', required=True, type=Path, help='Shared gameplay-input/1 device-px JSON')
    parser.add_argument('--out', required=True, type=Path, help='New private absolute output directory')
    parser.add_argument('--guard-period-ms', type=float, default=1000)
    parser.add_argument('--max-guard-age-ms', type=float, default=2500)
    parser.add_argument('--command-timeout', type=float, default=2)
    parser.add_argument('--max-lateness-ms', type=float, default=100)
    args = parser.parse_args()
    if not args.out.is_absolute():
        parser.error('--out must be absolute')
    args.out.mkdir(parents=True, exist_ok=False, mode=0o700)
    cancellation = threading.Event()
    previous_signals = {kind: signal.signal(kind, lambda *_: cancellation.set())
                        for kind in (signal.SIGINT, signal.SIGTERM)}
    try:
        def bounded(path, limit):
            with path.open('rb') as source:
                data = source.read(limit + 1)
            if len(data) > limit:
                raise ToolFailure(path.name + ' exceeds its input size bound')
            return data

        capture_bytes = bounded(args.capture_result, 65536)
        timeline_bytes = bounded(args.timeline, 8 * 1024 * 1024)
        result, code = perform_timeline(
            args.adb, args.serial, args.cache, json.loads(capture_bytes),
            bounded(args.manifest, 8 * 1024 * 1024), bounded(args.screenshot, 64 * 1024 * 1024),
            json.loads(timeline_bytes), cancellation, args.guard_period_ms, args.max_guard_age_ms,
            args.command_timeout, args.max_lateness_ms,
        )
        result.update(captureResultSha256=hashlib.sha256(capture_bytes).hexdigest(),
                      timelineSha256=hashlib.sha256(timeline_bytes).hexdigest())
    except Exception as error:
        result, code = {'state': 'blocked', 'attempted': False, 'error': str(error)[:1024]}, 1
    finally:
        for kind, handler in previous_signals.items():
            signal.signal(kind, handler)
    artifact = args.out / 'result.json'
    artifact.write_text(json.dumps(result, indent=2) + '\n')
    artifact.chmod(0o600)
    print(json.dumps({'state': result['state'], 'attempted': result['attempted'],
                      'artifact': str(artifact)}))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
