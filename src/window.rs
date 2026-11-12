//! Native window geometry and platform desktop integration.

#[cfg(target_os = "macos")]
mod macos;

use tao::dpi::{LogicalSize, PhysicalPosition};
#[cfg(not(target_os = "macos"))]
use tao::dpi::PhysicalSize;
use tao::window::Window;

pub const PILL_W: f64 = 132.0;
pub const PILL_H: f64 = 38.0;
pub const DIAL: f64 = 340.0;
/// Fallback only for invalid layout input; normal offsets come from settings.
const DEFAULT_TOP_OFFSET: f64 = 20.0;
/// Extra transparent space prevents the completion fragments from being clipped.
pub const EFFECT: f64 = 580.0;
/// Bounded CSS shadow halo, plus a separate device-pixel GDI rasterization guard.
const SHADOW_EXTENT: f64 = 6.0;
const REGION_AA_GUARD: i32 = 3;
pub const PANEL_W: f64 = 340.0;
pub const PANEL_H: f64 = 620.0;
/// Stable shell identity shared by tray-icon and native desktop notifications.
#[cfg(target_os = "windows")]
pub const TRAY_GUID: u128 = 0xa53be171_1248_4d97_a865_4b2d17dbb018;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IslandShape {
    Pill,
    Dial,
    Effect,
}

#[cfg(any(not(target_os = "macos"), test))]
#[derive(Debug, Clone, Copy)]
struct ScreenRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// Clamp only the actual position, leaving the requested setting unchanged.
/// All shapes reserve the expanded dial's height so opening never moves the island.
/// Bounds and offsets are logical distances from the same top-edge coordinate.
fn bounded_top_offset(requested: f64, visible_top: f64, visible_bottom: f64) -> f64 {
    let requested = if requested.is_finite() { requested.clamp(0.0, 1000.0) }
        else { DEFAULT_TOP_OFFSET };
    let minimum = visible_top.max(0.0);
    let maximum = (visible_bottom - DIAL).max(minimum);
    requested.clamp(minimum, maximum)
}

