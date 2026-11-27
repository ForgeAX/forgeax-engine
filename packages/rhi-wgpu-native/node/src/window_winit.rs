//! Default native window owner. Surface and device policy live in window.rs.
use super::{failure, NativeWindowFacts, NativeWindowHost};
use napi::bindgen_prelude::*;
use raw_window_handle::{
    DisplayHandle, HandleError, HasDisplayHandle, HasWindowHandle, WindowHandle,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::{Rc, Weak};
use std::sync::Arc;
use std::time::Duration;
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalPosition, LogicalSize, PhysicalSize};
use winit::event::{
    DeviceEvent, DeviceId, ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent,
};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::keyboard::{Key, ModifiersState, NamedKey, PhysicalKey};
use winit::platform::pump_events::EventLoopExtPumpEvents;
use winit::window::{CursorGrabMode, Window, WindowAttributes, WindowId};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WindowOptions {
    pub title: String,
    pub width: u32,
    pub height: u32,
}

struct WindowState {
    window: Option<Arc<Window>>,
    events: Vec<Value>,
    visible: bool,
    cursor: Option<(f64, f64)>,
    pointer_locked: bool,
    focused: bool,
    modifiers: ModifiersState,
    ime_allowed: bool,
    ime_generation: u32,
    #[cfg(target_os = "macos")]
    gamepads: super::gamepad_macos::Gamepads,
}

impl WindowState {
    fn set_pointer_lock(&mut self, locked: bool) -> Result<bool> {
        if self.pointer_locked == locked {
            return Ok(locked);
        }
        let window = self
            .window
            .as_ref()
            .ok_or_else(|| failure("native window is closed"))?;
        if locked {
            if !self.focused
                || window
                    .set_cursor_grab(CursorGrabMode::Locked)
                    .or_else(|_| window.set_cursor_grab(CursorGrabMode::Confined))
                    .is_err()
            {
                return Ok(false);
            }
        } else {
            window
                .set_cursor_grab(CursorGrabMode::None)
                .map_err(failure)?;
        }
        window.set_cursor_visible(!locked);
        self.pointer_locked = locked;
        Ok(locked)
    }
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
                        visible: true,
                        cursor: None,
                        pointer_locked: false,
                        focused: false,
                        modifiers: ModifiersState::empty(),
                        ime_allowed: false,
                        ime_generation: 0,
                        #[cfg(target_os = "macos")]
                        gamepads: Default::default(),
                    }));
                    self.windows.insert(id, Rc::downgrade(&state));
                    state
                })
                .map_err(|error| error.to_string()),
        );
    }
}

fn key_transition(physical_key: PhysicalKey, state: ElementState, repeat: bool) -> Option<Value> {
    let PhysicalKey::Code(code) = physical_key else {
        return None;
    };
    Some(json!({
        "kind": if state == ElementState::Pressed { "key-down" } else { "key-up" },
        "code": format!("{code:?}"),
        "repeat": repeat,
    }))
}

fn push_window_event(events: &mut Vec<Value>, fact: Value) {
    let kind = fact["kind"].as_str();
    // Only adjacent motion can collapse: never cross a button/focus boundary.
    if kind == Some("pointer-move") {
        if let Some(previous) = events
            .last_mut()
            .filter(|event| event["kind"] == "pointer-move")
        {
            *previous = fact;
            return;
        }
    }
    if matches!(kind, Some("redraw" | "display" | "visibility")) {
        if let Some(previous) = events
            .iter_mut()
            .find(|event| event["kind"] == fact["kind"])
        {
            *previous = fact;
            return;
        }
    }
    // Key and focus transitions are ordered input. Never coalesce them by kind.
    events.push(fact);
}

