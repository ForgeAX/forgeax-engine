//! Contributor-only Linux X11 host: Tauri owns one top-level and two child
//! drawables. The native RHI borrows one; Wry owns HTML/CSS on the other.
//! All native pointers stay on Node's calling thread inside this addon.

use forgeax_rhi_wgpu_native_node::{NativeWindow, NativeWindowFacts, NativeWindowHost};
use gtk::prelude::*;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use raw_window_handle::{
    DisplayHandle, HandleError, HasDisplayHandle, HasWindowHandle, RawWindowHandle, WindowHandle,
    XlibWindowHandle,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::HashMap,
    rc::{Rc, Weak},
};
use wry::WebViewBuilderExtUnix;

fn failure(cause: impl std::fmt::Display) -> Error {
    Error::from_reason(cause.to_string())
}

struct State {
    window: Option<tauri::Window>,
    drawable: gtk::DrawingArea,
    ui: gtk::Fixed,
    webview: Option<wry::WebView>,
    messages: Rc<RefCell<Vec<String>>>,
    events: Vec<Value>,
    surface_taken: bool,
}

impl State {
    fn window(&self) -> Result<&tauri::Window> {
        self.window
            .as_ref()
            .ok_or_else(|| failure("native window is closed"))
    }

    fn close(&mut self) {
        self.webview.take();
        if let Some(window) = self.window.take() {
            HOST.with(|slot| {
                if let Some(host) = slot.borrow_mut().as_mut() {
                    host.windows.borrow_mut().remove(window.label());
                }
            });
            // This runs only after RHI releases its Surface, including the GC path.
            if let Err(error) = window.destroy() {
                eprintln!("Tauri window retirement: {error}");
            }
        }
    }
}

struct Host {
    app: tauri::App,
    windows: Rc<RefCell<HashMap<String, Weak<RefCell<State>>>>>,
    next_window: u64,
}

impl Host {
    #[allow(deprecated)] // The opt-in Node fixture must yield back to libuv.
    fn pump(&mut self) {
        let windows = self.windows.clone();
        self.app.run_iteration(move |_, event| {
            let (label, fact) = match event {
                tauri::RunEvent::ExitRequested { api, .. } => {
                    api.prevent_exit();
                    return;
                }
                tauri::RunEvent::WindowEvent { label, event, .. } => {
                    let fact = match event {
                        tauri::WindowEvent::Resized(_)
                        | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                            json!({"kind":"display"})
                        }
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            // Surface lifetime, not the toolkit default, owns retirement.
                            api.prevent_close();
                            json!({"kind":"close-requested"})
                        }
                        tauri::WindowEvent::Destroyed => json!({"kind":"surface-lost"}),
                        _ => return,
                    };
                    (label, fact)
                }
                _ => return,
            };
            if let Some(state) = windows.borrow().get(&label).and_then(Weak::upgrade) {
                let mut state = state.borrow_mut();
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
        });
    }
}

thread_local! {
    static HOST: RefCell<Option<Host>> = const { RefCell::new(None) };
}