/// The backing canvas never changes during pill/dial/effect transitions.
/// Windows offsets remain relative to the monitor top, including negative origins;
/// work-area bounds keep the expanded dial above the taskbar without shifting the
/// usual 20-pixel default. A top-mounted taskbar raises only the minimum position.
#[cfg(any(not(target_os = "macos"), test))]
fn island_position(monitor: ScreenRect, work_area: ScreenRect, window_w: u32,
                   scale: f64, top_offset: f64) -> (i32, i32) {
    let x = monitor.x + (monitor.width as i64 - window_w as i64) as i32 / 2;
    let visible_top_px = (work_area.y as f64 - monitor.y as f64)
        .clamp(0.0, monitor.height as f64);
    let visible_bottom_px = (work_area.y as f64 + work_area.height as f64 - monitor.y as f64)
        .clamp(visible_top_px, monitor.height as f64);
    let top = bounded_top_offset(top_offset, visible_top_px / scale, visible_bottom_px / scale);
    // Round the canvas anchor once, independently of the current shape. At
    // fractional DPI, floor the last safe top pixel to avoid crossing the taskbar.
    let minimum = visible_top_px.ceil() as i32;
    let maximum = (visible_bottom_px - DIAL * scale).floor().max(minimum as f64) as i32;
    let top_px = ((top * scale).round() as i32).clamp(minimum, maximum);
    let inset_px = (((EFFECT - DIAL) / 2.0) * scale).round() as i32;
    (x, monitor.y + top_px - inset_px)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ClipRegion {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    corner_diameter: i32,
}

/// Physical bounds within the stable canvas include the small CSS shadow halo.
/// GDI round regions rasterize asymmetrically: one or two extra device pixels
/// still cut visible antialias coverage, so preserve a three-device-pixel guard.
/// Dial stays rectangular throughout the morph: its final circle alone would
/// clip the wider pill near the top of the canvas.
fn island_region(shape: IslandShape, scale: f64) -> Option<ClipRegion> {
    let (width, height) = match shape {
        IslandShape::Pill => (PILL_W, PILL_H),
        IslandShape::Dial => (DIAL, DIAL),
        IslandShape::Effect => return None,
    };
    let left = (EFFECT - width) / 2.0;
    let top = (EFFECT - DIAL) / 2.0;
    let padding = (SHADOW_EXTENT * scale).ceil() as i32 + REGION_AA_GUARD;
    let pixel_top = (top * scale).floor() as i32 - padding;
    let pixel_bottom = ((top + height) * scale).ceil() as i32 + padding;
    Some(ClipRegion {
        left: (left * scale).floor() as i32 - padding,
        top: pixel_top,
        right: ((left + width) * scale).ceil() as i32 + padding,
        bottom: pixel_bottom,
        corner_diameter: if shape == IslandShape::Pill { pixel_bottom - pixel_top } else { 0 },
    })
}

/// Match the visible island and its bounded shadow, never the empty backing canvas.
/// The expanded rectangle deliberately contains the entire pill-to-dial morph.
#[cfg(any(target_os = "macos", test))]
fn island_hit_test(shape: IslandShape, x: f64, y: f64, scale: f64) -> bool {
    if !x.is_finite() || !y.is_finite() || !scale.is_finite() || scale <= 0.0 { return false; }
    let Some(region) = island_region(shape, scale) else {
        return (0.0..EFFECT).contains(&x) && (0.0..EFFECT).contains(&y);
    };
    let (x, y) = (x * scale, y * scale);
    if x < region.left as f64 || x >= region.right as f64
        || y < region.top as f64 || y >= region.bottom as f64 { return false; }
    if region.corner_diameter == 0 { return true; }
    let radius = region.corner_diameter as f64 / 2.0;
    let center_x = x.clamp(region.left as f64 + radius, region.right as f64 - radius);
    let center_y = (region.top + region.bottom) as f64 / 2.0;
    (x - center_x).powi(2) + (y - center_y).powi(2) <= radius.powi(2)
}

/// Keep island-originated drags alive outside the shape, and never intercept a
/// drag that began in another application while it crosses the transparent canvas.
#[cfg(any(target_os = "macos", test))]
fn overlay_mouse_policy(visible: bool, hit: bool, was_interactive: bool,
                        buttons_down: bool, previous_buttons_down: bool, captured: bool) -> (bool, bool) {
    let captured = visible && buttons_down
        && (captured || (!previous_buttons_down && was_interactive && hit));
    let ignore = !visible || if buttons_down { !captured } else { !hit };
    (captured, ignore)
}

/// macOS has no SetWindowRgn equivalent for WKWebView's transparent canvas.
/// Sample the desktop pointer from the existing event-loop wakeup so a window
/// that currently ignores mouse events can become interactive again reliably.
pub fn poll_overlay_hit_test(window: &Window, shape: IslandShape, visible: bool) {
    #[cfg(target_os = "macos")]
    macos::poll_hit_test(window, shape, visible);
    #[cfg(not(target_os = "macos"))]
    let _ = (window, shape, visible);
}

#[cfg(not(target_os = "macos"))]
fn monitor_rect(window: &Window, fallback_w: u32, fallback_h: u32) -> ScreenRect {
    window.current_monitor().map(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        ScreenRect { x: origin.x, y: origin.y, width: size.width, height: size.height }
    }).unwrap_or(ScreenRect { x: 0, y: 0, width: fallback_w, height: fallback_h })
}

/// Keep the native/WebView backing viewport at 580 logical pixels for every
/// shape. Resizing occurs only when monitor geometry or DPI actually changes;
/// the visible/input region changes without moving or rebuilding that surface.
pub fn resize_to(window: &Window, shape: IslandShape, top_offset: f64) -> bool {
    #[cfg(target_os = "macos")]
    { macos::resize_to(window, shape, top_offset) }
    #[cfg(not(target_os = "macos"))]
    {
    let rect = monitor_rect(window, 1920, 1080);
    let scale = window.scale_factor();
    if !scale.is_finite() || scale <= 0.0 { return false; }
    #[cfg(target_os = "windows")]
    let work_area = native::work_area(window).unwrap_or(rect);
    #[cfg(not(target_os = "windows"))]
    let work_area = rect;
    let desired_inner = LogicalSize::new(EFFECT, EFFECT).to_physical::<u32>(scale);
    let current_inner = window.inner_size();
    let current_outer = window.outer_size();
    let desired_outer = PhysicalSize::new(
        desired_inner.width + current_outer.width.saturating_sub(current_inner.width),
        desired_inner.height + current_outer.height.saturating_sub(current_inner.height),
    );
    let (x, y) = island_position(rect, work_area, desired_outer.width, scale, top_offset);
    let position = PhysicalPosition::new(x, y);
    let geometry_changed = current_inner != desired_inner || window.outer_position().ok() != Some(position);
    #[cfg(target_os = "windows")]
    {
        if geometry_changed && !native::move_resize(window, position, desired_outer) { return false; }
        native::apply_region(window, island_region(shape, scale))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (shape, geometry_changed);
        if current_inner != desired_inner { window.set_inner_size(desired_inner); }
        if window.outer_position().ok() != Some(position) { window.set_outer_position(position); }
        true
    }
    }
}