impl ApplicationHandler for WindowEvents {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        self.create_pending(event_loop);
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        self.create_pending(event_loop);
    }

    fn device_event(&mut self, _: &ActiveEventLoop, _: DeviceId, event: DeviceEvent) {
        let DeviceEvent::MouseMotion { delta: (x, y) } = event else {
            return;
        };
        for state in self.windows.values().filter_map(Weak::upgrade) {
            let mut state = state.borrow_mut();
            if state.focused && state.pointer_locked {
                push_window_event(
                    &mut state.events,
                    json!({"kind": "pointer-relative", "dx": x, "dy": y}),
                );
            }
        }
    }

    fn window_event(&mut self, _: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        let Some(state) = self.windows.get(&id).and_then(Weak::upgrade) else {
            self.windows.remove(&id);
            return;
        };
        let mut state = state.borrow_mut();
        let fact = match event {
            WindowEvent::RedrawRequested => json!({"kind": "redraw"}),
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                json!({"kind": "display"})
            }
            WindowEvent::Occluded(value) => {
                state.visible = !value;
                json!({"kind": "visibility", "visible": !value})
            }
            WindowEvent::KeyboardInput {
                event,
                is_synthetic,
                ..
            } => {
                let mut fact = key_transition(event.physical_key, event.state, event.repeat)
                    .unwrap_or_else(|| json!({
                        "kind": if event.state == ElementState::Pressed { "key-down" } else { "key-up" },
                        "repeat": event.repeat,
                    }));
                let key = match event.logical_key {
                    Key::Character(value) => value.to_string(),
                    Key::Named(NamedKey::Space) => " ".to_owned(),
                    Key::Named(value) => format!("{value:?}"),
                    _ => "Unidentified".to_owned(),
                };
                fact["key"] = json!(key);
                fact["shiftKey"] = json!(state.modifiers.shift_key());
                fact["ctrlKey"] = json!(state.modifiers.control_key());
                fact["altKey"] = json!(state.modifiers.alt_key());
                fact["metaKey"] = json!(state.modifiers.super_key());
                if !is_synthetic && event.state == ElementState::Pressed {
                    if let Some(text) = event.text {
                        fact["text"] = json!(text.as_str());
                    }
                }
                fact
            }
            WindowEvent::ModifiersChanged(modifiers) => {
                state.modifiers = modifiers.state();
                return;
            }
            WindowEvent::Ime(Ime::Preedit(text, _)) if state.ime_allowed => {
                json!({"kind": "ime-preedit", "text": text, "generation": state.ime_generation})
            }
            WindowEvent::Ime(Ime::Commit(text)) if state.ime_allowed => {
                json!({"kind": "ime-commit", "text": text, "generation": state.ime_generation})
            }
            WindowEvent::Ime(Ime::Disabled) => {
                json!({"kind": "ime-cancel", "generation": state.ime_generation})
            }
            WindowEvent::CursorMoved { position, .. } => {
                state.cursor = Some((position.x, position.y));
                json!({"kind":"pointer-move", "x":position.x, "y":position.y})
            }
            WindowEvent::MouseInput {
                state: transition,
                button,
                ..
            } => {
                let button = match button {
                    MouseButton::Left => "left",
                    MouseButton::Right => "right",
                    MouseButton::Middle => "middle",
                    _ => return,
                };
                let (x, y) = match (state.cursor, state.pointer_locked) {
                    (Some(position), _) => position,
                    (None, true) => (0.0, 0.0),
                    _ => return,
                };
                json!({"kind":if transition == ElementState::Pressed {"pointer-down"} else {"pointer-up"},
                    "button":button, "x":x, "y":y})
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let Some((x, y)) = state.cursor else {
                    return;
                };
                let (dx, dy) = match delta {
                    MouseScrollDelta::LineDelta(x, y) => (f64::from(x) * 40.0, f64::from(y) * 40.0),
                    MouseScrollDelta::PixelDelta(position) => (position.x, position.y),
                };
                json!({"kind": "pointer-wheel", "x": x, "y": y, "dx": -dx, "dy": -dy})
            }
            WindowEvent::CursorLeft { .. } => {
                state.cursor = None;
                json!({"kind":"pointer-leave"})
            }
            WindowEvent::Focused(focused) => {
                state.focused = focused;
                if !focused {
                    let _ = state.set_pointer_lock(false);
                    state.cursor = None;
                    state.modifiers = ModifiersState::empty();
                }
                json!({"kind": "focus", "focused": focused})
            }
            WindowEvent::CloseRequested => json!({"kind": "close-requested"}),
            WindowEvent::Destroyed => json!({"kind": "surface-lost"}),
            _ => return,
        };
        push_window_event(&mut state.events, fact);
    }
}

