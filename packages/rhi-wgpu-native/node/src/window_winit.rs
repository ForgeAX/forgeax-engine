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
use winit::dpi::PhysicalSize;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::platform::pump_events::EventLoopExtPumpEvents;
use winit::window::{Window, WindowAttributes, WindowId};

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
                    }));
                    self.windows.insert(id, Rc::downgrade(&state));
                    state
                })
                .map_err(|error| error.to_string()),
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
            WindowEvent::CloseRequested => json!({"kind": "close-requested"}),
            WindowEvent::Destroyed => json!({"kind": "surface-lost"}),
            _ => return,
        };
        // These are latest native facts, not input transitions. Keep at most one
        // of each kind even while another window is the active polling consumer.
        if let Some(previous) = state
            .events
            .iter_mut()
            .find(|event| event["kind"] == fact["kind"])
        {
            *previous = fact;
        } else {
            state.events.push(fact);
        }
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
