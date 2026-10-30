#!/usr/bin/env python3
"""Drive a real X11 mouse and inspect native screen pixels; never present readback."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time
from PIL import ImageGrab


def window_tree(xid):
    lib = ctypes.CDLL("libX11.so.6")
    U, I, N, P = ctypes.c_ulong, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p
    lib.XOpenDisplay.argtypes = [ctypes.c_char_p]
    lib.XOpenDisplay.restype = P
    lib.XQueryTree.argtypes = [P, U, ctypes.POINTER(U), ctypes.POINTER(U),
                              ctypes.POINTER(ctypes.POINTER(U)), ctypes.POINTER(N)]
    lib.XGetGeometry.argtypes = [P, U, ctypes.POINTER(U), ctypes.POINTER(I), ctypes.POINTER(I),
                                ctypes.POINTER(N), ctypes.POINTER(N), ctypes.POINTER(N), ctypes.POINTER(N)]
    lib.XFree.argtypes = [P]
    lib.XCloseDisplay.argtypes = [P]
    display = lib.XOpenDisplay(None)
    if not display:
        raise RuntimeError("An X11 display is required")

    def node(window, depth=0):
        root, parent, children, count = U(), U(), ctypes.POINTER(U)(), N()
        x, y, width, height, border, bits = I(), I(), N(), N(), N(), N()
        lib.XGetGeometry(display, window, ctypes.byref(root), ctypes.byref(x), ctypes.byref(y),
                         ctypes.byref(width), ctypes.byref(height), ctypes.byref(border), ctypes.byref(bits))
        lib.XQueryTree(display, window, ctypes.byref(root), ctypes.byref(parent),
                      ctypes.byref(children), ctypes.byref(count))
        result = {"id": window, "parent": parent.value, "x": x.value, "y": y.value,
                  "width": width.value, "height": height.value, "depth": bits.value,
                  "children": [node(children[i], depth + 1) for i in range(count.value)] if depth < 8 else []}
        if children:
            lib.XFree(children)
        return result

    try:
        return node(int(xid))
    finally:
        lib.XCloseDisplay(display)


fixture = Path(__file__).resolve().parent
output = Path(os.environ.get("NATIVE_WINDOW_EVIDENCE", "artifacts/tauri-native-host")).resolve()
output.mkdir(parents=True, exist_ok=True)
if (output / "progress.json").exists():
    raise SystemExit("Use a fresh evidence directory")
env = dict(os.environ, NATIVE_WINDOW_EVIDENCE=str(output), NATIVE_WINDOW_HOLD_MS="1200")
start, seen, screenshots, stages = time.monotonic(), set(), {}, []
error = None
with (output / "stdout.log").open("w") as log:
    child = subprocess.Popen(["node", str(fixture / "smoke.mjs")], env=env,
                             stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        while child.poll() is None and time.monotonic() - start < 90:
            progress = output / "progress.json"
            if progress.exists():
                try:
                    facts = json.loads(progress.read_text())
                except json.JSONDecodeError:
                    time.sleep(0.05)
                    continue
                stage = facts["stage"]
                if stage not in seen:
                    seen.add(stage)
                    found = subprocess.run(["xdotool", "search", "--name", "^ForgeAX native TypeScript World$"],
                                           env=env, capture_output=True, text=True, check=True)
                    windows = found.stdout.split()
                    assert len(windows) == 1, f"Expected one top-level: {windows}"
                    tree = window_tree(windows[0])
                    image = ImageGrab.grab(xdisplay=env["DISPLAY"]).convert("RGB")
                    digest = hashlib.sha256(image.tobytes()).hexdigest()
                    panel = image.crop((16, 16, 256, 196))
                    native = image.crop((270, 60, 620, 320))
                    green = sum(max(abs(rgb[i] - [94, 224, 177][i]) for i in range(3)) <= 13
                                for rgb in panel.getdata())
                    triangle = sum(max(rgb) - min(rgb) < 8 and 175 <= min(rgb) <= 205
                                   for rgb in native.getdata())
                    children = tree["children"]
                    sibling_drawables = (any(c["width"] == facts["display"]["width"] and
                                              c["height"] == facts["display"]["height"] for c in children)
                                         and any(c["width"] == 240 and c["height"] == 180 for c in children))
                    visible = green >= 256 and triangle >= 2000 and sibling_drawables
                    if digest not in screenshots and (stage in ("ui-ready", "ui-action-native-moved") or not visible):
                        path = output / (stage + ".png")
                        image.save(path)
                        screenshots[digest] = str(path)
                    stages.append({"stage": stage, "screenshot": screenshots.get(digest), "pixelSha256": digest, "tree": tree,
                                   "buttonGreenPixels": green, "nativeTrianglePixels": triangle,
                                   "siblingDrawables": sibling_drawables})
                    assert visible, stages[-1]
                    if stage == "ui-ready":
                        subprocess.run(["xdotool", "mousemove", "--window", windows[0], "110", "90"],
                                       env=env, check=True)
                        subprocess.run(["xdotool", "click", "1"], env=env, check=True)
            time.sleep(0.05)
        assert child.poll() is not None, "Native fixture exceeded 90 seconds"
        assert child.returncode == 0, f"Native fixture exit {child.returncode}"
        assert len(stages) == 5, f"Missing visible checkpoints: {seen}"
        assert len({stage["tree"]["id"] for stage in stages}) == 1, "Top-level changed during lifecycle"
        assert stages[1]["nativeTrianglePixels"] > stages[0]["nativeTrianglePixels"] + 1000, "Triangle did not visibly move"
    except Exception as cause:
        error = str(cause)
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
report = {"exitCode": child.returncode, "seconds": time.monotonic() - start, "pid": child.pid,
          "display": env["DISPLAY"], "stages": stages, "visibleAcceptance": error is None, "error": error,
          "environment": {key: env.get(key) for key in ["NATIVE_TAURI_ADDON", "VK_DRIVER_FILES",
                                                       "GALLIUM_DRIVER", "LIBGL_ALWAYS_SOFTWARE"]}}
(output / "run.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"output": str(output), "seconds": report["seconds"], "visibleAcceptance": error is None, "error": error}))
if error:
    print((output / "stdout.log").read_text()[-5000:])
raise SystemExit(0 if error is None else 1)