struct WindowHost {
    event_loop: EventLoop<()>,
    events: WindowEvents,
}

impl WindowHost {
    fn pump(&mut self) {
        self.event_loop
            .pump_app_events(Some(Duration::ZERO), &mut self.events);
    }
}

thread_local! {
    // winit permits one event loop per process. It outlives individual windows;
    // their native state remains owned by each NativeWindow and may be recreated.
    static HOST: RefCell<Option<WindowHost>> = const { RefCell::new(None) };
}

fn with_host<T>(run: impl FnOnce(&mut WindowHost) -> Result<T>) -> Result<T> {
    HOST.with(|slot| {
        let mut host = slot.borrow_mut();
        if host.is_none() {
            *host = Some(WindowHost {
                event_loop: EventLoop::new().map_err(failure)?,
                events: WindowEvents::default(),
            });
        }
        run(host.as_mut().expect("native host was initialized"))
    })
}

pub(super) struct WinitWindow(Rc<RefCell<WindowState>>);

impl WinitWindow {
    pub fn new(options: WindowOptions) -> Result<Self> {
        let state = with_host(|host| {
            host.events.pending = Some(
                Window::default_attributes()
                    .with_title(options.title)
                    .with_inner_size(PhysicalSize::new(options.width, options.height)),
            );
            host.pump();
            host.events
                .created
                .take()
                .ok_or_else(|| failure("native window did not resume"))?
                .map_err(failure)
        })?;
        Ok(Self(state))
    }
}

impl HasWindowHandle for WinitWindow {
    fn window_handle(&self) -> std::result::Result<WindowHandle<'_>, HandleError> {
        let state = self.0.borrow();
        let raw = state
            .window
            .as_ref()
            .ok_or(HandleError::Unavailable)?
            .window_handle()?
            .as_raw();
        // The Arc<Window> stays in this owner until NativeWindow has dropped its Surface.
        Ok(unsafe { WindowHandle::borrow_raw(raw) })
    }
}

impl HasDisplayHandle for WinitWindow {
    fn display_handle(&self) -> std::result::Result<DisplayHandle<'_>, HandleError> {
        let state = self.0.borrow();
        let raw = state
            .window
            .as_ref()
            .ok_or(HandleError::Unavailable)?
            .display_handle()?
            .as_raw();
        Ok(unsafe { DisplayHandle::borrow_raw(raw) })
    }
}

impl NativeWindowHost for WinitWindow {
    fn facts(&self) -> Result<NativeWindowFacts> {
        let state = self.0.borrow();
        let window = state
            .window
            .as_ref()
            .ok_or_else(|| failure("native window is closed"))?;
        let size = window.inner_size();
        Ok(NativeWindowFacts {
            width: size.width,
            height: size.height,
            scale_factor: window.scale_factor(),
            visible: state.visible && window.is_visible().unwrap_or(true),
        })
    }

    fn resize(&self, width: u32, height: u32) -> Result<()> {
        let state = self.0.borrow();
        let window = state
            .window
            .as_ref()
            .ok_or_else(|| failure("native window is closed"))?;
        let _ = window.request_inner_size(PhysicalSize::new(width, height));
        Ok(())
    }

    fn request_redraw(&self) -> Result<()> {
        self.0
            .borrow()
            .window
            .as_ref()
            .ok_or_else(|| failure("native window is closed"))?
            .request_redraw();
        Ok(())
    }

    fn set_pointer_lock(&self, locked: bool) -> Result<bool> {
        self.0.borrow_mut().set_pointer_lock(locked)
    }

    #[cfg(target_os = "windows")]
    fn gamepads(&self) -> Option<Vec<super::NativeGamepad>> {
        Some(super::gamepad::snapshots())
    }

    #[cfg(target_os = "macos")]
    fn gamepads(&self) -> Option<Vec<super::NativeGamepad>> {
        Some(self.0.borrow_mut().gamepads.snapshots())
    }

