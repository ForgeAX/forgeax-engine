//! Calling-thread native OS window owner (`winit 0.30.13`) that hands a `wgpu::Surface<'static>`
//! directly to `DedicatedNativeRenderThread` for zero-copy native swapchain presentation, while
//! translating full OS keyboard, pointer, wheel, focus, visibility, and IME events into the
//! ForgeAX `DesktopEvent` contract.
//!
//! Lifetime invariant: `DedicatedNativeRenderThread` MUST detach/drop its `wgpu::Surface<'static>`
//! BEFORE `KernelNativeWindow` drops its `Arc<Window>`.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::Deserialize;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::{Rc, Weak};
use std::sync::Arc;
use std::time::Duration;
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalPosition, LogicalSize, PhysicalSize};
use winit::event::{
    DeviceEvent, DeviceId, ElementState, Ime, KeyEvent, MouseButton, MouseScrollDelta, WindowEvent,
};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::keyboard::{Key, KeyCode, ModifiersState, NamedKey, PhysicalKey};
use winit::platform::pump_events::EventLoopExtPumpEvents;
use winit::window::{CursorGrabMode, Window, WindowAttributes, WindowId};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWindowOptions {
    pub title: String,
    pub width: u32,
    pub height: u32,
}

#[napi(object)]
#[derive(Clone, Default)]
pub struct JsWindowFacts {
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub visible: bool,
}

#[napi(object)]
#[derive(Clone, Default)]
pub struct JsWindowEvent {
    pub kind: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub scale_factor: Option<f64>,
    pub focused: Option<bool>,
    pub visible: Option<bool>,
    pub code: Option<String>,
    pub key: Option<String>,
    pub text: Option<String>,
    pub repeat: Option<bool>,
    pub shift_key: Option<bool>,
    pub ctrl_key: Option<bool>,
    pub alt_key: Option<bool>,
    pub meta_key: Option<bool>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub dx: Option<f64>,
    pub dy: Option<f64>,
    pub button: Option<String>,
    pub generation: Option<u32>,
}

impl JsWindowEvent {
    fn simple(kind: &str) -> Self {
        Self {
            kind: kind.to_owned(),
            ..Default::default()
        }
    }
}

fn physical_key_to_dom_code(key: PhysicalKey) -> Option<String> {
    let PhysicalKey::Code(code) = key else {
        return None;
    };
    let name = match code {
        KeyCode::KeyA => "KeyA",
        KeyCode::KeyB => "KeyB",
        KeyCode::KeyC => "KeyC",
        KeyCode::KeyD => "KeyD",
        KeyCode::KeyE => "KeyE",
        KeyCode::KeyF => "KeyF",
        KeyCode::KeyG => "KeyG",
        KeyCode::KeyH => "KeyH",
        KeyCode::KeyI => "KeyI",
        KeyCode::KeyJ => "KeyJ",
        KeyCode::KeyK => "KeyK",
        KeyCode::KeyL => "KeyL",
        KeyCode::KeyM => "KeyM",
        KeyCode::KeyN => "KeyN",
        KeyCode::KeyO => "KeyO",
        KeyCode::KeyP => "KeyP",
        KeyCode::KeyQ => "KeyQ",
        KeyCode::KeyR => "KeyR",
        KeyCode::KeyS => "KeyS",
        KeyCode::KeyT => "KeyT",
        KeyCode::KeyU => "KeyU",
        KeyCode::KeyV => "KeyV",
        KeyCode::KeyW => "KeyW",
        KeyCode::KeyX => "KeyX",
        KeyCode::KeyY => "KeyY",
        KeyCode::KeyZ => "KeyZ",
        KeyCode::Digit0 => "Digit0",
        KeyCode::Digit1 => "Digit1",
        KeyCode::Digit2 => "Digit2",
        KeyCode::Digit3 => "Digit3",
        KeyCode::Digit4 => "Digit4",
        KeyCode::Digit5 => "Digit5",
        KeyCode::Digit6 => "Digit6",
        KeyCode::Digit7 => "Digit7",
        KeyCode::Digit8 => "Digit8",
        KeyCode::Digit9 => "Digit9",
        KeyCode::Space => "Space",
        KeyCode::Enter => "Enter",
        KeyCode::Escape => "Escape",
        KeyCode::Tab => "Tab",
        KeyCode::Backspace => "Backspace",
        KeyCode::Delete => "Delete",
        KeyCode::ArrowUp => "ArrowUp",
        KeyCode::ArrowDown => "ArrowDown",
        KeyCode::ArrowLeft => "ArrowLeft",
        KeyCode::ArrowRight => "ArrowRight",
        KeyCode::ShiftLeft => "ShiftLeft",
        KeyCode::ShiftRight => "ShiftRight",
        KeyCode::ControlLeft => "ControlLeft",
        KeyCode::ControlRight => "ControlRight",
        KeyCode::AltLeft => "AltLeft",
        KeyCode::AltRight => "AltRight",
        KeyCode::SuperLeft => "MetaLeft",
        KeyCode::SuperRight => "MetaRight",
        KeyCode::Minus => "Minus",
        KeyCode::Equal => "Equal",
        KeyCode::BracketLeft => "BracketLeft",
        KeyCode::BracketRight => "BracketRight",
        KeyCode::Backslash => "Backslash",
        KeyCode::Semicolon => "Semicolon",
        KeyCode::Quote => "Quote",
        KeyCode::Backquote => "Backquote",
        KeyCode::Comma => "Comma",
        KeyCode::Period => "Period",
        KeyCode::Slash => "Slash",
        KeyCode::Home => "Home",
        KeyCode::End => "End",
        KeyCode::PageUp => "PageUp",
        KeyCode::PageDown => "PageDown",
        KeyCode::F1 => "F1",
        KeyCode::F2 => "F2",
        KeyCode::F3 => "F3",
        KeyCode::F4 => "F4",
        KeyCode::F5 => "F5",
        KeyCode::F6 => "F6",
        KeyCode::F7 => "F7",
        KeyCode::F8 => "F8",
        KeyCode::F9 => "F9",
        KeyCode::F10 => "F10",
        KeyCode::F11 => "F11",
        KeyCode::F12 => "F12",
        other => return Some(format!("{other:?}")),
    };
    Some(name.to_owned())
}

