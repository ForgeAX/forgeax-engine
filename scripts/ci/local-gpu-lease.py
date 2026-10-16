"""Hold the existing host-wide flock until the owning Node pipe closes."""
import fcntl
import json
import os
import select
import signal
import sys

# Node owns cancellation and native process-tree cleanup. Keep the lease until
# that cleanup finishes and Node closes stdin, including after parent death.
signal.signal(signal.SIGINT, signal.SIG_IGN)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
with open(sys.argv[1], 'a+b') as lease:
    while True:
        if select.select([sys.stdin], [], [], 0)[0] and not os.read(0, 1):
            sys.exit(0)
        try:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            select.select([sys.stdin], [], [], 0.1)
    actual = os.fstat(lease.fileno())
    current = os.stat(sys.argv[1])
    if (actual.st_dev, actual.st_ino) != (current.st_dev, current.st_ino):
        raise RuntimeError('GPU lock file was replaced while queued')
    print(json.dumps({'acquired': True}), flush=True)
    while os.read(0, 1):
        pass