/// Desktop overlays should not create taskbar buttons or native frame shadows.
pub fn configure_overlay(window: &Window) {
    #[cfg(target_os = "windows")]
    {
        use tao::platform::windows::WindowExtWindows;
        let _ = window.set_skip_taskbar(true);
        window.set_undecorated_shadow(false);
        native::forget_region(window);
        native::remove_window_border(window);
    }
    #[cfg(target_os = "macos")]
    macos::configure_overlay(window);
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let _ = window;
}

pub fn fit_webview(webview: &wry::WebView, window: &Window) -> bool {
    let size = window.inner_size();
    let origin = PhysicalPosition::new(0, 0);
    // build_as_child bounds are native physical client geometry. Querying them
    // avoids repeating COM SetBounds after the matching tao Resized event.
    if let Ok(bounds) = webview.bounds() {
        let scale = window.scale_factor();
        if bounds.size.to_physical::<u32>(scale) == size
            && bounds.position.to_physical::<i32>(scale) == origin {
            return true;
        }
    }
    webview.set_bounds(wry::Rect {
        position: origin.into(),
        size: size.into(),
    }).is_ok()
}

/// Convert physical virtual-desktop coordinates to the stable WebView viewport.
/// Keep out-of-window positions: the frontend limits the eye's look direction.
#[cfg(any(not(target_os = "macos"), test))]
fn cursor_logical_coordinates(cursor: PhysicalPosition<i32>, origin: PhysicalPosition<i32>,
                              scale: f64) -> Option<(f64, f64)> {
    if !scale.is_finite() || scale <= 0.0 { return None; }
    Some(((cursor.x as f64 - origin.x as f64) / scale,
          (cursor.y as f64 - origin.y as f64) / scale))
}

/// Read the desktop cursor only during an explicitly requested gaze phase.
pub fn cursor_position(window: &Window) -> Option<(f64, f64)> {
    #[cfg(target_os = "windows")]
    {
        cursor_logical_coordinates(native::cursor_position()?,
            window.inner_position().ok()?, window.scale_factor())
    }
    #[cfg(target_os = "macos")]
    { macos::cursor_position(window) }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    { let _ = window; None }
}

#[cfg(any(not(target_os = "macos"), test))]
fn panel_position_in(rect: ScreenRect, panel_w: u32, panel_h: u32,
                     preferred: Option<(i32, i32)>) -> (i32, i32) {
    let max_x = (rect.x + rect.width as i32 - panel_w as i32).max(rect.x);
    let max_y = (rect.y + rect.height as i32 - panel_h as i32).max(rect.y);
    let (x, y) = preferred.unwrap_or((max_x, max_y));
    (x.clamp(rect.x, max_x), y.clamp(rect.y, max_y))
}

/// Start at the bottom right of the island's monitor, above the taskbar.
pub fn place_panel(panel: &Window, island: &Window) {
    layout_panel(panel, island, false);
}

/// Retain the user's dragged position, correcting only off-screen coordinates.
pub fn keep_panel_visible(panel: &Window) {
    layout_panel(panel, panel, true);
}

fn layout_panel(panel: &Window, reference: &Window, preserve_position: bool) {
    #[cfg(target_os = "macos")]
    { macos::layout_panel(panel, reference, preserve_position); }
    #[cfg(not(target_os = "macos"))]
    {
    let fallback = monitor_rect(reference, 1920, 1080);
    #[cfg(target_os = "windows")]
    let area = native::work_area(reference).unwrap_or(fallback);
    #[cfg(not(target_os = "windows"))]
    let area = fallback;
    let preferred = if preserve_position {
        panel.outer_position().ok().map(|position| (position.x, position.y))
    } else { None };
    // Establish the target monitor before sizing; DPI can differ across displays.
    if !preserve_position {
        panel.set_outer_position(PhysicalPosition::new(area.x, area.y));
    }
    let scale = reference.scale_factor();
    let margin = (20.0 * scale).round() as u32;
    let inner = panel.inner_size();
    let outer = panel.outer_size();
    let frame_w = outer.width.saturating_sub(inner.width);
    let frame_h = outer.height.saturating_sub(inner.height);
    let available_w = area.width.saturating_sub(2 * margin).saturating_sub(frame_w).max(1);
    let available_h = area.height.saturating_sub(2 * margin).saturating_sub(frame_h).max(1);
    panel.set_inner_size(PhysicalSize::new(
        ((PANEL_W * scale).round() as u32).min(available_w),
        ((PANEL_H * scale).round() as u32).min(available_h),
    ));
    let measured = panel.outer_size();
    let safe_area = ScreenRect {
        x: area.x + margin as i32,
        y: area.y + margin as i32,
        width: area.width.saturating_sub(2 * margin),
        height: area.height.saturating_sub(2 * margin),
    };
    let (x, y) = panel_position_in(safe_area, measured.width, measured.height, preferred);
    panel.set_outer_position(PhysicalPosition::new(x, y));
    }
}

