//! AppKit integration; all window operations stay on tao's main event-loop thread.
//! Geometry is kept in Cocoa points so mixed-Retina monitor origins never share
//! an incorrectly scaled physical desktop coordinate system.

use super::{bounded_top_offset, island_hit_test, overlay_mouse_policy, IslandShape, Window, DIAL, EFFECT, PANEL_H, PANEL_W};
use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread, MainThreadMarker};
use objc2_app_kit::{
    NSBeep, NSColor, NSEvent, NSScreen, NSView, NSWindow, NSWindowAnimationBehavior,
    NSWindowCollectionBehavior,
};
use objc2_foundation::{NSBundle, NSError, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use std::cell::{Cell, RefCell};
use std::sync::atomic::{AtomicU64, Ordering};
use tao::platform::macos::WindowExtMacOS;

fn native_window(window: &Window) -> Option<&NSWindow> {
    MainThreadMarker::new()?;
    // SAFETY: tao retains this NSWindow for the lifetime of Window. The main
    // thread check above is required before accessing an AppKit object.
    unsafe { (window.ns_window() as *const NSWindow).as_ref() }
}

fn native_view(window: &Window) -> Option<&NSView> {
    MainThreadMarker::new()?;
    // SAFETY: this is tao's retained content NSView, borrowed only with Window.
    unsafe { (window.ns_view() as *const NSView).as_ref() }
}

fn screen_for(window: &NSWindow) -> Option<Retained<NSScreen>> {
    window.screen().or_else(|| NSScreen::mainScreen(MainThreadMarker::new()?))
}

fn same_rect(a: NSRect, b: NSRect) -> bool {
    (a.origin.x - b.origin.x).abs() < 0.01 && (a.origin.y - b.origin.y).abs() < 0.01
        && (a.size.width - b.size.width).abs() < 0.01
        && (a.size.height - b.size.height).abs() < 0.01
}

pub(super) fn configure_overlay(window: &Window) {
    let Some(native) = native_window(window) else { return; };
    native.setOpaque(false);
    native.setBackgroundColor(Some(&NSColor::clearColor()));
    native.setHasShadow(false); // The glass decoration owns its bounded soft shadow.
    native.setHidesOnDeactivate(false);
    native.setAnimationBehavior(NSWindowAnimationBehavior::None);
    native.setCollectionBehavior(native.collectionBehavior()
        | NSWindowCollectionBehavior::CanJoinAllSpaces
        | NSWindowCollectionBehavior::FullScreenAuxiliary);
}

pub(super) fn resize_to(window: &Window, shape: IslandShape, top_offset: f64) -> bool {
    let Some(native) = native_window(window) else { return false; };
    let Some(screen) = screen_for(native) else { return false; };
    let area = screen.visibleFrame();
    let top_offset = bounded_top_offset(top_offset, 0.0, area.size.height);
    // AppKit's origin is bottom-left. Apply the configured distance below the
    // usable top edge (menu bar/notch excluded), reserving the expanded dial.
    // Every shape keeps the same 580-point canvas and viewport origin.
    let content = NSRect::new(
        NSPoint::new(area.origin.x + (area.size.width - EFFECT) / 2.0,
            area.origin.y + area.size.height - top_offset + (EFFECT - DIAL) / 2.0 - EFFECT),
        NSSize::new(EFFECT, EFFECT),
    );
    let desired = native.frameRectForContentRect(content);
    if !same_rect(native.frame(), desired) {
        // Synchronous, no animation, and no resize at all for shape transitions.
        native.setFrame_display(desired, true);
    }
    poll_hit_test(window, shape, native.isVisible());
    true
}

pub(super) fn cursor_position(window: &Window) -> Option<(f64, f64)> {
    let native = native_window(window)?;
    let view = native_view(window)?;
    // NSEvent.mouseLocation remains available while this window ignores input.
    // AppKit performs the monitor/backing-scale conversions in logical points.
    let point = view.convertPoint_fromView(native.convertPointFromScreen(NSEvent::mouseLocation()), None);
    let bounds = view.bounds();
    let x = point.x - bounds.origin.x;
    let y = if view.isFlipped() { point.y - bounds.origin.y }
        else { bounds.origin.y + bounds.size.height - point.y };
    (x.is_finite() && y.is_finite()).then_some((x, y))
}

#[derive(Clone, Copy, Default)]
struct MouseCapture { window: usize, buttons: usize, active: bool }
thread_local! {
    static CAPTURE: Cell<MouseCapture> = Cell::new(MouseCapture::default());
}

pub(super) fn poll_hit_test(window: &Window, shape: IslandShape, visible: bool) {
    let Some(native) = native_window(window) else { return; };
    let handle = window.ns_window() as usize;
    let buttons = NSEvent::pressedMouseButtons();
    let hit = visible && cursor_position(window)
        .is_some_and(|(x, y)| island_hit_test(shape, x, y, native.backingScaleFactor()));
    let ignore = CAPTURE.with(|capture| {
        let previous = capture.get();
        // Preserve an island-originated drag until all mouse buttons release.
        // A drag that began in another app must not be captured on entry.
        let (active, ignore) = overlay_mouse_policy(visible, hit, !native.ignoresMouseEvents(),
            buttons != 0, previous.window != handle || previous.buttons != 0,
            previous.window == handle && previous.active);
        capture.set(MouseCapture { window: handle, buttons, active });
        ignore
    });
    if native.ignoresMouseEvents() != ignore {
        // Only input delivery changes; never alter opacity, style mask, size or
        // backing layers. This cannot reintroduce the Windows layered-window flash.
        native.setIgnoresMouseEvents(ignore);
    }
}

pub(super) fn layout_panel(panel: &Window, reference: &Window, preserve_position: bool) {
    let (Some(native), Some(reference)) = (native_window(panel), native_window(reference)) else { return; };
    let Some(screen) = screen_for(reference) else { return; };
    let area = screen.visibleFrame();
    let margin = 20.0_f64.min(area.size.width / 4.0).min(area.size.height / 4.0);
    let current = native.frame();
    let content = native.contentRectForFrameRect(current);
    let extra_w = (current.size.width - content.size.width).max(0.0);
    let extra_h = (current.size.height - content.size.height).max(0.0);
    let width = (PANEL_W + extra_w).min((area.size.width - 2.0 * margin).max(1.0));
    let height = (PANEL_H + extra_h).min((area.size.height - 2.0 * margin).max(1.0));
    let min_x = area.origin.x + margin;
    let min_y = area.origin.y + margin;
    let max_x = (area.origin.x + area.size.width - margin - width).max(min_x);
    let max_y = (area.origin.y + area.size.height - margin - height).max(min_y);
    let (x, y) = if preserve_position {
        (current.origin.x.clamp(min_x, max_x), current.origin.y.clamp(min_y, max_y))
    } else { (max_x, min_y) };
    let desired = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
    if !same_rect(current, desired) { native.setFrame_display(desired, true); }
}

pub(super) fn play_sound() -> bool {
    if MainThreadMarker::new().is_none() { return false; }
    NSBeep();
    true
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements; no mutable shared ivars.
    #[unsafe(super = NSObject)]
    #[name = "FocusIslandNotificationDelegate"]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}
    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(&self, _center: &UNUserNotificationCenter, _notification: &UNNotification,
                        completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
            // Also show completion while the panel or island is the active app.
            // Sound is independently controlled by the user's sound preference.
            completion.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List,));
        }
    }
);

