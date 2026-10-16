"""Hide/show the real View window on the probe's private Xvfb display."""
import ctypes as c
import json
import sys

x = c.CDLL('libX11.so.6')
x.XOpenDisplay.argtypes = [c.c_char_p]
x.XOpenDisplay.restype = c.c_void_p
x.XDefaultRootWindow.argtypes = [c.c_void_p]
x.XDefaultRootWindow.restype = c.c_ulong
x.XQueryTree.argtypes = [c.c_void_p, c.c_ulong, c.POINTER(c.c_ulong), c.POINTER(c.c_ulong), c.POINTER(c.POINTER(c.c_ulong)), c.POINTER(c.c_uint)]
x.XGetGeometry.argtypes = [c.c_void_p, c.c_ulong, c.POINTER(c.c_ulong), c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(c.c_uint), c.POINTER(c.c_uint), c.POINTER(c.c_uint), c.POINTER(c.c_uint)]
x.XMapWindow.argtypes = x.XUnmapWindow.argtypes = [c.c_void_p, c.c_ulong]
x.XSync.argtypes = [c.c_void_p, c.c_int]
x.XCloseDisplay.argtypes = [c.c_void_p]
x.XFree.argtypes = [c.c_void_p]
display = x.XOpenDisplay(None)
if not display:
    raise RuntimeError('Run the browser probe under its own xvfb-run display.')
root, parent, count = c.c_ulong(), c.c_ulong(), c.c_uint()
children = c.POINTER(c.c_ulong)()
windows = []
try:
    if not x.XQueryTree(display, x.XDefaultRootWindow(display), c.byref(root), c.byref(parent), c.byref(children), c.byref(count)):
        raise RuntimeError('Cannot enumerate native test windows.')
    for index in range(count.value):
        window = children[index]
        left, top, width, height, border, depth = c.c_int(), c.c_int(), c.c_uint(), c.c_uint(), c.c_uint(), c.c_uint()
        if x.XGetGeometry(display, window, c.byref(root), c.byref(left), c.byref(top), c.byref(width), c.byref(height), c.byref(border), c.byref(depth)) and width.value >= 500 and height.value >= 300:
            (x.XUnmapWindow if sys.argv[1] == 'hide' else x.XMapWindow)(display, window)
            windows.append(window)
    x.XSync(display, 0)
    print(json.dumps(windows))
finally:
    if children:
        x.XFree(children)
    x.XCloseDisplay(display)