/// Uses the user's notification sound without blocking the UI thread.
pub fn play_completion_sound() -> bool {
    #[cfg(target_os = "windows")]
    { native::play_sound() }
    #[cfg(target_os = "macos")]
    { macos::play_sound() }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    { false }
}

/// Use the existing tray GUID so completion reminders never create another tray icon.
/// Windows may suppress the notification according to the user's OS preferences.
pub fn notify_completion(tray: &tray_icon::TrayIcon, task: &str) -> bool {
    #[cfg(target_os = "windows")]
    { native::notify(tray.window_handle() as isize, task) }
    #[cfg(target_os = "macos")]
    { let _ = tray; macos::notify(task) }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    { let _ = (tray, task); false }
}

pub struct Geometry {
    pub scale_factor: f64,
    pub pill_w: f64,
    pub pill_h: f64,
    pub dial: f64,
}

impl Geometry {
    pub fn to_json(&self) -> String {
        format!("{{\"scaleFactor\":{},\"pillW\":{},\"pillH\":{},\"dial\":{},\"effect\":{}}}",
            self.scale_factor, self.pill_w, self.pill_h, self.dial, EFFECT)
    }
}

pub fn logical_size(w: f64, h: f64) -> LogicalSize<f64> { LogicalSize::new(w, h) }

#[cfg(target_os = "windows")]
mod native {
    use super::{ClipRegion, PhysicalPosition, PhysicalSize, ScreenRect, Window};
    use std::cell::Cell;
    use tao::platform::windows::WindowExtWindows;

    #[repr(C)]
    #[derive(Default)]
    struct Rect { left: i32, top: i32, right: i32, bottom: i32 }
    #[repr(C)]
    #[derive(Default)]
    struct Point { x: i32, y: i32 }
    #[repr(C)]
    struct MonitorInfo { size: u32, monitor: Rect, work: Rect, flags: u32 }
    #[repr(C)]
    struct Guid { data1: u32, data2: u16, data3: u16, data4: [u8; 8] }
    #[repr(C)]
    struct NotifyIconData {
        size: u32, hwnd: isize, id: u32, flags: u32, callback_message: u32,
        icon: isize, tip: [u16; 128], state: u32, state_mask: u32,
        info: [u16; 256], timeout_or_version: u32, title: [u16; 64],
        info_flags: u32, guid: Guid, balloon_icon: isize,
    }