impl NotificationDelegate {
    fn new() -> Retained<Self> {
        // SAFETY: NSObject's init has this signature and requires no extra state.
        unsafe { msg_send![Self::alloc(), init] }
    }
}

thread_local! {
    // UNUserNotificationCenter.delegate is weak; retain our delegate for the app.
    static NOTIFICATION_DELEGATE: RefCell<Option<Retained<NotificationDelegate>>> = const { RefCell::new(None) };
}
static NOTIFICATION_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub(super) fn notify(task: &str) -> bool {
    if MainThreadMarker::new().is_none() || NSBundle::mainBundle().bundleIdentifier().is_none() {
        // Apple's notification center requires an application bundle identity.
        // Running an unbundled cargo binary must not crash to send a reminder.
        return false;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    NOTIFICATION_DELEGATE.with(|stored| {
        let mut stored = stored.borrow_mut();
        let delegate = stored.get_or_insert_with(NotificationDelegate::new);
        center.setDelegate(Some(ProtocolObject::from_ref(&**delegate)));
    });
    let body = if task.trim().is_empty() { "本次专注已完成。".to_owned() }
        else { format!("{} · 专注已完成。", task) };
    let sequence = NOTIFICATION_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let authorization = RcBlock::new(move |granted: Bool, error: *mut NSError| {
        if !error.is_null() || !granted.as_bool() {
            crate::log("macOS completion notification permission unavailable");
            return;
        }
        // Authorization may finish on a background thread. These Foundation/UN
        // objects are created and used on that same callback thread, never sent.
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str("Focus Island · 时间到"));
        content.setBody(&NSString::from_str(&body));
        let identifier = NSString::from_str(&format!("focus-complete-{}-{}", std::process::id(), sequence));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&identifier, &content, None);
        let completed = RcBlock::new(|error: *mut NSError| {
            if !error.is_null() { crate::log("macOS completion notification scheduling failed"); }
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .addNotificationRequest_withCompletionHandler(&request, Some(&completed));
    });
    // First completion requests permission in context; later calls use the OS's
    // saved choice. This function only reports that asynchronous work was queued.
    center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert, &authorization);
    true
}