fn logical_key_to_dom_key(key: &Key) -> Option<String> {
    match key {
        Key::Character(s) => Some(s.to_string()),
        Key::Named(named) => {
            let s = match named {
                NamedKey::Space => " ",
                NamedKey::Enter => "Enter",
                NamedKey::Escape => "Escape",
                NamedKey::Tab => "Tab",
                NamedKey::Backspace => "Backspace",
                NamedKey::Delete => "Delete",
                NamedKey::ArrowUp => "ArrowUp",
                NamedKey::ArrowDown => "ArrowDown",
                NamedKey::ArrowLeft => "ArrowLeft",
                NamedKey::ArrowRight => "ArrowRight",
                NamedKey::Shift => "Shift",
                NamedKey::Control => "Control",
                NamedKey::Alt => "Alt",
                NamedKey::Super => "Meta",
                NamedKey::Home => "Home",
                NamedKey::End => "End",
                NamedKey::PageUp => "PageUp",
                NamedKey::PageDown => "PageDown",
                other => return Some(format!("{other:?}")),
            };
            Some(s.to_owned())
        }
        Key::Unidentified(_) => Some("Unidentified".to_owned()),
        Key::Dead(_) => Some("Dead".to_owned()),
    }
}

struct WindowState {
    window: Option<Arc<Window>>,
    events: Vec<JsWindowEvent>,
    closed: bool,
    visible: bool,
    focused: bool,
    pointer_locked: bool,
    modifiers: ModifiersState,
    cursor_x: f64,
    cursor_y: f64,
    ime_generation: u32,
}

#[derive(Default)]
struct WindowEvents {
    pending: Option<WindowAttributes>,
    created: Option<std::result::Result<Rc<RefCell<WindowState>>, String>>,
    windows: HashMap<WindowId, Weak<RefCell<WindowState>>>,
}