    #[link(name = "user32")]
    extern "system" {
        fn SetWindowRgn(hwnd: isize, region: isize, redraw: i32) -> i32;
        fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, width: i32, height: i32, flags: u32) -> i32;
        fn MonitorFromWindow(hwnd: isize, flags: u32) -> isize;
        fn GetMonitorInfoW(monitor: isize, info: *mut MonitorInfo) -> i32;
        fn MessageBeep(kind: u32) -> i32;
        fn GetCursorPos(point: *mut Point) -> i32;
    }
    #[link(name = "gdi32")]
    extern "system" {
        fn CreateRectRgn(left: i32, top: i32, right: i32, bottom: i32) -> isize;
        fn CreateRoundRectRgn(left: i32, top: i32, right: i32, bottom: i32, ellipse_width: i32, ellipse_height: i32) -> isize;
        fn DeleteObject(object: isize) -> i32;
        #[cfg(test)]
        fn PtInRegion(region: isize, x: i32, y: i32) -> i32;
    }
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(hwnd: isize, attribute: u32, value: *const u32, size: u32) -> i32;
    }
    #[link(name = "shell32")]
    extern "system" { fn Shell_NotifyIconW(message: u32, data: *const NotifyIconData) -> i32; }

    thread_local! {
        // Only the island uses a region. Clear this cache when an HWND is
        // configured so a future reused handle cannot inherit an old key.
        static APPLIED_REGION: Cell<Option<(isize, Option<ClipRegion>)>> = const { Cell::new(None) };
    }

    pub fn forget_region(window: &Window) {
        APPLIED_REGION.with(|cache| {
            if cache.get().is_some_and(|(hwnd, _)| hwnd == window.hwnd()) { cache.set(None); }
        });
    }

    pub fn apply_region(window: &Window, region: Option<ClipRegion>) -> bool {
        // SetWindowRgn coordinates use the outer window, not its client area.
        let region = if let Some(mut region) = region {
            let (Ok(outer), Ok(inner)) = (window.outer_position(), window.inner_position()) else { return false; };
            let dx = inner.x - outer.x;
            let dy = inner.y - outer.y;
            region.left += dx; region.right += dx;
            region.top += dy; region.bottom += dy;
            Some(region)
        } else { None };
        let key = (window.hwnd(), region);
        if APPLIED_REGION.with(|cache| cache.get() == Some(key)) { return true; }
        // A null region restores the complete effect canvas. The parent region
        // also clips WebView child HWNDs and excludes its exterior from hit tests.
        let handle = if let Some(region) = region {
            let handle = unsafe {
                if region.corner_diameter > 0 {
                    CreateRoundRectRgn(region.left, region.top, region.right, region.bottom,
                        region.corner_diameter, region.corner_diameter)
                } else {
                    CreateRectRgn(region.left, region.top, region.right, region.bottom)
                }
            };
            if handle == 0 { return false; }
            handle
        } else { 0 };
        let applied = unsafe { SetWindowRgn(window.hwnd(), handle, 1) != 0 };
        if applied {
            // Windows owns a successfully installed HRGN; never DeleteObject it.
            APPLIED_REGION.with(|cache| cache.set(Some(key)));
        } else if handle != 0 {
            unsafe { let _ = DeleteObject(handle); }
        }
        applied
    }

    pub fn move_resize(window: &Window, position: PhysicalPosition<i32>, size: PhysicalSize<u32>) -> bool {
        // Called on the tao event-loop thread. Omit SWP_ASYNCWINDOWPOS so the
        // request can be acknowledged only after the native rectangle applies.
        // Preserve z-order, focus and existing DWM transparency/frame styles.
        unsafe {
            SetWindowPos(window.hwnd(), 0, position.x, position.y,
                size.width as i32, size.height as i32, 0x0004 | 0x0010) != 0
        }
    }

    pub fn remove_window_border(window: &Window) {
        // DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE (Windows 11+).
        // Older Windows versions ignore this unsupported attribute; the window
        // still has no decorations or native shadow.
        // https://learn.microsoft.com/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute
        let color: u32 = 0xFFFF_FFFE;
        unsafe { let _ = DwmSetWindowAttribute(window.hwnd(), 34, &color, 4); }
    }

    pub fn work_area(window: &Window) -> Option<ScreenRect> {
        let mut info = MonitorInfo {
            size: std::mem::size_of::<MonitorInfo>() as u32,
            monitor: Rect::default(), work: Rect::default(), flags: 0,
        };
        // SAFETY: tao owns the HWND; the output buffer has the documented size/layout.
        let success = unsafe { GetMonitorInfoW(MonitorFromWindow(window.hwnd(), 2), &mut info) };
        (success != 0).then_some(ScreenRect {
            x: info.work.left, y: info.work.top,
            width: (info.work.right - info.work.left).max(0) as u32,
            height: (info.work.bottom - info.work.top).max(0) as u32,
        })
    }

    pub fn cursor_position() -> Option<PhysicalPosition<i32>> {
        let mut point = Point::default();
        (unsafe { GetCursorPos(&mut point) } != 0)
            .then_some(PhysicalPosition::new(point.x, point.y))
    }

    pub fn play_sound() -> bool {
        // MessageBeep plays asynchronously and honors the configured system sound.
        unsafe { MessageBeep(0x40) != 0 }
    }

    fn text_into<const N: usize>(target: &mut [u16; N], text: &str) {
        target.fill(0);
        let mut used = 0;
        for ch in text.chars().filter(|ch| *ch != '\0') {
            let mut buffer = [0u16; 2];
            let units = ch.encode_utf16(&mut buffer);
            if used + units.len() >= N { break; }
            target[used..used + units.len()].copy_from_slice(units);
            used += units.len();
        }
    }

    pub fn notify(hwnd: isize, task: &str) -> bool {
        // SAFETY: The Win32 POD consists entirely of integer fields/arrays.
        let mut data: NotifyIconData = unsafe { std::mem::zeroed() };
        data.size = std::mem::size_of::<NotifyIconData>() as u32;
        data.hwnd = hwnd;
        data.flags = 0x10 | 0x20; // NIF_INFO | NIF_GUID
        let guid = super::TRAY_GUID;
        data.guid = Guid {
            data1: (guid >> 96) as u32,
            data2: (guid >> 80) as u16,
            data3: (guid >> 64) as u16,
            data4: (guid as u64).to_be_bytes(),
        };
        text_into(&mut data.title, "Focus Island · 时间到");
        let body = if task.trim().is_empty() { "本次专注已完成。".to_string() }
            else { format!("{} · 专注已完成。", task) };
        text_into(&mut data.info, &body);
        // Sound has its own setting; the notification must never add another sound.
        data.info_flags = 0x01 | 0x10 | 0x80; // INFO | NOSOUND | RESPECT_QUIET_TIME
        // The existing tray icon owns its lifetime and recovers after Explorer restarts.
        unsafe { Shell_NotifyIconW(1, &data) != 0 } // NIM_MODIFY
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn utf16_truncation_preserves_whole_unicode_characters() {
            let mut output = [0u16; 5];
            text_into(&mut output, "ab😀z");
            assert_eq!(String::from_utf16(&output[..4]).unwrap(), "ab😀");
            assert_eq!(output[4], 0);
            let mut short = [0u16; 4];
            text_into(&mut short, "ab😀");
            assert_eq!(&short, &[97, 98, 0, 0]);
        }
        #[test]
        fn native_capsule_excludes_corners_but_includes_visible_content() {
            let clip = super::super::island_region(super::super::IslandShape::Pill, 1.5).unwrap();
            let region = unsafe { CreateRoundRectRgn(clip.left, clip.top, clip.right, clip.bottom,
                clip.corner_diameter, clip.corner_diameter) };
            assert_ne!(region, 0);
            let center_inside = unsafe { PtInRegion(region, 435, 208) != 0 };
            let left_edge_inside = unsafe { PtInRegion(region, 336, 208) != 0 };
            let transparent_corner_inside = unsafe { PtInRegion(region, clip.left, clip.top) != 0 };
            let exterior_inside = unsafe { PtInRegion(region, 600, 208) != 0 };
            unsafe { let _ = DeleteObject(region); }
            assert!(center_inside && left_edge_inside);
            assert!(!transparent_corner_inside && !exterior_inside);
        }
        #[test]
        fn native_capsule_preserves_all_antialias_and_shadow_pixels_across_dpi() {
            use super::super::{island_region, IslandShape, SHADOW_EXTENT};
            for scale in [1.0, 1.25, 1.5, 1.75, 2.0] {
                let clip = island_region(IslandShape::Pill, scale).unwrap();
                let region = unsafe { CreateRoundRectRgn(clip.left, clip.top, clip.right,
                    clip.bottom, clip.corner_diameter, clip.corner_diameter) };
                assert_ne!(region, 0);
                let mut clipped = Vec::new();
                for halo in [0.0, SHADOW_EXTENT] {
                    let left = (224.0 - halo) * scale;
                    let top = (120.0 - halo) * scale;
                    let width = (132.0 + 2.0 * halo) * scale;
                    let radius = (19.0 + halo) * scale;
                    let segment_left = left + radius;
                    let segment_right = left + width - radius;
                    let center_y = top + radius;
                    for y in top.floor() as i32..(top + 2.0 * radius).ceil() as i32 {
                        for x in left.floor() as i32..(left + width).ceil() as i32 {
                            // The ideal capsule is a horizontal segment plus a disk.
                            // Any pixel square nearer than the radius has positive
                            // coverage, even when its pixel center lies outside.
                            let dx = 0.0_f64.max(segment_left - (x + 1) as f64)
                                .max(x as f64 - segment_right);
                            let dy = 0.0_f64.max(center_y - (y + 1) as f64)
                                .max(y as f64 - center_y);
                            if dx * dx + dy * dy < radius * radius - 1e-9
                                && unsafe { PtInRegion(region, x, y) == 0 } {
                                clipped.push((halo, x, y));
                            }
                        }
                    }
                }
                unsafe { let _ = DeleteObject(region); }
                assert!(clipped.is_empty(), "DPI {scale}: clipped coverage {clipped:?}");
            }
        }
        #[test]
        fn notification_abi_matches_windows_sdk() {
            assert_eq!(std::mem::size_of::<NotifyIconData>(), if cfg!(target_pointer_width = "64") { 976 } else { 956 });
            assert_eq!(std::mem::size_of::<MonitorInfo>(), 40);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn input_policy_preserves_our_drag_and_does_not_steal_external_drags() {
        assert_eq!(overlay_mouse_policy(true, true, true, true, false, false), (true, false));
        assert_eq!(overlay_mouse_policy(true, false, true, true, true, true), (true, false));
        assert_eq!(overlay_mouse_policy(true, false, true, false, true, true), (false, true));
        assert_eq!(overlay_mouse_policy(true, true, false, true, true, false), (false, true));
        assert_eq!(overlay_mouse_policy(true, true, false, false, true, false), (false, false));
        assert_eq!(overlay_mouse_policy(false, true, true, true, true, true), (false, true));
    }

    #[test]
    fn transparent_canvas_hit_test_is_bounded_across_retina_scales() {
        for scale in [1.0, 1.25, 1.5, 1.75, 2.0, 3.0] {
            assert!(island_hit_test(IslandShape::Pill, 290.0, 139.0, scale));
            assert!(island_hit_test(IslandShape::Pill, 224.0, 139.0, scale));
            assert!(island_hit_test(IslandShape::Pill, 290.0, 115.0, scale));
            assert!(!island_hit_test(IslandShape::Pill, 214.0, 139.0, scale));
            assert!(!island_hit_test(IslandShape::Pill, 215.0, 111.0, scale));
            assert!(!island_hit_test(IslandShape::Pill, 290.0, 200.0, scale));
            assert!(island_hit_test(IslandShape::Dial, 130.0, 125.0, scale));
            assert!(island_hit_test(IslandShape::Dial, 450.0, 450.0, scale));
            assert!(!island_hit_test(IslandShape::Dial, 90.0, 290.0, scale));
            assert!(island_hit_test(IslandShape::Effect, 579.9, 579.9, scale));
            assert!(!island_hit_test(IslandShape::Effect, 580.0, 200.0, scale));
        }
        for (x, y, scale) in [(f64::NAN, 139.0, 1.0), (290.0, f64::INFINITY, 1.0),
                              (290.0, 139.0, 0.0), (290.0, 139.0, f64::NAN)] {
            assert!(!island_hit_test(IslandShape::Pill, x, y, scale));
        }
    }

    #[test]
    fn pill_region_matches_the_stable_canvas_with_shadow_and_antialias_margin() {
        assert_eq!(island_region(IslandShape::Pill, 1.0), Some(ClipRegion {
            left: 215, top: 111, right: 365, bottom: 167, corner_diameter: 56,
        }));
        assert_eq!(island_region(IslandShape::Pill, 1.5), Some(ClipRegion {
            left: 324, top: 168, right: 546, bottom: 249, corner_diameter: 81,
        }));
    }
    #[test]
    fn dial_region_contains_the_entire_morph_and_effect_is_unclipped() {
        assert_eq!(island_region(IslandShape::Dial, 1.0), Some(ClipRegion {
            left: 111, top: 111, right: 469, bottom: 469, corner_diameter: 0,
        }));
        for scale in [1.0, 1.25, 1.5, 1.75, 2.0] {
            let pill = island_region(IslandShape::Pill, scale).unwrap();
            let dial = island_region(IslandShape::Dial, scale).unwrap();
            assert!(pill.left >= dial.left && pill.right <= dial.right);
            assert!(pill.top >= dial.top && pill.bottom <= dial.bottom);
            assert_eq!(island_region(IslandShape::Effect, scale), None);
        }
    }
    #[test]
    fn cursor_coordinates_follow_client_origin_and_monitor_dpi() {
        for scale in [1.0, 1.25, 1.5, 1.75, 2.0] {
            let origin = PhysicalPosition::new(-2560, (-100.0 * scale) as i32);
            let cursor = PhysicalPosition::new(origin.x + (240.0 * scale) as i32,
                origin.y + (200.0 * scale) as i32);
            assert_eq!(cursor_logical_coordinates(cursor, origin, scale), Some((240.0, 200.0)));
        }
        assert_eq!(cursor_logical_coordinates(PhysicalPosition::new(-2700, -325),
            PhysicalPosition::new(-2560, -200), 1.25), Some((-112.0, -100.0)));
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(cursor_logical_coordinates(PhysicalPosition::new(0, 0),
                PhysicalPosition::new(0, 0), scale), None);
        }
    }
    #[test]
    fn panel_bottom_right_on_negative_monitor() {
        let area = ScreenRect { x: -1920, y: -200, width: 1920, height: 1040 };
        let (x, y) = panel_position_in(area, 510, 800, None);
        assert_eq!(x, -510);
        assert_eq!(y, 40);
        assert!(x >= area.x && y >= area.y);
    }
    #[test]
    fn panel_preserves_dragged_position_and_clamps_offscreen() {
        let area = ScreenRect { x: 100, y: 50, width: 1000, height: 900 };
        assert_eq!(panel_position_in(area, 340, 300, Some((300, 150))), (300, 150));
        assert_eq!(panel_position_in(area, 340, 300, Some((-200, 1200))), (100, 650));
    }
    #[test]
    fn panel_large_enough_to_exceed_screen_stays_at_origin() {
        let area = ScreenRect { x: -800, y: 50, width: 800, height: 500 };
        assert_eq!(panel_position_in(area, 900, 620, None), (-800, 50));
    }
    #[test]
    fn requested_top_offset_is_bounded_for_the_expanded_dial() {
        for (requested, expected) in [(0.0, 0.0), (20.0, 20.0), (1000.0, 700.0)] {
            assert_eq!(bounded_top_offset(requested, 0.0, 1040.0), expected);
        }
        // A screen shorter than the dial keeps its top visible rather than
        // introducing a negative offset. macOS uses these same logical bounds.
        for height in [0.0, 200.0, 339.0, 340.0] {
            for requested in [0.0, 20.0, 1000.0] {
                assert_eq!(bounded_top_offset(requested, 0.0, height), 0.0);
            }
        }
        assert_eq!(bounded_top_offset(20.0, 40.0, 1040.0), 40.0);
        assert_eq!(bounded_top_offset(1000.0, 40.0, 300.0), 40.0);
        assert_eq!(bounded_top_offset(-10.0, 0.0, 1040.0), 0.0);
        assert_eq!(bounded_top_offset(f64::NAN, 0.0, 1040.0), 20.0);
        assert_eq!(bounded_top_offset(2000.0, 0.0, 2000.0), 1000.0);
    }

    #[test]
    fn stable_viewport_keeps_all_shapes_at_the_configured_anchor_across_dpi() {
        for scale in [1.0, 1.25, 1.5, 1.75, 2.0] {
            let canvas = LogicalSize::new(EFFECT, EFFECT).to_physical::<u32>(scale);
            let monitor = ScreenRect { x: -2560, y: -200,
                width: (1920.0 * scale) as u32, height: (1080.0 * scale) as u32 };
            let work_area = ScreenRect { height: (1040.0 * scale) as u32, ..monitor };
            for requested in [0.0_f64, 20.0, 1000.0] {
                let (x, y) = island_position(monitor, work_area, canvas.width, scale, requested);
                let expected_top = monitor.y + (requested.min(700.0) * scale).round() as i32;
                assert!(((x - monitor.x) * 2 + canvas.width as i32 - monitor.width as i32).abs() <= 1);
                // The effect canvas has this same origin; only the clip region changes.
                assert_eq!(y + (120.0 * scale).round() as i32, expected_top);
                assert!(expected_top as f64 + DIAL * scale
                    <= work_area.y as f64 + work_area.height as f64);
                for shape in [IslandShape::Pill, IslandShape::Dial] {
                    let region = island_region(shape, scale).unwrap();
                    assert_eq!(region.left + region.right, canvas.width as i32);
                    let padding = (SHADOW_EXTENT * scale).ceil() as i32 + REGION_AA_GUARD;
                    assert_eq!(y + region.top + padding, expected_top);
                }
            }
        }
    }

    #[test]
    fn top_taskbar_and_tiny_monitor_keep_the_visible_anchor_on_screen() {
        let monitor = ScreenRect { x: -1280, y: 300, width: 1280, height: 800 };
        let top_taskbar = ScreenRect { y: 340, height: 760, ..monitor };
        for requested in [0.0, 20.0] {
            let (_, y) = island_position(monitor, top_taskbar, 580, 1.0, requested);
            assert_eq!(y + 120, 340);
        }
        let tiny = ScreenRect { height: 300, ..monitor };
        for requested in [0.0, 20.0, 1000.0] {
            let (_, y) = island_position(tiny, tiny, 580, 1.0, requested);
            assert_eq!(y + 120, tiny.y);
        }
    }

    #[test]
    fn fractional_dpi_rounding_does_not_push_dial_into_bottom_taskbar() {
        for scale in [1.0625, 1.1, 1.3333333333333333] {
            let monitor = ScreenRect { x: -3000, y: -125, width: 1920, height: 1080 };
            let work_area = ScreenRect { height: 1039, ..monitor };
            let canvas = LogicalSize::new(EFFECT, EFFECT).to_physical::<u32>(scale);
            let (_, y) = island_position(monitor, work_area, canvas.width, scale, 1000.0);
            let visible_top = y + (120.0 * scale).round() as i32;
            assert!(visible_top >= monitor.y);
            assert!(visible_top as f64 + DIAL * scale
                <= work_area.y as f64 + work_area.height as f64);
        }
    }
}