    fn set_ime_area(&self, area: Option<[f64; 4]>) -> u32 {
        let mut state = self.0.borrow_mut();
        let Some(window) = state.window.clone() else {
            return state.ime_generation;
        };
        if state.ime_allowed != area.is_some() {
            state.ime_allowed = area.is_some();
            state.ime_generation = state.ime_generation.wrapping_add(1);
            window.set_ime_allowed(state.ime_allowed);
        }
        if let Some([x, y, width, height]) = area {
            window.set_ime_cursor_area(LogicalPosition::new(x, y), LogicalSize::new(width, height));
        }
        state.ime_generation
    }

    fn poll_events(&self) -> Result<Vec<Value>> {
        with_host(|host| {
            host.pump();
            Ok(())
        })?;
        Ok(std::mem::take(&mut self.0.borrow_mut().events))
    }

    fn pre_present_notify(&self) {
        if let Some(window) = self.0.borrow().window.as_ref() {
            window.pre_present_notify();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{key_transition, push_window_event};
    use serde_json::{json, Value};
    use winit::event::ElementState;
    use winit::keyboard::{KeyCode, PhysicalKey};

    #[test]
    fn input_transitions_keep_order_while_window_facts_coalesce() {
        let mut events = Vec::<Value>::new();
        push_window_event(&mut events, json!({"kind":"redraw","frame":1}));
        push_window_event(
            &mut events,
            json!({"kind":"key-down","code":"KeyW","repeat":false}),
        );
        push_window_event(&mut events, json!({"kind":"focus","focused":false}));
        push_window_event(
            &mut events,
            json!({"kind":"key-up","code":"KeyW","repeat":false}),
        );
        push_window_event(&mut events, json!({"kind":"focus","focused":true}));
        push_window_event(&mut events, json!({"kind":"redraw","frame":2}));

        assert_eq!(
            events,
            vec![
                json!({"kind":"redraw","frame":2}),
                json!({"kind":"key-down","code":"KeyW","repeat":false}),
                json!({"kind":"focus","focused":false}),
                json!({"kind":"key-up","code":"KeyW","repeat":false}),
                json!({"kind":"focus","focused":true}),
            ],
        );
    }

    #[test]
    fn motion_coalesces_only_inside_one_ordered_segment() {
        let mut events = Vec::<Value>::new();
        for fact in [
            json!({"kind":"pointer-move","x":1}),
            json!({"kind":"pointer-move","x":2}),
            json!({"kind":"pointer-down","button":"right"}),
            json!({"kind":"pointer-move","x":3}),
            json!({"kind":"pointer-move","x":4}),
            json!({"kind":"focus","focused":false}),
            json!({"kind":"pointer-move","x":5}),
        ] {
            push_window_event(&mut events, fact);
        }
        assert_eq!(events.len(), 5);
        assert_eq!(events[0]["x"], 2);
        assert_eq!(events[1]["kind"], "pointer-down");
        assert_eq!(events[2]["x"], 4);
        assert_eq!(events[3]["kind"], "focus");
        assert_eq!(events[4]["x"], 5);
    }

    #[test]
    fn keyboard_transition_uses_physical_key_code_and_repeat_flag() {
        assert_eq!(
            key_transition(
                PhysicalKey::Code(KeyCode::KeyW),
                ElementState::Pressed,
                true
            ),
            Some(json!({"kind":"key-down","code":"KeyW","repeat":true})),
        );
        assert_eq!(
            key_transition(
                PhysicalKey::Code(KeyCode::ArrowLeft),
                ElementState::Released,
                false
            ),
            Some(json!({"kind":"key-up","code":"ArrowLeft","repeat":false})),
        );
    }
}

impl Drop for WinitWindow {
    fn drop(&mut self) {
        if let Some(window) = self.0.borrow_mut().window.take() {
            HOST.with(|slot| {
                if let Some(host) = slot.borrow_mut().as_mut() {
                    host.events.windows.remove(&window.id());
                }
            });
        }
    }
}