impl WindowEvents {
    fn create_pending(&mut self, event_loop: &ActiveEventLoop) {
        let Some(attributes) = self.pending.take() else {
            return;
        };
        self.created = Some(
            event_loop
                .create_window(attributes)
                .map(|window| {
                    let id = window.id();
                    let state = Rc::new(RefCell::new(WindowState {
                        window: Some(Arc::new(window)),
                        events: Vec::new(),
                        closed: false,
                        visible: true,
                        focused: true,
                        pointer_locked: false,
                        modifiers: ModifiersState::empty(),
                        cursor_x: 0.0,
                        cursor_y: 0.0,
                        ime_generation: 0,
                    }));
                    self.windows.insert(id, Rc::downgrade(&state));
                    state
                })
                .map_err(|e| e.to_string()),
        );
    }
}

impl ApplicationHandler for WindowEvents {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        self.create_pending(event_loop);
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        self.create_pending(event_loop);
    }

    fn device_event(
        &mut self,
        _: &ActiveEventLoop,
        _: DeviceId,
        event: DeviceEvent,
    ) {
        if let DeviceEvent::MouseMotion { delta: (dx, dy) } = event {
            for weak in self.windows.values() {
                if let Some(state_rc) = weak.upgrade() {
                    let mut state = state_rc.borrow_mut();
                    if state.focused && state.pointer_locked {
                        state.events.push(JsWindowEvent {
                            kind: "pointer-relative".to_owned(),
                            dx: Some(dx),
                            dy: Some(dy),
                            ..Default::default()
                        });
                    }
                }
            }
        }
    }

    fn window_event(&mut self, _: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        let Some(state) = self.windows.get(&id).and_then(Weak::upgrade) else {
            self.windows.remove(&id);
            return;
        };
        let mut state = state.borrow_mut();
        match event {
            WindowEvent::CloseRequested => {
                state.closed = true;
                state.events.push(JsWindowEvent::simple("close-requested"));
            }
            WindowEvent::Resized(size) => {
                state.events.push(JsWindowEvent {
                    kind: "resized".to_owned(),
                    width: Some(size.width),
                    height: Some(size.height),
                    ..Default::default()
                });
            }
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                state.events.push(JsWindowEvent {
                    kind: "scale-changed".to_owned(),
                    scale_factor: Some(scale_factor),
                    ..Default::default()
                });
            }
            WindowEvent::RedrawRequested => {
                state.events.push(JsWindowEvent::simple("redraw"));
            }
            WindowEvent::Focused(focused) => {
                state.focused = focused;
                state.events.push(JsWindowEvent {
                    kind: "focus".to_owned(),
                    focused: Some(focused),
                    ..Default::default()
                });
            }
            WindowEvent::Occluded(occluded) => {
                state.visible = !occluded;
                state.events.push(JsWindowEvent {
                    kind: "visibility".to_owned(),
                    visible: Some(!occluded),
                    ..Default::default()
                });
            }
            WindowEvent::ModifiersChanged(mods) => {
                state.modifiers = mods.state();
            }
            WindowEvent::KeyboardInput {
                event:
                    KeyEvent {
                        physical_key,
                        logical_key,
                        text,
                        state: elem_state,
                        repeat,
                        ..
                    },
                ..
            } => {
                let kind = if elem_state == ElementState::Pressed {
                    "key-down"
                } else {
                    "key-up"
                };
                let mods = state.modifiers;
                state.events.push(JsWindowEvent {
                    kind: kind.to_owned(),
                    code: physical_key_to_dom_code(physical_key),
                    key: logical_key_to_dom_key(&logical_key),
                    text: text.map(|t| t.to_string()),
                    repeat: Some(repeat),
                    shift_key: Some(mods.shift_key()),
                    ctrl_key: Some(mods.control_key()),
                    alt_key: Some(mods.alt_key()),
                    meta_key: Some(mods.super_key()),
                    ..Default::default()
                });
            }
            WindowEvent::CursorMoved { position, .. } => {
                state.cursor_x = position.x;
                state.cursor_y = position.y;
                state.events.push(JsWindowEvent {
                    kind: "pointer-move".to_owned(),
                    x: Some(position.x),
                    y: Some(position.y),
                    ..Default::default()
                });
            }
            WindowEvent::CursorLeft { .. } => {
                state.events.push(JsWindowEvent::simple("pointer-leave"));
            }
            WindowEvent::MouseInput {
                state: elem_state,
                button,
                ..
            } => {
                let button_name = match button {
                    MouseButton::Left => Some("left"),
                    MouseButton::Right => Some("right"),
                    MouseButton::Middle => Some("middle"),
                    _ => None,
                };
                if let Some(btn) = button_name {
                    let x = state.cursor_x;
                    let y = state.cursor_y;
                    state.events.push(JsWindowEvent {
                        kind: if elem_state == ElementState::Pressed {
                            "pointer-down"
                        } else {
                            "pointer-up"
                        }
                        .to_owned(),
                        x: Some(x),
                        y: Some(y),
                        button: Some(btn.to_owned()),
                        ..Default::default()
                    });
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let (dx, dy) = match delta {
                    MouseScrollDelta::LineDelta(x, y) => (x as f64 * 40.0, y as f64 * 40.0),
                    MouseScrollDelta::PixelDelta(pos) => (pos.x, pos.y),
                };
                let x = state.cursor_x;
                let y = state.cursor_y;
                state.events.push(JsWindowEvent {
                    kind: "pointer-wheel".to_owned(),
                    x: Some(x),
                    y: Some(y),
                    dx: Some(dx),
                    dy: Some(dy),
                    ..Default::default()
                });
            }
            WindowEvent::Ime(ime) => {
                let gen = state.ime_generation;
                match ime {
                    Ime::Preedit(text, _) => {
                        state.events.push(JsWindowEvent {
                            kind: "ime-preedit".to_owned(),
                            text: Some(text),
                            generation: Some(gen),
                            ..Default::default()
                        });
                    }
                    Ime::Commit(text) => {
                        state.events.push(JsWindowEvent {
                            kind: "ime-commit".to_owned(),
                            text: Some(text),
                            generation: Some(gen),
                            ..Default::default()
                        });
                    }
                    Ime::Disabled => {
                        state.events.push(JsWindowEvent {
                            kind: "ime-cancel".to_owned(),
                            generation: Some(gen),
                            ..Default::default()
                        });
                    }
                    Ime::Enabled => {}
                }
            }
            _ => {}
        }
    }
}