fn with_host<T>(run: impl FnOnce(&mut Host) -> Result<T>) -> Result<T> {
    HOST.with(|slot| {
        let mut host = slot.borrow_mut();
        if host.is_none() {
            let app = tauri::Builder::default()
                .build(tauri::generate_context!())
                .map_err(failure)?;
            *host = Some(Host {
                app,
                windows: Rc::new(RefCell::new(HashMap::new())),
                next_window: 0,
            });
        }
        run(host.as_mut().expect("Tauri host initialized"))
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    title: String,
    width: u32,
    height: u32,
}

/// JS owns UI control; the RHI lease independently retains the native drawable.
#[napi]
pub struct TauriWindow {
    state: Rc<RefCell<State>>,
}

#[napi]
impl TauriWindow {
    #[napi(constructor, catch_unwind)]
    pub fn new(options: String) -> Result<Self> {
        let options: Options = serde_json::from_str(&options).map_err(failure)?;
        if options.width == 0
            || options.height == 0
            || options.width > i32::MAX as u32
            || options.height > i32::MAX as u32
        {
            return Err(failure(
                "native window dimensions must be positive i32 integers",
            ));
        }
        let state = with_host(|host| {
            host.next_window += 1;
            let window = tauri::window::WindowBuilder::new(
                &host.app,
                format!("native-{}", host.next_window),
            )
            .title(options.title)
            .inner_size(options.width as f64, options.height as f64)
            .build()
            .map_err(failure)?;
            let fixed = gtk::Fixed::new();
            let drawable = gtk::DrawingArea::new();
            drawable.set_has_window(true);
            drawable.set_app_paintable(true);
            drawable.set_property("double-buffered", false);
            drawable.connect_draw(|_, _| gtk::glib::Propagation::Stop);
            drawable.set_size_request(options.width as i32, options.height as i32);
            fixed.put(&drawable, 0, 0);
            let ui = gtk::Fixed::new();
            let ui_window = gtk::EventBox::new();
            ui_window.set_visible_window(true);
            ui_window.set_size_request(240, 180);
            ui_window.add(&ui);
            fixed.put(&ui_window, 16, 16);
            window
                .default_vbox()
                .map_err(failure)?
                .pack_start(&fixed, true, true, 0);
            fixed.show_all();
            if !ui_window
                .window()
                .ok_or_else(|| failure("UI drawable is not realized"))?
                .ensure_native()
            {
                return Err(failure("UI requires an independent native child drawable"));
            }
            let native = drawable
                .window()
                .ok_or_else(|| failure("native drawable is not realized"))?;
            if !native.ensure_native() || !native.is::<gdkx11::X11Window>() {
                return Err(failure("this fixture requires a native X11 drawable"));
            }
            let resize_drawable = drawable.clone();
            fixed.connect_size_allocate(move |_, allocation| {
                resize_drawable.size_allocate(&gtk::Allocation::new(
                    0,
                    0,
                    allocation.width(),
                    allocation.height(),
                ))
            });
            let label = window.label().to_owned();
            let state = Rc::new(RefCell::new(State {
                window: Some(window),
                drawable,
                ui,
                webview: None,
                messages: Rc::new(RefCell::new(Vec::new())),
                events: Vec::new(),
                surface_taken: false,
            }));
            host.windows
                .borrow_mut()
                .insert(label, Rc::downgrade(&state));
            host.pump();
            Ok(state)
        })?;
        Ok(Self { state })
    }

    #[napi(catch_unwind)]
    pub fn take_native_window(&self) -> Result<NativeWindow> {
        for _ in 0..64 {
            if !gtk::events_pending() {
                break;
            }
            gtk::main_iteration_do(false);
        }
        {
            let mut state = self.state.borrow_mut();
            state.window()?;
            let drawable = state
                .drawable
                .window()
                .ok_or_else(|| failure("native drawable is not realized"))?;
            if !drawable.is_viewable() || drawable.width() <= 0 || drawable.height() <= 0 {
                return Err(failure("native drawable is not ready for a Surface"));
            }
            if state.surface_taken {
                return Err(failure("native drawable is already borrowed"));
            }
            state.surface_taken = true;
        }
        // SAFETY: Drawable retains State, including GTK widget and top-level, until
        // RHI drops its Surface. A close request cannot destroy the widget early.
        unsafe { NativeWindow::from_host(Box::new(Drawable(self.state.clone()))) }
    }

    #[napi(catch_unwind)]
    pub fn mount_webview(&self, html: String) -> Result<()> {
        let mut state = self.state.borrow_mut();
        state.window()?;
        if state.webview.is_some() {
            return Err(failure("WebView is already mounted"));
        }
        let messages = state.messages.clone();
        let webview = wry::WebViewBuilder::new()
            .with_html(html)
            .with_transparent(true)
            .with_bounds(wry::Rect {
                position: wry::dpi::PhysicalPosition::new(0, 0).into(),
                size: wry::dpi::PhysicalSize::new(240, 180).into(),
            })
            .with_ipc_handler(move |request| messages.borrow_mut().push(request.body().clone()))
            .build_gtk(&state.ui)
            .map_err(failure)?;
        state.webview = Some(webview);
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn webview_messages(&self) -> Result<String> {
        let state = self.state.borrow();
        state.window()?;
        let messages = std::mem::take(&mut *state.messages.borrow_mut());
        serde_json::to_string(&messages).map_err(failure)
    }

    #[napi(catch_unwind)]
    pub fn webview_eval(&self, script: String) -> Result<()> {
        self.state
            .borrow()
            .webview
            .as_ref()
            .ok_or_else(|| failure("WebView is closed"))?
            .evaluate_script(&script)
            .map_err(failure)
    }
}

impl Drop for TauriWindow {
    fn drop(&mut self) {
        if !self.state.borrow().surface_taken {
            self.state.borrow_mut().close();
        }
    }
}

struct Drawable(Rc<RefCell<State>>);

impl HasWindowHandle for Drawable {
    fn window_handle(&self) -> std::result::Result<WindowHandle<'_>, HandleError> {
        let state = self.0.borrow();
        let window = state
            .drawable
            .window()
            .ok_or(HandleError::Unavailable)?
            .downcast::<gdkx11::X11Window>()
            .map_err(|_| HandleError::Unavailable)?;
        // The widget and its native XID stay alive for this Drawable's lifetime.
        Ok(unsafe {
            WindowHandle::borrow_raw(RawWindowHandle::Xlib(XlibWindowHandle::new(window.xid())))
        })
    }
}

impl HasDisplayHandle for Drawable {
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

impl NativeWindowHost for Drawable {
    fn facts(&self) -> Result<NativeWindowFacts> {
        let state = self.0.borrow();
        let window = state.window()?;
        let size = window.inner_size().map_err(failure)?;
        Ok(NativeWindowFacts {
            width: size.width,
            height: size.height,
            scale_factor: window.scale_factor().map_err(failure)?,
            visible: window.is_visible().map_err(failure)?,
        })
    }

    fn resize(&self, width: u32, height: u32) -> Result<()> {
        if width > i32::MAX as u32 || height > i32::MAX as u32 {
            return Err(failure("GTK size exceeds i32"));
        }
        let state = self.0.borrow();
        state.drawable.set_size_request(width as i32, height as i32);
        state
            .window()?
            .set_size(tauri::PhysicalSize::new(width, height))
            .map_err(failure)
    }

    fn request_redraw(&self) -> Result<()> {
        let state = self.0.borrow();
        state.window()?.gtk_window().map_err(failure)?.queue_draw();
        Ok(())
    }

    fn poll_events(&self) -> Result<Vec<Value>> {
        with_host(|host| {
            host.pump();
            Ok(())
        })?;
        // Wry is embedded in a native child; dispatch its GTK layout/frame-clock
        // work before the next Surface frame while still yielding to Node.
        if self.0.borrow().webview.is_some() {
            for _ in 0..64 {
                if !gtk::events_pending() {
                    break;
                }
                gtk::main_iteration_do(false);
            }
        }
        Ok(std::mem::take(&mut self.0.borrow_mut().events))
    }
}

impl Drop for Drawable {
    fn drop(&mut self) {
        self.0.borrow_mut().close();
    }
}

#[napi(catch_unwind)]
pub fn shutdown_host() -> Result<()> {
    with_host(|host| {
        if !host.windows.borrow().is_empty() {
            return Err(failure("native windows remain open"));
        }
        host.app.cleanup_before_exit();
        Ok(())
    })
}