struct EventLoopHost {
    event_loop: EventLoop<()>,
    handler: WindowEvents,
}

impl EventLoopHost {
    fn new() -> std::result::Result<Self, String> {
        let event_loop = EventLoop::new().map_err(|e| e.to_string())?;
        Ok(Self {
            event_loop,
            handler: WindowEvents::default(),
        })
    }

    fn pump(&mut self) {
        let _ = self
            .event_loop
            .pump_app_events(Some(Duration::ZERO), &mut self.handler);
    }
}

thread_local! {
    static EVENT_LOOP_HOST: RefCell<Option<EventLoopHost>> = const { RefCell::new(None) };
}

fn with_event_loop<T>(f: impl FnOnce(&mut EventLoopHost) -> Result<T>) -> Result<T> {
    EVENT_LOOP_HOST.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            let host = EventLoopHost::new()
                .map_err(|e| Error::from_reason(format!("failed to create winit EventLoop: {e}")))?;
            *slot = Some(host);
        }
        f(slot.as_mut().expect("event loop initialized"))
    })
}

pub struct KernelNativeWindow {
    state: Rc<RefCell<WindowState>>,
}

impl KernelNativeWindow {
    pub fn open(
        options: NativeWindowOptions,
    ) -> Result<(Self, wgpu::Instance, wgpu::Surface<'static>, u32, u32)> {
        if options.width == 0 || options.height == 0 {
            return Err(Error::from_reason("window dimensions must be nonzero"));
        }
        let attrs = Window::default_attributes()
            .with_title(options.title)
            .with_visible(true)
            .with_inner_size(LogicalSize::new(options.width, options.height));

        let state = with_event_loop(|host| {
            host.handler.pending = Some(attrs);
            host.handler.created = None;
            host.pump();
            let created = host
                .handler
                .created
                .take()
                .ok_or_else(|| Error::from_reason("winit did not create window during pump"))?
                .map_err(|e| Error::from_reason(format!("winit create_window failed: {e}")))?;
            if let Some(w) = created.borrow().window.as_ref() {
                w.set_visible(true);
                w.focus_window();
                w.request_redraw();
            }
            // Pump one more turn so macOS AppKit / Win32 commits window exposure before first present.
            host.pump();
            Ok(created)
        })?;

        let window_arc = state
            .borrow()
            .window
            .clone()
            .ok_or_else(|| Error::from_reason("native window unavailable"))?;
        let physical = window_arc.inner_size();
        let width = physical.width.max(1);
        let height = physical.height.max(1);

        let mut desc = wgpu::InstanceDescriptor::new_without_display_handle();
        #[cfg(target_os = "macos")]
        {
            desc.backends = wgpu::Backends::METAL;
        }
        #[cfg(target_os = "windows")]
        {
            desc.backends = wgpu::Backends::DX12;
            desc.backend_options.dx12.presentation_system = wgpu::Dx12SwapchainKind::DxgiFromHwnd;
            desc.backend_options.dx12 = desc.backend_options.dx12.with_env();
        }
        #[cfg(target_os = "linux")]
        {
            desc.backends = wgpu::Backends::VULKAN;
        }
        let instance = wgpu::Instance::new(desc);
        let surface = instance
            .create_surface(window_arc)
            .map_err(|e| Error::from_reason(format!("wgpu create_surface failed: {e}")))?;

        Ok((Self { state }, instance, surface, width, height))
    }

    pub fn poll_events(&self) -> Result<Vec<JsWindowEvent>> {
        with_event_loop(|host| {
            host.pump();
            Ok(())
        })?;
        Ok(std::mem::take(&mut self.state.borrow_mut().events))
    }

    pub fn resize(&self, width: u32, height: u32) -> Result<(u32, u32)> {
        if width == 0 || height == 0 {
            return Err(Error::from_reason("window dimensions must be nonzero"));
        }
        let state = self.state.borrow();
        let window = state
            .window
            .as_ref()
            .ok_or_else(|| Error::from_reason("native window is closed"))?;
        let _ = window.request_inner_size(PhysicalSize::new(width, height));
        let size = window.inner_size();
        Ok((size.width.max(1), size.height.max(1)))
    }

    pub fn physical_size(&self) -> (u32, u32) {
        self.state
            .borrow()
            .window
            .as_ref()
            .map(|w| {
                let s = w.inner_size();
                (s.width.max(1), s.height.max(1))
            })
            .unwrap_or((0, 0))
    }

    pub fn facts(&self) -> JsWindowFacts {
        let st = self.state.borrow();
        match st.window.as_ref() {
            Some(w) => {
                let s = w.inner_size();
                let scale = w.scale_factor();
                let visible = st.visible && !st.closed && w.is_visible().unwrap_or(true);
                JsWindowFacts {
                    width: s.width,
                    height: s.height,
                    scale_factor: if scale > 0.0 { scale } else { 1.0 },
                    visible,
                }
            }
            None => JsWindowFacts {
                width: 0,
                height: 0,
                scale_factor: 1.0,
                visible: false,
            },
        }
    }

    pub fn request_redraw(&self) {
        if let Some(w) = self.state.borrow().window.as_ref() {
            w.request_redraw();
        }
    }

    pub fn set_pointer_lock(&self, locked: bool) -> bool {
        let mut st = self.state.borrow_mut();
        let Some(w) = st.window.as_ref() else {
            return false;
        };
        if locked {
            let grabbed = w
                .set_cursor_grab(CursorGrabMode::Locked)
                .or_else(|_| w.set_cursor_grab(CursorGrabMode::Confined))
                .is_ok();
            if grabbed {
                w.set_cursor_visible(false);
                st.pointer_locked = true;
                true
            } else {
                false
            }
        } else {
            let _ = w.set_cursor_grab(CursorGrabMode::None);
            w.set_cursor_visible(true);
            st.pointer_locked = false;
            false
        }
    }

    pub fn set_ime_area(&self, area: Option<[f64; 4]>) -> u32 {
        let mut st = self.state.borrow_mut();
        st.ime_generation = st.ime_generation.wrapping_add(1);
        let gen = st.ime_generation;
        if let Some(w) = st.window.as_ref() {
            match area {
                Some([x, y, width, height]) if width > 0.0 && height > 0.0 => {
                    w.set_ime_allowed(true);
                    w.set_ime_cursor_area(
                        LogicalPosition::new(x, y),
                        LogicalSize::new(width, height),
                    );
                }
                _ => {
                    w.set_ime_allowed(false);
                }
            }
        }
        gen
    }
}

impl Drop for KernelNativeWindow {
    fn drop(&mut self) {
        self.state.borrow_mut().window = None;
    }
}
