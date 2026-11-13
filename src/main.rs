//! Focus Island: native windows, IPC routing, persistence and diagnostics.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod state;
mod actions;
mod window;
mod phone;
mod webhook;
mod relay;

use state::{AppState, CompletionAction, Settings, Task};
use actions::{ActionController, ExecutionResult, TimerCompletion, TimerUpdate};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;
#[cfg(target_os = "windows")]
use tao::platform::windows::WindowBuilderExtWindows;
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder, TrayIconEvent};
use wry::{WebContext, WebView, WebViewBuilder};
#[cfg(target_os = "windows")]
use wry::WebViewBuilderExtWindows;

#[derive(Debug, Clone)]
struct TaskCreateRequest {
    name: Option<String>,
    sec: Option<u64>,
    completion_action: Option<serde_json::Value>,
    request_id: u64,
}

#[derive(Debug, Clone)]
struct TaskDurationRequest {
    // Keep malformed correlation values intact so every recognized request gets
    // a matching failure response instead of disappearing during IPC parsing.
    task_id: serde_json::Value,
    sec: Option<u64>,
    request_id: serde_json::Value,
}

#[derive(Debug, Clone)]
enum Command {
    SetShape(bool, u64),
    SetEffect(bool, u64),
    SetNotificationShape(bool, u64),
    SetNotificationLayout(window::NotificationLayout, u64),
    NotificationsConfigure(serde_json::Value),
    NotificationTest,
    WebhookConfigure(serde_json::Value, u64),
    WebhookRotateToken(u64),
    WebhookStatus,
    WebhookTest(u64),
    WebhookTestFinished(u64, Result<String, String>),
    WebhookEvent(webhook::WebhookEvent),
    RelayConfigure(serde_json::Value, u64),
    RelayStatus,
    RelayEvent(relay::RelayEvent),
    RelayAcknowledged(relay::RelayEvent),
    PhoneConfigure(serde_json::Value),
    PhoneScan,
    PhoneConnect(String),
    PhoneDisconnect,
    PhoneEvent(phone::PhoneEvent),
    SetDuration(u64),
    ToggleTimer,
    ResetTimer,
    AddTask(TaskCreateRequest),
    SetTaskDuration(TaskDurationRequest),
    RemoveTask(String),
    SelectTask(String),
    ClearTasks,
    UpdateSettings(Settings),
    WatchCursor(bool),
    TimerState(serde_json::Value),
    TimerDone(TimerCompletion),
    SetCompletionAction(String, serde_json::Value),
    CancelCompletionAction(String),
    ActionFinished(String, ExecutionResult),
    TogglePanel,
    ShowPanel,
    HidePanel,
    DragPanel,
    PageReady(String),
    AnimationDone,
    SelftestResult(bool, String),
    FrontendError(String),
    Quit,
}

fn parse_command(raw: &str) -> Option<Command> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let request_id = v.get("requestId").and_then(serde_json::Value::as_u64).unwrap_or(0);
    Some(match v.get("type")?.as_str()? {
        "setShape" => Command::SetShape(v.get("open")?.as_bool()?, request_id),
        "setEffect" => Command::SetEffect(v.get("active")?.as_bool()?, request_id),
        "setNotificationShape" => Command::SetNotificationShape(v.get("active")?.as_bool()?, request_id),
        "setNotificationLayout" => Command::SetNotificationLayout(window::NotificationLayout::from_value(&v)?, request_id),
        "notificationsConfigure" => Command::NotificationsConfigure(v.get("settings").cloned().unwrap_or(serde_json::Value::Null)),
        "notificationTest" => Command::NotificationTest,
        "webhookConfigure" => Command::WebhookConfigure(v.get("settings").cloned().unwrap_or(serde_json::Value::Null), request_id),
        "webhookRotateToken" => Command::WebhookRotateToken(request_id),
        "webhookStatus" => Command::WebhookStatus,
        "relayStatus" => Command::RelayStatus,
        "relayConfigure" => Command::RelayConfigure(v.get("settings").cloned().unwrap_or(serde_json::Value::Null), request_id),
        "webhookTest" => Command::WebhookTest(request_id),
        "phoneConfigure" => Command::PhoneConfigure(v.get("settings").cloned().unwrap_or(serde_json::Value::Null)),
        "phoneScan" => Command::PhoneScan,
        "phoneConnect" => Command::PhoneConnect(v.get("address")?.as_str()?.into()),
        "phoneDisconnect" => Command::PhoneDisconnect,
        "setDuration" => Command::SetDuration(v.get("sec")?.as_u64()?),
        "toggleTimer" => Command::ToggleTimer,
        "resetTimer" => Command::ResetTimer,
        "addTask" => Command::AddTask(TaskCreateRequest {
            name: v.get("name").and_then(serde_json::Value::as_str).map(str::to_string),
            sec: v.get("sec").and_then(serde_json::Value::as_u64),
            completion_action: v.get("completionAction").cloned(),
            request_id,
        }),
        "setTaskDuration" => Command::SetTaskDuration(TaskDurationRequest {
            task_id: v.get("taskId").cloned().unwrap_or(serde_json::Value::Null),
            sec: v.get("sec").and_then(serde_json::Value::as_u64),
            request_id: v.get("requestId").cloned().unwrap_or(serde_json::Value::Null),
        }),
        "removeTask" => Command::RemoveTask(v.get("id")?.as_str()?.into()),
        "selectTask" => Command::SelectTask(v.get("id")?.as_str()?.into()),
        "clearTasks" => Command::ClearTasks,
        "updateSettings" => Command::UpdateSettings(serde_json::from_value(v.get("settings")?.clone()).ok()?),
        "watchCursor" => Command::WatchCursor(v.get("enabled")?.as_bool()?),
        "timerState" => Command::TimerState(v),
        "timerDone" => Command::TimerDone(serde_json::from_value(v).ok()?),
        "setCompletionAction" => Command::SetCompletionAction(v.get("taskId")?.as_str()?.into(), v.get("action")?.clone()),
        "cancelCompletionAction" => Command::CancelCompletionAction(v.get("runId")?.as_str()?.into()),
        "togglePanel" => Command::TogglePanel,
        "hidePanel" => Command::HidePanel,
        "dragPanel" => Command::DragPanel,
        "pageReady" => Command::PageReady(v.get("view")?.as_str()?.into()),
        "animationDone" => Command::AnimationDone,
        "selftestResult" => Command::SelftestResult(v.get("ok")?.as_bool()?, v.get("message").and_then(|s| s.as_str()).unwrap_or("").into()),
        "frontendError" => Command::FrontendError(v.get("message")?.as_str()?.into()),
        "quit" => Command::Quit,
        _ => return None,
    })
}

fn parse_view_command(raw: &str, island: bool) -> Option<Command> {
    let command = parse_command(raw)?;
    if !island && matches!(command, Command::TimerState(_) | Command::TimerDone(_) | Command::SetNotificationShape(_, _) | Command::SetNotificationLayout(_, _)) { return None; }
    // Network input never enters IPC; only the settings view may manage credentials.
    if island && matches!(command, Command::WebhookConfigure(_, _) | Command::WebhookRotateToken(_)
        | Command::WebhookStatus | Command::WebhookTest(_) | Command::RelayStatus | Command::RelayConfigure(_, _)) { return None; }
    Some(command)
}

/// Build and persist the entire new task before the caller changes live state.
/// A malformed action stays in the request so the UI receives an error result.
fn created_task_state(state: &AppState, request: &TaskCreateRequest, path: &std::path::Path)
    -> Result<(AppState, String), String> {
    let name = request.name.clone().ok_or("请填写有效的任务名称")?;
    let sec = request.sec.ok_or("任务时长须为有效的整数秒")?;
    let action = if let Some(value) = &request.completion_action {
        // Disk loading tolerates unknown future kinds by disabling them. New
        // task submissions should instead report a typo before creating a task.
        if let Some(kind) = value.get("kind") {
            if !matches!(kind.as_str(), Some("command" | "shell" | "lock" | "sleep" | "shutdown" | "restart")) {
                return Err("请选择有效的结束动作".into());
            }
        }
        serde_json::from_value::<CompletionAction>(value.clone())
            .map_err(|_| "动作配置格式不正确，延迟须为整数".to_string())?
    } else { CompletionAction::default() };
    let task = Task::try_new(name, sec, action)?;
    let task_id = task.id.clone();
    let mut updated = state.clone();
    updated.current_id = task.id.clone();
    updated.duration_sec = task.sec;
    updated.tasks.push(task);
    updated.save_to_path(path).map_err(|error| format!("创建任务失败：{}", error))?;
    Ok((updated, task_id))
}

/// Commit a task-duration edit before mutating live state or cancelling actions.
/// The result controls whether the island must reset/pause its current timer.
fn apply_task_duration(state: &mut AppState, actions: &mut ActionController,
    request: &TaskDurationRequest, path: &std::path::Path) -> Result<bool, String> {
    let task_id = request.task_id.as_str().filter(|id| !id.is_empty())
        .ok_or("请选择需要修改时长的任务")?;
    let sec = request.sec.filter(|sec| (1..=state::MAX_DURATION_SEC).contains(sec))
        .ok_or("任务时长须为 1 秒至 99:59:59 的整数秒")?;
    let index = state.tasks.iter().position(|task| task.id == task_id)
        .ok_or("任务不存在，请重新选择")?;
    let duration_changed = state.tasks[index].sec != sec;
    let reset_timer = duration_changed && state.current_id == task_id;
    let mut updated = state.clone();
    updated.tasks[index].sec = sec;
    if reset_timer { updated.duration_sec = sec; }
    updated.save_to_path(path).map_err(|error| format!("保存任务时长失败：{}", error))?;
    *state = updated;
    if reset_timer { actions.invalidate("任务时长已修改，本次动作已取消"); }
    Ok(reset_timer)
}

fn task_duration_result(request: &TaskDurationRequest, result: &Result<bool, String>) -> serde_json::Value {
    let (ok, message) = match result {
        Ok(true) => (true, "任务时长已保存，当前计时已重置"),
        Ok(false) => (true, "任务时长已保存"),
        Err(message) => (false, message.as_str()),
    };
    serde_json::json!({"ok":ok, "message":message,
        "taskId":request.task_id, "requestId":request.request_id})
}

fn updated_action_state(state: &AppState, task_id: &str, value: serde_json::Value) -> Result<AppState, String> {
    if task_id.is_empty() { return Err("请选择需要设置的任务".into()); }
    let index = state.tasks.iter().position(|task| task.id == task_id)
        .ok_or("任务不存在，请重新选择")?;
    let action: CompletionAction = serde_json::from_value(value)
        .map_err(|_| "动作配置格式不正确，延迟须为整数".to_string())?;
    action.validate().map_err(str::to_string)?;
    let mut updated = state.clone();
    updated.tasks[index].completion_action = action;
    Ok(updated)
}

fn push_callback<T: serde::Serialize>(webview: &WebView, callback: &str, payload: &T) {
    // Callback names are fixed Rust literals; all data is JSON, including errors.
    let json = serde_json::to_string(payload).expect("callback serialization").replace('<', "\\u003c");
    push(webview, &format!("window.{0} && window.{0}({1});", callback, json));
}

const CURSOR_SAMPLE_INTERVAL: Duration = Duration::from_millis(80);

#[derive(Default)]
struct CursorWatch {
    next_sample: Option<Instant>,
}

impl CursorWatch {
    fn set_enabled(&mut self, enabled: bool, now: Instant) {
        // A new gaze starts with a sample in this event-loop turn.
        self.next_sample = enabled.then_some(now);
    }

    fn take_due(&mut self, now: Instant) -> bool {
        if self.next_sample.is_some_and(|deadline| deadline <= now) {
            // No catch-up burst after the event loop has been busy.
            self.next_sample = Some(now + CURSOR_SAMPLE_INTERVAL);
            true
        } else {
            false
        }
    }
}

fn cursor_watch_allowed(settings: &Settings, visible: bool, island_open: bool, effect: bool) -> bool {
    visible && !island_open && !effect && settings.show_idle_eyes && !settings.reduce_motion
}

/// Strict UI validation, followed by an atomic save before live preferences change.
fn configured_phone_state(state: &AppState, value: &serde_json::Value, path: &std::path::Path)
    -> Result<AppState, String> {
    let enabled = value.get("enabled").and_then(|v| v.as_bool()).ok_or("请选择是否启用手机通知")?;
    let seconds = value.get("displaySeconds").and_then(|v| v.as_u64())
        .filter(|v| (3..=30).contains(v)).ok_or("通知展示时长须为 3–30 秒")?;
    let hidden = value.get("hideContent").and_then(|v| v.as_bool()).ok_or("请选择通知内容显示方式")?;
    if enabled && !cfg!(target_os = "windows") { return Err("本版手机通知支持 Windows + Android".into()); }
    let mut updated = state.clone();
    updated.phone.enabled = enabled;
    updated.phone.display_seconds = seconds;
    updated.phone.hide_content = hidden;
    updated.save_to_path(path).map_err(|e| format!("保存手机通知设置失败：{}", e))?;
    Ok(updated)
}

/// Saving notification preferences cannot affect timer state or source settings.
fn configured_notifications_state(state: &AppState, value: &serde_json::Value, path: &std::path::Path)
    -> Result<AppState, String> {
    let enabled = value.get("enabled").and_then(|v| v.as_bool()).ok_or("请选择是否开启通知框")?;
    let display_seconds = value.get("displaySeconds").and_then(|v| v.as_u64())
        .filter(|v| (1..=30).contains(v)).ok_or("消息停留时长须为 1–30 秒的整数")?;
    let list_limit = value.get("listLimit").and_then(|v| v.as_u64())
        .filter(|v| (1..=10).contains(v)).ok_or("消息列表数量须为 1–10 条的整数")?;
    let mut updated = state.clone();
    updated.notifications = state::NotificationSettings { enabled, display_seconds, list_limit };
    updated.save_to_path(path).map_err(|e| format!("保存通知框设置失败：{}", e))?;
    Ok(updated)
}


/// Bind and prepare workers before saving; activation follows a successful atomic save.
fn configured_webhook_state(state: &AppState, manager: &mut webhook::WebhookManager,
    value: Option<&serde_json::Value>, path: &std::path::Path) -> Result<AppState, String> {
    let mut updated = state.clone();
    if let Some(value) = value {
        updated.webhook.enabled = value.get("enabled").and_then(|v| v.as_bool()).ok_or("请选择是否开启 Webhook")?;
        updated.webhook.scope = value.get("scope").and_then(|v| v.as_str())
            .filter(|v| matches!(*v, "local" | "lan")).ok_or("请选择本机或局域网访问")?.into();
        updated.webhook.port = value.get("port").and_then(|v| v.as_u64())
            .filter(|v| (1024..=65535).contains(v)).ok_or("端口须为 1024–65535 之间的整数")? as u16;
        if let Some(base) = value.get("publicBaseUrl") {
            updated.webhook.public_base_url = state::normalized_public_base_url(base.as_str().ok_or("公网地址格式不正确")?)
                .ok_or("公网地址请填写 HTTPS 域名，不包含路径、查询参数或账号信息")?;
        }
    }
    if value.is_none() || !updated.webhook.has_valid_token() {
        updated.webhook.token = webhook::generate_token()?;
    }
    let prepared = manager.prepare(&updated.webhook)?;
    updated.save_to_path(path).map_err(|e| format!("保存 Webhook 设置失败：{}", e))?;
    manager.commit(prepared);
    Ok(updated)
}


fn configured_relay_state(state: &AppState, manager: &mut relay::RelayManager,
    value: &serde_json::Value, path: &std::path::Path) -> Result<AppState, String> {
    let mut updated = state.clone();
    updated.relay.enabled = value.get("enabled").and_then(|v| v.as_bool()).ok_or("请选择是否自动连接服务器")?;
    updated.relay.service_url = state::normalized_public_base_url(value.get("serviceUrl")
        .and_then(|v| v.as_str()).ok_or("请填写 HTTPS 服务地址")?)
        .ok_or("服务地址须为 HTTPS 域名，不能带路径、账号或查询参数")?;
    let key = match value.get("connectionKey") {
        None => "",
        Some(value) => value.as_str().ok_or("连接密钥格式不正确")?.trim(),
    };
    if !key.is_empty() { updated.relay.connection_key = key.into(); }
    else if updated.relay.service_url != state.relay.service_url {
        if updated.relay.enabled { return Err("更换服务器地址时请重新填写连接密钥".into()); }
        updated.relay.connection_key.clear();
    }
    updated.relay.validate()?;
    let prepared = manager.prepare(&updated.relay)?;
    updated.save_to_path(path).map_err(|error| format!("保存服务器连接失败：{}", error))?;
    manager.commit(prepared);
    Ok(updated)
}

fn relay_status_payload(manager: &relay::RelayManager, state: &AppState,
    startup_error: Option<&str>, include_token: bool, delivery_enabled: bool) -> serde_json::Value {
    let mut status = serde_json::to_value(manager.status()).expect("relay status serialization");
    status["settings"] = serde_json::json!({"enabled":state.relay.enabled,"serviceUrl":state.relay.service_url});
    status["hasConnectionKey"] = serde_json::json!(state.relay.has_valid_key());
    status["deliveryEnabled"] = serde_json::json!(delivery_enabled);
    if let Some(error) = startup_error {
        status["phase"] = serde_json::json!("error");
        status["message"] = serde_json::json!(error);
    }
    if include_token { status["webhookToken"] = serde_json::json!(manager.webhook_token().unwrap_or_default()); }
    status
}

fn webhook_status_payload(manager: &webhook::WebhookManager, state: &AppState,
    startup_error: Option<&str>, include_token: bool, delivery_enabled: bool) -> serde_json::Value {
    let mut status = serde_json::to_value(manager.status()).expect("webhook status serialization");
    status["settings"] = serde_json::json!({"enabled":state.webhook.enabled,
        "scope":state.webhook.scope,"port":state.webhook.port,"publicBaseUrl":state.webhook.public_base_url});
    status["endpoint"] = serde_json::json!(format!("http://127.0.0.1:{}/api/webhook", state.webhook.port));
    status["deliveryEnabled"] = serde_json::json!(delivery_enabled);
    if let Some(message) = startup_error {
        status["phase"] = serde_json::json!("error");
        status["message"] = serde_json::json!(message);
    }
    // Query the default IPv4 route without sending a packet. Other interfaces may
    // be entered manually; no public service or network request is contacted.
    let addresses = if state.webhook.scope == "lan" {
        std::net::UdpSocket::bind("0.0.0.0:0").ok().and_then(|socket| {
            socket.connect("192.0.2.1:9").ok()?;
            let ip = socket.local_addr().ok()?.ip();
            (!ip.is_loopback() && !ip.is_unspecified()).then(|| ip.to_string())
        }).into_iter().collect::<Vec<_>>()
    } else { Vec::new() };
    status["lanAddresses"] = serde_json::json!(addresses);
    if include_token { status["token"] = serde_json::json!(state.webhook.token); }
    status
}

/// The preview traverses the same authenticated HTTP endpoint as an external caller.
fn send_webhook_test(settings: &state::WebhookSettings) -> Result<String, String> {
    use std::io::Read;
    if !settings.enabled || !settings.has_valid_token() { return Err("请先保存并开启 Webhook 服务".into()); }
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], settings.port));
    let mut stream = std::net::TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|_| "无法连接 Webhook，请检查服务状态".to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).map_err(|_| "无法设置请求超时".to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).map_err(|_| "无法设置请求超时".to_string())?;
    let body = serde_json::to_vec(&serde_json::json!({"msg_type":"text",
        "content":{"text":"Webhook 连接成功：这条消息通过本机 HTTP 接口送达，可以开始接入外部服务。"}})).unwrap();
    let header = format!("POST /api/webhook/{} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        settings.token, settings.port, body.len());
    stream.write_all(header.as_bytes()).and_then(|_| stream.write_all(&body))
        .map_err(|_| "发送 Webhook 测试失败".to_string())?;
    let mut response = Vec::new();
    stream.take(4096).read_to_end(&mut response).map_err(|_| "Webhook 响应超时，请稍后重试".to_string())?;
    let status = std::str::from_utf8(&response).unwrap_or("").lines().next().unwrap_or("");
    match status.split_whitespace().nth(1) {
        Some("200" | "202") => Ok("测试消息已通过 HTTP 送达通知框".into()),
        Some("401") => Err("令牌已变化，请使用最新令牌重试".into()),
        Some("429") => Err("请求过于频繁，请稍后重试".into()),
        Some("503") => Err("通知暂不可用，请开启通知框后重试".into()),
        _ => Err("Webhook 未接受测试消息，请检查服务状态".into()),
    }
}

fn notification_test_payload() -> serde_json::Value {
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let time = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    serde_json::json!({
        "type":"posted", "source":"test",
        "id":format!("preview-{}-{}-{}", std::process::id(), time.as_nanos(), sequence),
        "app":"通知预览", "title":"这是一条测试消息",
        "body":"消息会从主岛分离，停留后收起为数量；点击数量可展开消息列表。",
        "time":time.as_millis() as u64,
    })
}

fn active_shape(effect: bool, notification: bool, open: bool,
    layout: Option<window::NotificationLayout>) -> window::IslandShape {
    if effect { window::IslandShape::Effect }
    else if let Some(layout) = layout { window::IslandShape::NotificationLayout(layout) }
    else if notification { window::IslandShape::Notification }
    else if open { window::IslandShape::Dial } else { window::IslandShape::Pill }
}
static LOG: OnceLock<Mutex<std::fs::File>> = OnceLock::new();
fn log(message: &str) {
    eprintln!("[FocusIsland] {}", message);
    if let Some(file) = LOG.get() {
        if let Ok(mut file) = file.lock() {
            let _ = writeln!(file, "[FocusIsland] {}", message);
            let _ = file.flush();
        }
    }
}

fn state_payload(state: &AppState) -> String {
    // JSON is also embedded in an HTML script element. Escape '<' to keep a task
    // named '</script>' from closing that element on the next launch.
    let mut value = serde_json::to_value(state).expect("state serialization");
    // Credentials only cross into the settings view via an explicit status/result.
    if let Some(webhook) = value.get_mut("webhook").and_then(|v| v.as_object_mut()) { webhook.remove("token"); }
    if let Some(relay) = value.get_mut("relay").and_then(|v| v.as_object_mut()) {
        relay.remove("connectionKey");
        relay.insert("hasConnectionKey".into(), serde_json::json!(state.relay.has_valid_key()));
    }
    serde_json::to_string(&value).expect("state serialization").replace('<', "\\u003c")
}
fn push(webview: &WebView, js: &str) {
    if let Err(error) = webview.evaluate_script(js) {
        log(&format!("WebView script error: {}", error));
    }
}
/// Acknowledge only after both native and child viewport geometry have applied.
fn acknowledge_viewport(webview: &WebView, request_id: u64) {
    if request_id > 0 {
        push(webview, &format!("window.__viewportReady && window.__viewportReady({});", request_id));
    }
}
fn sync_state(state: &AppState, island: &WebView, panel: &WebView, reset: bool) {
    let js = format!("window.__applyState({}, {});", state_payload(state), reset);
    push(island, &js);
    push(panel, &js);
}
fn build_page(view: &str, state: &AppState, geo: &window::Geometry) -> String {
    include_str!("../ui/index.html")
        .replace("/*__CSS__*/", include_str!("../ui/styles.css"))
        .replace("/*__JS__*/", &format!("window.__PLATFORM__ = {:?};\n{}\n{}", std::env::consts::OS, include_str!("../ui/notifications.js"), include_str!("../ui/app.js")))
        .replace("/*__GEO__*/", &geo.to_json())
        .replace("__VIEW__", view)
        .replace("/*__STATE__*/", &state_payload(state))
}

fn build_tray() -> Result<TrayIcon, Box<dyn std::error::Error>> {
    // Generate the tiny clock icon in memory: the shipped exe needs no PNG file.
    let mut pixels = vec![0u8; 32 * 32 * 4];
    for y in 0..32 {
        for x in 0..32 {
            let dx = x as f32 - 15.5;
            let dy = y as f32 - 15.5;
            let r = (dx * dx + dy * dy).sqrt();
            let i = (y * 32 + x) * 4;
            if r <= 15.0 {
                let gold = (11.5..14.0).contains(&r) || ((15..=17).contains(&x) && (7..=17).contains(&y)) || ((15..=23).contains(&x) && (15..=17).contains(&y));
                pixels[i..i + 4].copy_from_slice(if gold { &[232, 194, 104, 255] } else { &[15, 14, 14, 255] });
            }
        }
    }
    let menu = Menu::new();
    menu.append(&MenuItem::with_id("settings", "功能面板…", true, None))?;
    menu.append(&MenuItem::with_id("toggle", "显示 / 隐藏灵动岛", true, None))?;
    menu.append(&PredefinedMenuItem::separator())?;
    menu.append(&MenuItem::with_id("quit", "退出", true, None))?;
    let builder = TrayIconBuilder::new()
        .with_icon(Icon::from_rgba(pixels, 32, 32)?)
        .with_menu(Box::new(menu))
        .with_tooltip("Focus Island · 专注倒计时")
        .with_menu_on_left_click(false);
    #[cfg(target_os = "windows")]
    let builder = builder.with_guid(window::TRAY_GUID);
    Ok(builder.build()?)
}


fn overlay_builder() -> WindowBuilder {
    let builder = WindowBuilder::new()
        .with_decorations(false).with_transparent(true).with_resizable(false);
    #[cfg(target_os = "windows")]
    let builder = builder.with_undecorated_shadow(false).with_no_redirection_bitmap(true);
    #[cfg(target_os = "macos")]
    let builder = {
        use tao::platform::macos::WindowBuilderExtMacOS;
        builder.with_has_shadow(false).with_automatic_window_tabbing(false)
    };
    builder
}

fn default_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Application Support"))
        .unwrap_or_else(std::env::temp_dir);
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("FocusIsland")
}

#[cfg(target_os = "macos")]
fn build_application_menu() -> Result<Menu, Box<dyn std::error::Error>> {
    use tray_icon::menu::Submenu;
    let menu = Menu::new();
    let app_menu = Submenu::new("Focus Island", true);
    app_menu.append(&MenuItem::with_id("settings", "功能面板…", true, None))?;
    app_menu.append(&PredefinedMenuItem::separator())?;
    app_menu.append(&MenuItem::with_id("quit", "退出 Focus Island", true, None))?;
    menu.append(&app_menu)?;
    let edit = Submenu::new("编辑", true);
    edit.append_items(&[
        &PredefinedMenuItem::undo(None), &PredefinedMenuItem::redo(None),
        &PredefinedMenuItem::separator(), &PredefinedMenuItem::cut(None),
        &PredefinedMenuItem::copy(None), &PredefinedMenuItem::paste(None),
        &PredefinedMenuItem::select_all(None),
    ])?;
    menu.append(&edit)?;
    menu.init_for_nsapp();
    Ok(menu)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let selftest = args.iter().any(|s| s == "--selftest");
    let verbose = selftest || args.iter().any(|s| s == "--verbose");
    let debug_port = args.windows(2).find(|p| p[0] == "--debug-port").and_then(|p| p[1].parse::<u16>().ok()).filter(|port| *port > 0);
    #[cfg(target_os = "windows")]
    let mut browser_args = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection".to_string();
    #[cfg(target_os = "windows")]
    if let Some(port) = debug_port { browser_args.push_str(&format!(" --remote-debugging-address=127.0.0.1 --remote-debugging-port={}", port)); }
    let option = |name: &str| args.windows(2).find(|pair| pair[0] == name).map(|pair| PathBuf::from(&pair[1]));
    let data_dir = option("--data-dir").unwrap_or_else(|| {
        if selftest {
            std::env::temp_dir().join(format!("FocusIsland-selftest-{}", std::process::id()))
        } else {
            default_data_dir()
        }
    });
    std::fs::create_dir_all(&data_dir).expect("创建应用数据目录失败");
    let log_path = option("--log-file").unwrap_or_else(|| data_dir.join("diagnostic.log"));
    if let Ok(file) = std::fs::File::create(&log_path) {
        let _ = LOG.set(Mutex::new(file));
    }
    std::panic::set_hook(Box::new(|info| log(&format!("FATAL: {}", info))));
    log(&format!("启动 | data={} | selftest={}", data_dir.display(), selftest));
    let path = data_dir.join("state.json");
    let mut app_state = AppState::load(&path);
    let event_loop = EventLoopBuilder::<()>::with_user_event().build();
    #[cfg(target_os = "macos")]
    let event_loop = {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        let mut event_loop = event_loop;
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
        event_loop.set_activate_ignoring_other_apps(false);
        event_loop
    };
    let (tx, rx) = mpsc::channel::<Command>();
    let scale_factor = event_loop.primary_monitor().map(|m| m.scale_factor()).unwrap_or(1.0);
    let geo = window::Geometry { scale_factor, pill_w: window::PILL_W, pill_h: window::PILL_H, dial: window::DIAL };

    let initial_position = event_loop.primary_monitor().map(|m| m.position()).unwrap_or(tao::dpi::PhysicalPosition::new(0,0));
    let island = overlay_builder()
        .with_title("Focus Island")
        .with_position(initial_position)
        .with_always_on_top(app_state.settings.always_on_top)
        .with_inner_size(window::logical_size(window::EFFECT, window::EFFECT))
        .build(&event_loop).expect("创建灵动岛窗口失败");
    window::configure_overlay(&island);
    window::resize_to(&island, window::IslandShape::Pill, f64::from(app_state.settings.top_offset));
    let panel = overlay_builder()
        .with_title("Focus Island · 功能面板")
        .with_always_on_top(app_state.settings.always_on_top).with_visible(false)
        .with_inner_size(window::logical_size(window::PANEL_W, window::PANEL_H))
        .build(&event_loop).expect("创建设置浮窗失败");

    window::configure_overlay(&panel);
    window::place_panel(&panel, &island);
    let browser_data = if cfg!(target_os = "windows") { "WebView2" } else { "WebView" };
    let mut context = WebContext::new(Some(data_dir.join(browser_data)));
    let ipc_tx = tx.clone();
    let proxy = event_loop.create_proxy();
    if verbose { log("正在创建岛 WebView"); }
    let island_builder = WebViewBuilder::new_with_web_context(&mut context);
    #[cfg(target_os = "windows")]
    let island_builder = island_builder.with_additional_browser_args(browser_args.clone());
    let island_webview = island_builder.with_devtools(debug_port.is_some())
        .with_html(build_page("island", &app_state, &geo)).with_transparent(true)
        .with_ipc_handler(move |request| {
            if let Some(cmd) = parse_view_command(request.body(), true) {
                let _ = ipc_tx.send(cmd);
                let _ = proxy.send_event(());
            }
        }).build_as_child(&island).expect("创建灵动岛 WebView 失败；Windows 请确认 WebView2 Runtime 已安装");
    let ipc_tx = tx.clone();
    let proxy = event_loop.create_proxy();
    if verbose { log("岛 WebView 就绪，正在创建设置 WebView"); }
    let panel_builder = WebViewBuilder::new_with_web_context(&mut context);
    #[cfg(target_os = "windows")]
    let panel_builder = panel_builder.with_additional_browser_args(browser_args.clone());
    let panel_webview = panel_builder.with_devtools(debug_port.is_some())
        .with_html(build_page("panel", &app_state, &geo)).with_transparent(true)
        .with_ipc_handler(move |request| {
            if let Some(cmd) = parse_view_command(request.body(), false) {
                let _ = ipc_tx.send(cmd);
                let _ = proxy.send_event(());
            }
        }).build_as_child(&panel).expect("创建设置 WebView 失败");
    window::fit_webview(&island_webview, &island);
    window::fit_webview(&panel_webview, &panel);
    if verbose { log("双 WebView 就绪，正在创建托盘"); }
    // Cocoa requires the tray to be created after its event loop starts.
    let mut tray: Option<TrayIcon> = None;
    #[cfg(target_os = "macos")]
    let mut application_menu: Option<Menu> = None;
    let tray_receiver = TrayIconEvent::receiver().clone();
    let menu_receiver = MenuEvent::receiver().clone();

    let phone_tx = tx.clone();
    let phone_proxy = event_loop.create_proxy();
    let phone_manager = phone::PhoneManager::new(move |event| {
        let _ = phone_tx.send(Command::PhoneEvent(event));
        let _ = phone_proxy.send_event(());
    });
    let mut phone_status = phone_manager.status();
    let mut phone_requested_address = String::new();
    // Fresh installs never scan or pair automatically. Only an explicitly saved
    // enabled device is eligible for reconnecting after a restart.
    if app_state.phone.enabled && !selftest {
        phone_manager.configure(true);
        if let Ok(address) = app_state.phone.device_address.parse::<u64>() {
            phone_requested_address = address.to_string();
            phone_manager.connect(address);
        }
    }

    let delivery_enabled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let webhook_delivery = delivery_enabled.clone();
    let webhook_tx = tx.clone();
    let webhook_proxy = event_loop.create_proxy();
    let mut webhook_manager = webhook::WebhookManager::new(move |event| {
        if !webhook_delivery.load(std::sync::atomic::Ordering::Acquire) { return false; }
        if webhook_tx.send(Command::WebhookEvent(event)).is_err() { return false; }
        let _ = webhook_proxy.send_event(());
        true
    });
    let mut webhook_startup_error: Option<String> = None;
    if app_state.webhook.enabled && !selftest {
        match webhook_manager.prepare(&app_state.webhook) {
            Ok(prepared) => { webhook_manager.commit(prepared); }
            Err(message) => { webhook_startup_error = Some(message); log("Webhook 启动失败，请在功能面板查看状态"); }
        }
    }

    let relay_tx = tx.clone();
    let relay_proxy = event_loop.create_proxy();
    let mut relay_manager = relay::RelayManager::new(move |event| {
        if relay_tx.send(Command::RelayEvent(event)).is_err() { return false; }
        let _ = relay_proxy.send_event(());
        true
    }, delivery_enabled.clone());
    let mut relay_startup_error: Option<String> = None;
    if app_state.relay.enabled && !selftest {
        match relay_manager.prepare(&app_state.relay) {
            Ok(prepared) => { relay_manager.commit(prepared); }
            Err(message) => { relay_startup_error = Some(message); log("服务器连接启动失败，请在功能面板查看状态"); }
        }
    }
    let relay_ack_proxy = event_loop.create_proxy();
    let mut last_relay_status = serde_json::Value::Null;

    let webhook_test_proxy = event_loop.create_proxy();
    let mut last_webhook_status = serde_json::Value::Null;
    let mut next_webhook_status = Instant::now();

    let mut notification_open = false;
    let mut notification_layout: Option<window::NotificationLayout> = None;
    let mut island_open = false;
    let mut effect = false;
    let mut cursor_watch = CursorWatch::default();
    let mut completion_actions = ActionController::default();
    let mut last_action_status = completion_actions.status().clone();
    let action_proxy = event_loop.create_proxy();
    let mut timer_state = serde_json::json!({"running":false,"done":false,"remainingMs":app_state.duration_sec*1000,"totalMs":app_state.duration_sec*1000});
    if verbose { log("进入事件循环"); }
    let started = Instant::now();
    let mut ready = [false; 2];
    let mut selftest_stage = 0;
    let mut geometry_ok = false;
    let mut animation_done = false;
    let mut failed = false;
    let mut selftest_reported = false;

    event_loop.run(move |event, _, control_flow| {
        // Native regions handle click-through without changing compositor styles.
        // Keep polling the independent tray/menu receivers; IPC also wakes the loop.
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(30));
        match event {
            Event::NewEvents(StartCause::Init) => {
                tray = Some(build_tray().expect("创建系统托盘失败"));
                #[cfg(target_os = "macos")]
                { application_menu = Some(build_application_menu().expect("创建应用菜单失败")); }
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, window_id, .. } => {
                if window_id == panel.id() { panel.set_visible(false); }
                else {
                    island.set_visible(false);
                    cursor_watch.set_enabled(false, Instant::now());
                }
            }
            Event::WindowEvent { event: WindowEvent::Resized(_), window_id, .. } => {
                if window_id == island.id() { window::fit_webview(&island_webview, &island); }
                if window_id == panel.id() { window::fit_webview(&panel_webview, &panel); }
            }
            Event::WindowEvent { event: WindowEvent::ScaleFactorChanged { .. }, window_id, .. } => {
                if window_id == island.id() {
                    window::resize_to(&island, active_shape(effect, notification_open, island_open, notification_layout), f64::from(app_state.settings.top_offset));
                    window::fit_webview(&island_webview, &island);
                } else if window_id == panel.id() {
                    window::keep_panel_visible(&panel);
                    window::fit_webview(&panel_webview, &panel);
                }
            }
            _ => {}
        }
        // Drain tray/menu events BEFORE commands: callbacks in this event cycle
        // must not be stranded until another external event happens.
        while let Ok(event) = tray_receiver.try_recv() {
            // macOS uses its status-item click to open the attached menu.
            if !cfg!(target_os = "macos") && matches!(event, TrayIconEvent::Click { button: tray_icon::MouseButton::Left, button_state: tray_icon::MouseButtonState::Up, .. }) {
                let visible = !island.is_visible();
                island.set_visible(visible);
                if !visible { cursor_watch.set_enabled(false, Instant::now()); }
            }
        }
        while let Ok(MenuEvent { id, .. }) = menu_receiver.try_recv() {
            match id.as_ref() {
                "settings" => { let _ = tx.send(Command::ShowPanel); }
                "toggle" => {
                    let visible = !island.is_visible();
                    island.set_visible(visible);
                    if !visible { cursor_watch.set_enabled(false, Instant::now()); }
                }
                "quit" => { let _ = tx.send(Command::Quit); }
                _ => {}
            }
        }
        while let Ok(cmd) = rx.try_recv() {
            if verbose && !matches!(cmd, Command::TimerState(_) | Command::TimerDone(_)
                | Command::SetCompletionAction(_, _) | Command::AddTask(_) | Command::PhoneEvent(_)
                | Command::WebhookConfigure(_, _) | Command::WebhookEvent(_)
                | Command::RelayConfigure(_, _) | Command::RelayEvent(_) | Command::RelayAcknowledged(_)) {
                log(&format!("收到命令: {:?}", cmd));
            }
            let mut changed = false;
            let mut reset = false;
            match cmd {
                Command::PageReady(view) => {
                    let i = usize::from(view == "panel");
                    ready[i] = true;
                    let target = if i == 0 { &island_webview } else { &panel_webview };
                    push(target, &format!("window.__applyState({},false);", state_payload(&app_state)));
                    if i == 1 { push(target, &format!("window.__applyTimer({});", timer_state)); }
                    push_callback(target, "__actionStatus", completion_actions.status());
                    push_callback(target, "__phoneStatus", &phone_status);
                    delivery_enabled.store(ready[0] && app_state.notifications.enabled, std::sync::atomic::Ordering::Release);
                    if i == 1 { push_callback(target, "__relayStatus", &relay_status_payload(&relay_manager,
                        &app_state, relay_startup_error.as_deref(), true, ready[0] && app_state.notifications.enabled)); }
                    if i == 1 { push_callback(target, "__webhookStatus", &webhook_status_payload(&webhook_manager,
                        &app_state, webhook_startup_error.as_deref(), true, ready[0] && app_state.notifications.enabled)); }
                }
                Command::SetShape(open, request_id) => {
                    notification_open = false;
                    island_open = open;
                    notification_layout = notification_layout.map(|layout| layout.with_main_open(open));
                    let resized = window::resize_to(&island, active_shape(effect, notification_open, island_open, notification_layout), f64::from(app_state.settings.top_offset));
                    if resized && window::fit_webview(&island_webview, &island) {
                        acknowledge_viewport(&island_webview, request_id);
                    } else {
                        log("SetShape: 窗口视口调整失败");
                    }
                    if verbose { log(&format!("SetShape ACK: open={} outer={:?} position={:?}", open, island.outer_size(), island.outer_position())); }
                    if selftest && selftest_stage == 1 && open {
                        selftest_stage = 2;
                        push(&island_webview, "window.__selftestPanel();");
                    }
                }
                Command::SetEffect(active, request_id) => {
                    notification_open = false;
                    notification_layout = None;
                    effect = active;
                    // Widen the native region for fragments without resizing the
                    // stable WebView surface or moving its screen-space origin.
                    island_open = true;
                    let resized = window::resize_to(&island, if active { window::IslandShape::Effect } else { window::IslandShape::Dial }, f64::from(app_state.settings.top_offset));
                    if resized && window::fit_webview(&island_webview, &island) {
                        acknowledge_viewport(&island_webview, request_id);
                    } else {
                        log("SetEffect: 窗口视口调整失败");
                    }
                }
                Command::SetNotificationShape(active, request_id) => {
                    notification_layout = None;
                    notification_open = active && !effect;
                    let resized = window::resize_to(&island, active_shape(effect, notification_open, island_open, notification_layout),
                        f64::from(app_state.settings.top_offset));
                    if resized && window::fit_webview(&island_webview, &island) {
                        acknowledge_viewport(&island_webview, request_id);
                    }
                    if notification_open { cursor_watch.set_enabled(false, Instant::now()); }
                }
                Command::SetNotificationLayout(layout, request_id) => {
                    notification_open = false;
                    notification_layout = if effect || layout.mode == window::NotificationMode::None {
                        None
                    } else { Some(layout) };
                    let resized = window::resize_to(&island,
                        active_shape(effect, notification_open, island_open, notification_layout),
                        f64::from(app_state.settings.top_offset));
                    if resized && window::fit_webview(&island_webview, &island) {
                        acknowledge_viewport(&island_webview, request_id);
                    } else { log("SetNotificationLayout: 窗口视口调整失败"); }
                }
                Command::NotificationsConfigure(value) => {
                    let (ok, message) = match configured_notifications_state(&app_state, &value, &path) {
                        Ok(updated) => {
                            app_state = updated;
                            delivery_enabled.store(ready[0] && app_state.notifications.enabled, std::sync::atomic::Ordering::Release);
                            sync_state(&app_state, &island_webview, &panel_webview, false);
                            (true, "通知框设置已保存".to_string())
                        }
                        Err(message) => (false, message),
                    };
                    let result = serde_json::json!({"ok":ok,"message":message,"settings":app_state.notifications});
                    push_callback(&island_webview, "__notificationsConfigResult", &result);
                    push_callback(&panel_webview, "__notificationsConfigResult", &result);
                }
                Command::NotificationTest => {
                    // The preview uses the common source adapter without touching
                    // Bluetooth, timer actions, the disk or notification logs.
                    push_callback(&island_webview, "__notificationEvent", &notification_test_payload());
                }


                Command::RelayStatus => {
                    push_callback(&panel_webview, "__relayStatus", &relay_status_payload(&relay_manager,
                        &app_state, relay_startup_error.as_deref(), true, ready[0] && app_state.notifications.enabled));
                }
                Command::RelayConfigure(value, request_id) => {
                    let (ok, message) = match configured_relay_state(&app_state, &mut relay_manager, &value, &path) {
                        Ok(updated) => {
                            app_state = updated; relay_startup_error = None;
                            sync_state(&app_state, &island_webview, &panel_webview, false);
                            (true, "服务器连接设置已保存".to_string())
                        }
                        Err(message) => (false, message),
                    };
                    let mut status = relay_status_payload(&relay_manager, &app_state,
                        relay_startup_error.as_deref(), true, ready[0] && app_state.notifications.enabled);
                    status["ok"] = serde_json::json!(ok);
                    status["requestId"] = serde_json::json!(request_id);
                    status["message"] = serde_json::json!(message);
                    push_callback(&panel_webview, "__relayConfigResult", &status);
                    push_callback(&panel_webview, "__relayStatus", &relay_status_payload(&relay_manager,
                        &app_state, relay_startup_error.as_deref(), true, ready[0] && app_state.notifications.enabled));
                    next_webhook_status = Instant::now();
                }
                Command::RelayEvent(event) => {
                    if ready[0] && app_state.notifications.enabled && relay_manager.is_current(&event) {
                        let payload = serde_json::json!({"deliveryId":event.delivery_id,"notification":event.notification});
                        let json = serde_json::to_string(&payload).expect("relay message serialization").replace('<', "\\u003c");
                        let script = format!("Boolean(window.__relayNotification && window.__relayNotification({}));", json);
                        let result_tx = tx.clone();
                        let result_proxy = relay_ack_proxy.clone();
                        // ACK only after the island reports that it accepted this delivery.
                        if island_webview.evaluate_script_with_callback(&script, move |result| {
                            if result.trim() == "true" {
                                let _ = result_tx.send(Command::RelayAcknowledged(event.clone()));
                                let _ = result_proxy.send_event(());
                            }
                        }).is_err() { log("服务器消息暂未送入页面，将等待重试"); }
                    }
                }
                Command::RelayAcknowledged(event) => {
                    if ready[0] && app_state.notifications.enabled && relay_manager.is_current(&event) {
                        relay_manager.acknowledge(&event);
                    }
                }

                Command::WebhookStatus => {
                    push_callback(&panel_webview, "__webhookStatus", &webhook_status_payload(&webhook_manager,
                        &app_state, webhook_startup_error.as_deref(), true, ready[0] && app_state.notifications.enabled));
                }
                Command::WebhookConfigure(_, _) | Command::WebhookRotateToken(_) => {
                    let (value, request_id) = match &cmd {
                        Command::WebhookConfigure(value, id) => (Some(value), *id),
                        Command::WebhookRotateToken(id) => (None, *id),
                        _ => unreachable!(),
                    };
                    let (ok, message) = match configured_webhook_state(&app_state, &mut webhook_manager, value, &path) {
                        Ok(updated) => {
                            app_state = updated; webhook_startup_error = None;
                            sync_state(&app_state, &island_webview, &panel_webview, false);
                            (true, if value.is_none() { "专属地址已更新，旧地址与令牌立即失效".to_string() } else { "Webhook 设置已保存".to_string() })
                        }
                        Err(message) => (false, message),
                    };
                    let mut status = webhook_status_payload(&webhook_manager, &app_state,
                        webhook_startup_error.as_deref(), true, ready[0] && app_state.notifications.enabled);
                    status["ok"] = serde_json::json!(ok);
                    status["requestId"] = serde_json::json!(request_id);
                    status["message"] = serde_json::json!(message);
                    push_callback(&panel_webview, "__webhookConfigResult", &status);
                    next_webhook_status = Instant::now();
                }
                Command::WebhookEvent(event) => {
                    if ready[0] && app_state.notifications.enabled && webhook_manager.is_current(&event) {
                        push_callback(&island_webview, "__notificationEvent", &event.notification);
                    }
                }
                Command::WebhookTest(request_id) => {
                    let settings = app_state.webhook.clone();
                    let result_tx = tx.clone();
                    let result_proxy = webhook_test_proxy.clone();
                    let spawned = std::thread::Builder::new().name("webhook-test".into()).spawn(move || {
                        let result = send_webhook_test(&settings);
                        let _ = result_tx.send(Command::WebhookTestFinished(request_id, result));
                        let _ = result_proxy.send_event(());
                    });
                    if spawned.is_err() {
                        push_callback(&panel_webview, "__webhookTestResult", &serde_json::json!({
                            "ok":false,"message":"无法启动测试请求，请稍后重试","requestId":request_id}));
                    }
                }
                Command::WebhookTestFinished(request_id, result) => {
                    let ok = result.is_ok();
                    let message = result.unwrap_or_else(|message| message);
                    push_callback(&panel_webview, "__webhookTestResult", &serde_json::json!({"ok":ok,"message":message,"requestId":request_id}));
                }

                Command::PhoneConfigure(value) => {
                    let was_enabled = app_state.phone.enabled;
                    let result = configured_phone_state(&app_state, &value, &path);
                    let (ok, message) = match result {
                        Ok(updated) => {
                            app_state = updated;
                            if was_enabled != app_state.phone.enabled {
                                phone_manager.configure(app_state.phone.enabled);
                                phone_requested_address.clear();
                                if app_state.phone.enabled {
                                    if let Ok(address) = app_state.phone.device_address.parse::<u64>() {
                                        phone_requested_address = address.to_string();
                                        phone_manager.connect(address);
                                    }
                                }
                            }
                            sync_state(&app_state, &island_webview, &panel_webview, false);
                            (true, "手机通知设置已保存".to_string())
                        }
                        Err(message) => (false, message),
                    };
                    let result = serde_json::json!({"ok":ok,"message":message,"settings":app_state.phone});
                    push_callback(&island_webview, "__phoneConfigResult", &result);
                    push_callback(&panel_webview, "__phoneConfigResult", &result);
                }
                Command::PhoneScan => {
                    if app_state.phone.enabled { phone_manager.scan(); }
                }
                Command::PhoneConnect(address) => {
                    if app_state.phone.enabled {
                        if let Some(address) = address.parse::<u64>().ok().filter(|v| *v > 0 && *v <= 0xffff_ffff_ffff) {
                            phone_requested_address = address.to_string();
                            phone_manager.connect(address);
                        }
                    }
                }
                Command::PhoneDisconnect => {
                    phone_requested_address.clear();
                    phone_manager.disconnect();
                    let mut updated = app_state.clone();
                    updated.phone.device_address.clear();
                    updated.phone.device_name.clear();
                    match updated.save_to_path(&path) {
                        Ok(()) => {
                            app_state = updated;
                            sync_state(&app_state, &island_webview, &panel_webview, false);
                        }
                        Err(_) => {
                            let result = serde_json::json!({"ok":false,"message":"已断开，但未能保存设备设置，请检查配置目录写入权限","settings":app_state.phone});
                            push_callback(&panel_webview, "__phoneConfigResult", &result);
                        }
                    }
                }
                Command::PhoneEvent(event) => match event {
                    phone::PhoneEvent::Status(status) => {
                        let selected = !phone_requested_address.is_empty()
                            && status.device_address == phone_requested_address;
                        if status.phase == "connected" && (!app_state.phone.enabled || !selected) { continue; }
                        if status.phase == "connected" && selected && (app_state.phone.device_address != status.device_address
                            || app_state.phone.device_name != status.device_name) {
                            let mut updated = app_state.clone();
                            updated.phone.device_address = status.device_address.clone();
                            updated.phone.device_name = status.device_name.clone();
                            updated.phone.normalize();
                            if updated.save_to_path(&path).is_ok() {
                                app_state = updated;
                                sync_state(&app_state, &island_webview, &panel_webview, false);
                            } else { log("已连接手机，但未能保存设备设置"); }
                        }
                        phone_status = status;
                        push_callback(&island_webview, "__phoneStatus", &phone_status);
                        push_callback(&panel_webview, "__phoneStatus", &phone_status);
                    }
                    phone::PhoneEvent::Notification(mut notification) => {
                        if app_state.phone.enabled && phone_status.phase == "connected"
                            && phone_status.notification_access != Some(false)
                            && phone_status.device_address == phone_requested_address && !phone_requested_address.is_empty() {
                            // Hide private content before crossing into either WebView.
                            if app_state.phone.hide_content { notification.title.clear(); notification.body.clear(); }
                            push_callback(&island_webview, "__phoneNotification", &notification);
                        }
                    }
                },                Command::SetDuration(sec) => {
                    if (1..=state::MAX_DURATION_SEC).contains(&sec) {
                        completion_actions.invalidate("计时时长已修改，本次动作已取消");
                        app_state.duration_sec = sec;
                        changed = true; reset = true;
                    }
                }
                Command::ToggleTimer => push(&island_webview, "window.__fromRust('toggleTimer');"),
                Command::ResetTimer => {
                    completion_actions.invalidate("计时已重置，本次动作已取消");
                    push(&island_webview, "window.__fromRust('resetTimer');");
                }
                Command::AddTask(request) => {
                    let (ok, message, task_id) = match created_task_state(&app_state, &request, &path) {
                        Ok((updated, task_id)) => {
                            app_state = updated;
                            completion_actions.invalidate("已切换任务，本次动作已取消");
                            sync_state(&app_state, &island_webview, &panel_webview, true);
                            (true, "任务已创建".to_string(), task_id)
                        }
                        Err(message) => (false, message, String::new()),
                    };
                    let payload = serde_json::json!({"ok":ok,"message":message,
                        "requestId":request.request_id,"taskId":task_id});
                    push_callback(&island_webview, "__taskCreateResult", &payload);
                    push_callback(&panel_webview, "__taskCreateResult", &payload);
                    log(if ok { "任务创建成功" } else { "任务创建失败" });
                }
                Command::SetTaskDuration(request) => {
                    let result = apply_task_duration(&mut app_state, &mut completion_actions, &request, &path);
                    if let Ok(reset_timer) = &result {
                        sync_state(&app_state, &island_webview, &panel_webview, *reset_timer);
                    }
                    let payload = task_duration_result(&request, &result);
                    push_callback(&island_webview, "__taskDurationResult", &payload);
                    push_callback(&panel_webview, "__taskDurationResult", &payload);
                    log(if result.is_ok() { "任务时长已保存" } else { "任务时长保存失败" });
                }
                Command::RemoveTask(id) => {
                    reset = app_state.current_id == id;
                    app_state.tasks.retain(|task| task.id != id);
                    if reset {
                        completion_actions.invalidate("任务已删除，本次动作已取消");
                        if let Some(task) = app_state.tasks.first() {
                            app_state.current_id = task.id.clone();
                            app_state.duration_sec = task.sec;
                        } else { app_state.current_id.clear(); }
                    }
                    changed = true;
                }
                Command::SelectTask(id) => {
                    if let Some(task) = app_state.tasks.iter().find(|task| task.id == id) {
                        completion_actions.invalidate("已切换任务，本次动作已取消");
                        app_state.current_id = task.id.clone();
                        app_state.duration_sec = task.sec;
                        changed = true; reset = true;
                    }
                }
                Command::ClearTasks => {
                    completion_actions.invalidate("任务已清空，本次动作已取消");
                    app_state.tasks.clear(); app_state.current_id.clear();
                    changed = true; reset = true;
                }
                Command::UpdateSettings(settings) => {
                    let top_offset_changed = app_state.settings.top_offset != settings.top_offset;
                    app_state.settings = settings;
                    if top_offset_changed {
                        let shape = active_shape(effect, notification_open, island_open, notification_layout);
                        if !window::resize_to(&island, shape, f64::from(app_state.settings.top_offset)) {
                            log("TopOffset: 窗口位置调整失败");
                        }
                        window::fit_webview(&island_webview, &island);
                        if verbose { log(&format!("TopOffset ACK: requested={} position={:?}",
                            app_state.settings.top_offset, island.outer_position())); }
                    }
                    if !cursor_watch_allowed(&app_state.settings, island.is_visible(), island_open || notification_open, effect) {
                        cursor_watch.set_enabled(false, Instant::now());
                    }
                    island.set_always_on_top(app_state.settings.always_on_top);
                    panel.set_always_on_top(app_state.settings.always_on_top);
                    changed = true;
                }
                Command::WatchCursor(enabled) => {
                    cursor_watch.set_enabled(enabled && cursor_watch_allowed(
                        &app_state.settings, island.is_visible(), island_open || notification_open, effect), Instant::now());
                }
                Command::TimerState(value) => {
                    if let Ok(update) = serde_json::from_value::<TimerUpdate>(value.clone()) {
                        completion_actions.observe(&update, &app_state);
                    }
                    timer_state = value;
                    push(&panel_webview, &format!("window.__applyTimer({});", timer_state));
                }
                Command::TimerDone(completion) => {
                    // Legacy completion messages may show reminders but never arm
                    // or execute an action. Identified runs are consumed once.
                    let accepted = if completion.run_id.is_empty() { true }
                        else { completion_actions.complete(&completion, Instant::now()) };
                    if accepted {
                        log("TimerDone ACK: 时间到");
                        island.set_visible(true);
                        if app_state.settings.sound { window::play_completion_sound(); }
                        if app_state.settings.notify && !tray.as_ref().is_some_and(|tray| window::notify_completion(tray, &completion.task)) {
                            log("桌面通知请求失败");
                        }
                        if selftest && selftest_stage == 3 { selftest_stage = 4; }
                    }
                }
                Command::SetCompletionAction(task_id, value) => {
                    let result = updated_action_state(&app_state, &task_id, value).and_then(|updated| {
                        updated.save_to_path(&path).map_err(|error| format!("保存失败：{}", error))?;
                        Ok(updated)
                    });
                    let (ok, message) = match result {
                        Ok(updated) => {
                            app_state = updated;
                            completion_actions.cancel_scope(&task_id);
                            sync_state(&app_state, &island_webview, &panel_webview, false);
                            (true, "已保存，下次开始计时时生效".to_string())
                        }
                        Err(message) => (false, message),
                    };
                    let payload = serde_json::json!({"ok":ok,"message":message,"taskId":task_id});
                    push_callback(&island_webview, "__actionConfigResult", &payload);
                    push_callback(&panel_webview, "__actionConfigResult", &payload);
                    log(if ok { "完成动作配置已保存" } else { "完成动作配置保存失败" });
                }
                Command::CancelCompletionAction(run_id) => {
                    completion_actions.cancel(&run_id, "本次完成动作已取消");
                }
                Command::ActionFinished(run_id, result) => {
                    completion_actions.finished(&run_id, result);
                }
                Command::TogglePanel | Command::ShowPanel => {
                    let show = matches!(cmd, Command::ShowPanel) || !panel.is_visible();
                    if show {
                        window::keep_panel_visible(&panel);
                        window::fit_webview(&panel_webview, &panel);
                        panel.set_visible(true); panel.set_focus();
                        push(&panel_webview, &format!("window.__applyTimer({});", timer_state));
                    } else { panel.set_visible(false); }
                    if verbose { log(&format!("TogglePanel ACK: visible={} outer={:?} position={:?}", show, panel.outer_size(), panel.outer_position())); }
                    if selftest && selftest_stage == 2 && show {
                        selftest_stage = 3;
                        push(&island_webview, "window.__selftestCycle();");
                    }
                }
                Command::HidePanel => panel.set_visible(false),
                Command::DragPanel => {
                    if panel.is_visible() {
                        if let Err(error) = panel.drag_window() { log(&format!("设置窗口拖动失败: {}", error)); }
                    }
                }
                Command::AnimationDone => animation_done = true,
                Command::SelftestResult(ok, message) => {
                    geometry_ok = ok;
                    failed |= !ok;
                    log(&format!("Geometry {}: {}", if ok { "PASS" } else { "FAIL" }, message));
                }
                Command::FrontendError(message) => {
                    failed = true;
                    log(&format!("FRONTEND ERROR: {}", message));
                }
                Command::Quit => {
                    delivery_enabled.store(false, std::sync::atomic::Ordering::Release);
                    webhook_manager.shutdown();
                    relay_manager.shutdown();
                    phone_manager.configure(false);
                    completion_actions.invalidate("应用退出，本次动作已取消");
                    cursor_watch.set_enabled(false, Instant::now());
                    *control_flow = ControlFlow::Exit;
                }
            }
            if changed {
                app_state.normalize();
                app_state.save(&path);
                sync_state(&app_state, &island_webview, &panel_webview, reset);
            }
        }
        delivery_enabled.store(ready[0] && app_state.notifications.enabled
            && !matches!(*control_flow, ControlFlow::ExitWithCode(_)), std::sync::atomic::Ordering::Release);
        if ready[1] && Instant::now() >= next_webhook_status {
            next_webhook_status = Instant::now() + Duration::from_secs(1);
            let status = webhook_status_payload(&webhook_manager, &app_state, webhook_startup_error.as_deref(), false,
                ready[0] && app_state.notifications.enabled);
            if status != last_webhook_status { push_callback(&panel_webview, "__webhookStatus", &status); last_webhook_status = status; }
            let relay_status = relay_status_payload(&relay_manager, &app_state, relay_startup_error.as_deref(), false,
                ready[0] && app_state.notifications.enabled);
            if relay_status != last_relay_status { push_callback(&panel_webview, "__relayStatus", &relay_status); last_relay_status = relay_status; }
        }
        if selftest && !selftest_reported {
            if selftest_stage == 0 && ready.iter().all(|value| *value) {
                selftest_stage = 1;
                push(&island_webview, "window.__selftestOpen();");
            }
            if failed || started.elapsed() > Duration::from_secs(25) {
                selftest_reported = true;
                log(&format!("SELFTEST FAIL: stage={} geometry={} animation={}", selftest_stage, geometry_ok, animation_done));
                *control_flow = ControlFlow::ExitWithCode(1);
            } else if selftest_stage == 4 && animation_done && geometry_ok {
                selftest_reported = true;
                log("SELFTEST PASS: SetShape -> TogglePanel -> 3s -> TimerDone -> AnimationDone; hand bases at center");
                *control_flow = ControlFlow::Exit;
            }
        }
        if matches!(*control_flow, ControlFlow::ExitWithCode(_)) {
            delivery_enabled.store(false, std::sync::atomic::Ordering::Release);
            webhook_manager.shutdown();
            relay_manager.shutdown();
            completion_actions.invalidate("应用退出，本次动作已取消");
        } else if let Some(job) = completion_actions.poll(Instant::now()) {
            let result_tx = tx.clone();
            let result_proxy = action_proxy.clone();
            let run_id = job.run_id.clone();
            let failed_run = run_id.clone();
            let spawned = std::thread::Builder::new().name("completion-action".into()).spawn(move || {
                let result = actions::execute(&job);
                let _ = result_tx.send(Command::ActionFinished(run_id, result));
                let _ = result_proxy.send_event(());
            });
            if let Err(error) = spawned {
                completion_actions.finished(&failed_run, ExecutionResult {
                    ok: false, message: format!("无法启动动作工作线程：{}", error),
                });
            }
        }
        if completion_actions.status() != &last_action_status {
            last_action_status = completion_actions.status().clone();
            push_callback(&island_webview, "__actionStatus", &last_action_status);
            push_callback(&panel_webview, "__actionStatus", &last_action_status);
            log(&format!("完成动作状态: {:?}", last_action_status.phase));
        }
        // The existing tray polling stays at 30ms. Cursor requests add only their
        // active 80ms deadline; disabled/hidden eyes have no cursor timer or reads.
        let now = Instant::now();
        if matches!(*control_flow, ControlFlow::ExitWithCode(_))
            || !cursor_watch_allowed(&app_state.settings, island.is_visible(), island_open || notification_open, effect) {
            cursor_watch.set_enabled(false, now);
        }
        if cursor_watch.take_due(now) {
            if let Some((x, y)) = window::cursor_position(&island) {
                push(&island_webview, &format!(
                    "window.__cursorPosition && window.__cursorPosition({:.3},{:.3});", x, y));
            }
        }
        if let (Some(cursor_deadline), ControlFlow::WaitUntil(tray_deadline)) =
            (cursor_watch.next_sample, *control_flow) {
            *control_flow = ControlFlow::WaitUntil(cursor_deadline.min(tray_deadline));
        }
        window::poll_overlay_hit_test(&island,
            active_shape(effect, notification_open, island_open, notification_layout),
            island.is_visible());
        let _ = &tray;
        #[cfg(target_os = "macos")]
        let _ = &application_menu;
        let _ = &context;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    struct TaskCreateTestFile(PathBuf);
    impl TaskCreateTestFile {
        fn new() -> Self {
            let folder = std::env::temp_dir().join(format!("focus-island-create-{}", Task::new("test".into(), 1).id));
            std::fs::create_dir(&folder).unwrap();
            Self(folder.join("state.json"))
        }
    }
    impl Drop for TaskCreateTestFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
            let _ = std::fs::remove_dir(self.0.parent().unwrap());
        }
    }

    #[test]
    fn webhook_ipc_credentials_are_panel_only_and_state_broadcasts_redact_tokens() {
        let mut state = AppState::default();
        state.webhook.token = "ab".repeat(32);
        let public: serde_json::Value = serde_json::from_str(&state_payload(&state)).unwrap();
        assert!(public["webhook"].get("token").is_none());
        assert!(!build_page("island", &state, &window::Geometry { scale_factor:1.0,
            pill_w:window::PILL_W,pill_h:window::PILL_H,dial:window::DIAL }).contains(&state.webhook.token));
        for kind in ["webhookStatus","webhookTest","webhookRotateToken","webhookConfigure"] {
            let raw = serde_json::json!({"type":kind,"requestId":44,"settings":{}}).to_string();
            assert!(parse_view_command(&raw, true).is_none());
            assert!(parse_view_command(&raw, false).is_some());
        }
    }


    #[test]
    fn relay_configuration_keeps_credentials_off_ui_and_preserves_tasks_on_failure() {
        let file = TaskCreateTestFile::new();
        let initial = AppState::default();
        let delivery = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut manager = relay::RelayManager::new(|_| false, delivery);
        let value = serde_json::json!({"enabled":false,"serviceUrl":"https://hooks.example.com/","connectionKey":"ab".repeat(32)});
        let saved = configured_relay_state(&initial, &mut manager, &value, &file.0).unwrap();
        assert_eq!(saved.relay.service_url, "https://hooks.example.com");
        let public: serde_json::Value = serde_json::from_str(&state_payload(&saved)).unwrap();
        assert!(public["relay"].get("connectionKey").is_none());
        assert_eq!(public["relay"]["hasConnectionKey"], true);
        let mut public_before = serde_json::to_value(&initial).unwrap();
        public_before["relay"] = serde_json::to_value(&saved.relay).unwrap();
        assert_eq!(serde_json::to_value(&saved).unwrap(), public_before);
        for kind in ["relayConfigure","relayStatus"] {
            let raw = serde_json::json!({"type":kind,"requestId":3,"settings":value}).to_string();
            assert!(parse_view_command(&raw, true).is_none());
            assert!(parse_view_command(&raw, false).is_some());
        }
        let keep = serde_json::json!({"enabled":false,"serviceUrl":saved.relay.service_url,"connectionKey":""});
        assert_eq!(configured_relay_state(&saved, &mut manager, &keep, &file.0).unwrap().relay.connection_key, saved.relay.connection_key);
        let disk = std::fs::read(&file.0).unwrap();
        for invalid in [
            serde_json::json!({"enabled":true,"serviceUrl":"https://different.example.com","connectionKey":""}),
            serde_json::json!({"enabled":false,"serviceUrl":"http://hooks.example.com","connectionKey":""}),
            serde_json::json!({"enabled":false,"serviceUrl":saved.relay.service_url,"connectionKey":"bad"}),
            serde_json::json!({"enabled":"true","serviceUrl":saved.relay.service_url}),
        ] {
            assert!(configured_relay_state(&saved, &mut manager, &invalid, &file.0).is_err());
            assert_eq!(std::fs::read(&file.0).unwrap(), disk);
        }
        let changed = serde_json::json!({"enabled":false,"serviceUrl":"https://different.example.com","connectionKey":""});
        assert!(configured_relay_state(&saved, &mut manager, &changed, file.0.parent().unwrap()).is_err());
        assert_eq!(std::fs::read(&file.0).unwrap(), disk);
        let cleared = configured_relay_state(&saved, &mut manager, &changed, &file.0).unwrap();
        assert!(cleared.relay.connection_key.is_empty());
        manager.shutdown();
    }

    #[test]
    fn webhook_configuration_is_atomic_strict_and_separate_from_tasks() {
        let file = TaskCreateTestFile::new();
        let initial = AppState::default();
        let before = serde_json::to_value(&initial).unwrap();
        let mut manager = webhook::WebhookManager::new(|_| false);
        let value = serde_json::json!({"enabled":false,"scope":"local","port":17891,"publicBaseUrl":"https://hooks.example.com/"});
        let saved = configured_webhook_state(&initial, &mut manager, Some(&value), &file.0).unwrap();
        assert!(saved.webhook.has_valid_token());
        assert_eq!(saved.webhook.public_base_url, "https://hooks.example.com");
        let mut actual = serde_json::to_value(&saved).unwrap();
        actual["webhook"] = before["webhook"].clone();
        assert_eq!(actual, before);
        let bytes = std::fs::read(&file.0).unwrap();
        let bad_values = [serde_json::json!(null),serde_json::json!({}),
            serde_json::json!({"enabled":true,"scope":"internet","port":17891}),
            serde_json::json!({"enabled":false,"scope":"local","port":80}),
            serde_json::json!({"enabled":false,"scope":"local","port":65536}),
            serde_json::json!({"enabled":false,"scope":"local","port":17891.5}),
            serde_json::json!({"enabled":false,"scope":"local","port":17891,"publicBaseUrl":"http://hooks.example.com"}),
            serde_json::json!({"enabled":false,"scope":"local","port":17891,"publicBaseUrl":"https://hooks.example.com/secret"})];
        for value in &bad_values {
            assert!(configured_webhook_state(&saved, &mut manager, Some(value), &file.0).is_err());
            assert_eq!(std::fs::read(&file.0).unwrap(), bytes);
        }
        assert!(configured_webhook_state(&saved, &mut manager, None, file.0.parent().unwrap()).is_err());
        assert_eq!(std::fs::read(&file.0).unwrap(), bytes);
        let rotated = configured_webhook_state(&saved, &mut manager, None, &file.0).unwrap();
        assert_ne!(rotated.webhook.token, saved.webhook.token);
        assert_eq!(rotated.webhook.public_base_url, saved.webhook.public_base_url);
        assert_eq!(rotated.tasks[0].id, saved.tasks[0].id);
        assert_eq!(manager.status().phase, "disabled");
    }

    #[test]
    fn notification_configuration_is_strict_atomic_and_preserves_all_other_state() {
        let file = TaskCreateTestFile::new();
        let (mut state, mut actions) = task_duration_pending_action();
        state.phone.enabled = true;
        state.phone.device_address = "12345".into();
        state.phone.device_name = "paired".into();
        state.duration_sec = 71;
        let action_before = actions.status().clone();
        let before = serde_json::to_value(&state).unwrap();
        for (display_seconds, list_limit) in [(1, 1), (30, 10), (5, 5)] {
            let updated = configured_notifications_state(&state, &serde_json::json!({
                "enabled":true,"displaySeconds":display_seconds,"listLimit":list_limit,
                "duration_sec":10,"phone":{"enabled":false},"tasks":[]}), &file.0).unwrap();
            assert_eq!(updated.notifications.display_seconds, display_seconds);
            assert_eq!(updated.notifications.list_limit, list_limit);
            let mut after = serde_json::to_value(&updated).unwrap();
            after["notifications"] = before["notifications"].clone();
            assert_eq!(after, before);
            assert_eq!(actions.status(), &action_before);
            assert_eq!(serde_json::to_value(AppState::load(&file.0)).unwrap(),
                serde_json::to_value(&updated).unwrap());
        }
        let saved = std::fs::read(&file.0).unwrap();
        for value in [
            serde_json::json!({}), serde_json::json!(null),
            serde_json::json!({"enabled":"true","displaySeconds":5,"listLimit":5}),
            serde_json::json!({"enabled":true,"displaySeconds":0,"listLimit":5}),
            serde_json::json!({"enabled":true,"displaySeconds":31,"listLimit":5}),
            serde_json::json!({"enabled":true,"displaySeconds":5.5,"listLimit":5}),
            serde_json::json!({"enabled":true,"displaySeconds":"5","listLimit":5}),
            serde_json::json!({"enabled":true,"displaySeconds":5,"listLimit":0}),
            serde_json::json!({"enabled":true,"displaySeconds":5,"listLimit":11}),
            serde_json::json!({"enabled":true,"displaySeconds":5,"listLimit":2.5}),
            serde_json::json!({"enabled":true,"displaySeconds":5,"listLimit":null}),
        ] {
            assert!(configured_notifications_state(&state, &value, &file.0).is_err());
            assert_eq!(std::fs::read(&file.0).unwrap(), saved);
            assert_eq!(serde_json::to_value(&state).unwrap(), before);
        }
        assert!(configured_notifications_state(&state, &serde_json::json!({
            "enabled":false,"displaySeconds":5,"listLimit":5}), file.0.parent().unwrap()).is_err());
        assert_eq!(std::fs::read(&file.0).unwrap(), saved);
        assert_eq!(serde_json::to_value(&state).unwrap(), before);
        // Configuration never invalidated the already pending completion action.
        assert!(actions.poll(Instant::now()).is_none());
        assert_eq!(actions.status(), &action_before);
    }

    #[test]
    fn notification_layout_ipc_is_bounded_island_only_and_effect_has_priority() {
        let value = serde_json::json!({"type":"setNotificationLayout","mode":"preview",
            "mainOpen":true,"listHeight":280,"requestId":99});
        let Some(Command::SetNotificationLayout(layout, 99)) = parse_view_command(&value.to_string(), true)
            else { panic!("expected valid layout"); };
        assert!(parse_view_command(&value.to_string(), false).is_none());
        assert_eq!(active_shape(false, true, false, Some(layout)), window::IslandShape::NotificationLayout(layout));
        assert_eq!(active_shape(true, true, false, Some(layout)), window::IslandShape::Effect);
        for (field, bad) in [("mode", serde_json::json!("arbitrary")),
            ("mainOpen", serde_json::json!(1)), ("listHeight", serde_json::json!(-1)),
            ("listHeight", serde_json::json!(281)), ("listHeight", serde_json::json!(12.5))] {
            let mut invalid = value.clone();
            invalid[field] = bad;
            assert!(parse_view_command(&invalid.to_string(), true).is_none());
        }
        let list = window::NotificationLayout::from_value(&serde_json::json!({
            "mode":"list","mainOpen":true,"listHeight":280})).unwrap();
        assert!(!list.main_open);
        assert!(!list.with_main_open(true).main_open);
        assert_eq!(layout.with_main_open(false).mode, window::NotificationMode::Preview);
        assert!(matches!(parse_command(r#"{"type":"notificationTest"}"#), Some(Command::NotificationTest)));
        assert!(matches!(parse_command(r#"{"type":"notificationsConfigure"}"#), Some(Command::NotificationsConfigure(_))));
    }

    #[test]
    fn preview_notifications_have_unique_ids_and_common_source_without_persisting_content() {
        let first = notification_test_payload();
        let second = notification_test_payload();
        assert_ne!(first["id"], second["id"]);
        assert_eq!(first["type"], "posted");
        assert_eq!(first["source"], "test");
        assert!(first["time"].as_u64().unwrap() > 0);
        assert!(first["title"].as_str().unwrap().contains("测试消息"));
        let saved = serde_json::to_value(AppState::default()).unwrap();
        assert!(saved["notifications"].get("body").is_none());
        assert!(saved["notifications"].get("messages").is_none());
    }

    #[test]
    fn phone_config_is_atomic_and_cannot_replace_timer_or_pairing_identity() {
        let file = TaskCreateTestFile::new();
        let mut state = AppState::default();
        state.phone.device_address = "12345".into();
        state.phone.device_name = "paired phone".into();
        let before = serde_json::to_value(&state).unwrap();
        let updated = configured_phone_state(&state, &serde_json::json!({"enabled":false,
            "displaySeconds":12,"hideContent":true,"deviceAddress":"9999","deviceName":"untrusted"}), &file.0).unwrap();
        assert_eq!(updated.phone.device_address, "12345");
        assert_eq!(updated.phone.display_seconds, 12);
        let mut after = serde_json::to_value(&updated).unwrap();
        after["phone"] = before["phone"].clone();
        assert_eq!(before, after);
        let saved = std::fs::read(&file.0).unwrap();
        for seconds in [serde_json::json!(-1), serde_json::json!(31), serde_json::json!(8.5), serde_json::json!("8")] {
            assert!(configured_phone_state(&updated, &serde_json::json!({"enabled":false,
                "displaySeconds":seconds,"hideContent":false}), &file.0).is_err());
            assert_eq!(std::fs::read(&file.0).unwrap(), saved);
        }
        assert!(configured_phone_state(&updated, &serde_json::json!({"enabled":false,
            "displaySeconds":8,"hideContent":true}), file.0.parent().unwrap()).is_err());
        assert_eq!(std::fs::read(&file.0).unwrap(), saved);
    }
    #[test]
    fn notification_shape_has_explicit_priority_and_only_island_can_change_it() {
        assert_eq!(active_shape(false, false, false, None), window::IslandShape::Pill);
        assert_eq!(active_shape(false, false, true, None), window::IslandShape::Dial);
        assert_eq!(active_shape(false, true, true, None), window::IslandShape::Notification);
        assert_eq!(active_shape(true, true, true, None), window::IslandShape::Effect);
        let message = r#"{"type":"setNotificationShape","active":true,"requestId":7}"#;
        assert!(matches!(parse_view_command(message, true), Some(Command::SetNotificationShape(true, 7))));
        assert!(parse_view_command(message, false).is_none());
    }
    #[test]
    fn damaged_phone_preferences_do_not_discard_existing_tasks() {
        let original = AppState::default();
        for value in [serde_json::json!(null), serde_json::json!(false), serde_json::json!({"enabled":"yes",
            "displaySeconds":-1,"deviceAddress":"18446744073709551615"})] {
            let mut json = serde_json::to_value(&original).unwrap();
            json["phone"] = value;
            let state: AppState = serde_json::from_value(json).unwrap();
            assert_eq!(state.current_id, original.current_id);
            assert_eq!(state.tasks.len(), original.tasks.len());
            assert!(!state.phone.enabled);
            assert_eq!(state.phone.display_seconds, 8);
            assert!(state.phone.device_address.is_empty());
        }
    }
    fn task_request(value: serde_json::Value) -> TaskCreateRequest {
        match parse_command(&value.to_string()).expect("addTask must reach validation") {
            Command::AddTask(request) => request,
            _ => panic!("expected task creation"),
        }
    }

    fn duration_request(value: serde_json::Value) -> TaskDurationRequest {
        match parse_command(&value.to_string()).expect("setTaskDuration must reach validation") {
            Command::SetTaskDuration(request) => request,
            _ => panic!("expected task duration update"),
        }
    }

    fn task_duration_pending_action() -> (AppState, ActionController) {
        let mut state = AppState::default();
        state.tasks[0].completion_action = CompletionAction {
            enabled: true, kind: state::ActionKind::Lock, delay_sec: 300,
            ..CompletionAction::default()
        };
        let mut actions = ActionController::default();
        let mut update = TimerUpdate {
            run_id: "duration-test-run".into(), task_id: "t1".into(),
            started: true, running: true, remaining_ms: 1000.0, total_ms: 1500_000.0,
            ..TimerUpdate::default()
        };
        actions.observe(&update, &state);
        update.running = false;
        update.done = true;
        update.remaining_ms = 0.0;
        actions.observe(&update, &state);
        assert!(actions.complete(&TimerCompletion {
            run_id: update.run_id, task_id: update.task_id, task: "test".into(),
        }, Instant::now()));
        assert_eq!(actions.status().phase, actions::Phase::Pending);
        (state, actions)
    }

    #[test]
    fn task_duration_selected_boundaries_persist_then_reset_and_cancel_current_action() {
        for sec in [1, state::MAX_DURATION_SEC] {
            let file = TaskCreateTestFile::new();
            let (mut state, mut actions) = task_duration_pending_action();
            let request = duration_request(serde_json::json!({
                "type":"setTaskDuration", "taskId":"t1", "sec":sec, "requestId":17,
            }));
            assert!(apply_task_duration(&mut state, &mut actions, &request, &file.0).unwrap());
            assert_eq!(state.current_id, "t1");
            assert_eq!(state.tasks[0].sec, sec);
            assert_eq!(state.duration_sec, sec);
            assert_eq!(actions.status().phase, actions::Phase::Cancelled);
            assert_eq!(serde_json::to_value(AppState::load(&file.0)).unwrap(),
                serde_json::to_value(&state).unwrap());
            assert!(actions.poll(Instant::now() + Duration::from_secs(600)).is_none());
        }
    }

    #[test]
    fn task_duration_noncurrent_edit_preserves_selection_timer_and_pending_action() {
        let file = TaskCreateTestFile::new();
        let (mut state, mut actions) = task_duration_pending_action();
        // Custom timer duration can differ from its selected task's saved duration.
        state.duration_sec = 71;
        let mut expected = state.clone();
        expected.tasks[1].sec = 61;
        let action_before = actions.status().clone();
        let request = duration_request(serde_json::json!({
            "type":"setTaskDuration", "taskId":"t2", "sec":61, "requestId":"edit-second",
        }));
        assert!(!apply_task_duration(&mut state, &mut actions, &request, &file.0).unwrap());
        assert_eq!(serde_json::to_value(&state).unwrap(), serde_json::to_value(&expected).unwrap());
        assert_eq!(actions.status(), &action_before);
        assert_eq!(serde_json::to_value(AppState::load(&file.0)).unwrap(),
            serde_json::to_value(expected).unwrap());
    }

    #[test]
    fn task_duration_same_value_preserves_custom_timer_and_pending_action() {
        let file = TaskCreateTestFile::new();
        let (mut state, mut actions) = task_duration_pending_action();
        state.duration_sec = 71;
        let before = serde_json::to_value(&state).unwrap();
        let action_before = actions.status().clone();
        let request = duration_request(serde_json::json!({
            "type":"setTaskDuration", "taskId":"t1", "sec":state.tasks[0].sec, "requestId":18,
        }));
        assert!(!apply_task_duration(&mut state, &mut actions, &request, &file.0).unwrap());
        assert_eq!(serde_json::to_value(&state).unwrap(), before);
        assert_eq!(actions.status(), &action_before);
        assert_eq!(serde_json::to_value(AppState::load(&file.0)).unwrap(), before);
    }

    #[test]
    fn task_duration_invalid_fields_return_correlated_errors_without_mutation() {
        let file = TaskCreateTestFile::new();
        let (mut state, mut actions) = task_duration_pending_action();
        state.save_to_path(&file.0).unwrap();
        let before = serde_json::to_value(&state).unwrap();
        let disk_before = std::fs::read(&file.0).unwrap();
        let action_before = actions.status().clone();
        let base = serde_json::json!({
            "type":"setTaskDuration", "taskId":"t1", "sec":61, "requestId":"duration-error-19",
        });
        for (field, value) in [
            ("sec", serde_json::json!(0)),
            ("sec", serde_json::json!(state::MAX_DURATION_SEC + 1)),
            ("sec", serde_json::json!(u64::MAX)),
            ("sec", serde_json::json!(-1)),
            ("sec", serde_json::json!(1.5)),
            ("sec", serde_json::json!(1.0)),
            ("sec", serde_json::json!("61")),
            ("sec", serde_json::json!(true)),
            ("sec", serde_json::Value::Null),
            ("taskId", serde_json::json!("")),
            ("taskId", serde_json::json!("missing")),
            ("taskId", serde_json::json!(7)),
            ("taskId", serde_json::Value::Null),
        ] {
            let mut value_request = base.clone();
            value_request[field] = value;
            let request = duration_request(value_request.clone());
            let result = apply_task_duration(&mut state, &mut actions, &request, &file.0);
            assert!(result.is_err(), "{value_request}");
            let reply = task_duration_result(&request, &result);
            assert_eq!(reply["ok"], false);
            assert!(!reply["message"].as_str().unwrap().is_empty());
            assert_eq!(reply["taskId"], value_request["taskId"]);
            assert_eq!(reply["requestId"], value_request["requestId"]);
            assert_eq!(serde_json::to_value(&state).unwrap(), before);
            assert_eq!(std::fs::read(&file.0).unwrap(), disk_before);
            assert_eq!(actions.status(), &action_before);
        }
        for field in ["taskId", "sec"] {
            let mut value_request = base.clone();
            value_request.as_object_mut().unwrap().remove(field);
            let request = duration_request(value_request.clone());
            let result = apply_task_duration(&mut state, &mut actions, &request, &file.0);
            assert!(result.is_err());
            let reply = task_duration_result(&request, &result);
            assert_eq!(reply["taskId"], value_request["taskId"]);
            assert_eq!(reply["requestId"], value_request["requestId"]);
            assert_eq!(serde_json::to_value(&state).unwrap(), before);
            assert_eq!(std::fs::read(&file.0).unwrap(), disk_before);
            assert_eq!(actions.status(), &action_before);
        }
    }

    #[test]
    fn task_duration_save_failure_keeps_live_state_action_and_original_file() {
        let file = TaskCreateTestFile::new();
        let (mut state, mut actions) = task_duration_pending_action();
        state.save_to_path(&file.0).unwrap();
        let before = serde_json::to_value(&state).unwrap();
        let disk_before = std::fs::read(&file.0).unwrap();
        let action_before = actions.status().clone();
        for task_id in ["t1", "t2"] {
            let request = duration_request(serde_json::json!({
                "type":"setTaskDuration", "taskId":task_id, "sec":3, "requestId":20,
            }));
            let result = apply_task_duration(&mut state, &mut actions, &request, &file.0.join("blocked.json"));
            assert!(result.is_err());
            assert_eq!(task_duration_result(&request, &result)["ok"], false);
            assert_eq!(serde_json::to_value(&state).unwrap(), before);
            assert_eq!(std::fs::read(&file.0).unwrap(), disk_before);
            assert_eq!(actions.status(), &action_before);
        }
    }

    #[test]
    fn task_duration_success_response_preserves_correlation_values() {
        let file = TaskCreateTestFile::new();
        let (mut state, mut actions) = task_duration_pending_action();
        let request = duration_request(serde_json::json!({
            "type":"setTaskDuration", "taskId":"t2", "sec":9, "requestId":{"client":"panel","sequence":21},
        }));
        let result = apply_task_duration(&mut state, &mut actions, &request, &file.0);
        assert!(result.is_ok());
        let reply = task_duration_result(&request, &result);
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["taskId"], request.task_id);
        assert_eq!(reply["requestId"], request.request_id);
        let missing_id = duration_request(serde_json::json!({"type":"setTaskDuration"}));
        assert_eq!(task_duration_result(&missing_id, &Err("invalid request".into()))["requestId"],
            serde_json::Value::Null);
    }

    #[test]
    fn legacy_task_creation_defaults_to_disabled_action_and_zero_request_id() {
        let file = TaskCreateTestFile::new();
        let state = AppState::default();
        let request = task_request(serde_json::json!({"type":"addTask","name":"  新任务  ","sec":61}));
        assert_eq!(request.request_id, 0);
        assert!(request.completion_action.is_none());
        let (created, task_id) = created_task_state(&state, &request, &file.0).unwrap();
        assert_eq!(created.tasks.len(), state.tasks.len() + 1);
        let task = created.tasks.last().unwrap();
        assert_eq!(task.id, task_id);
        assert_eq!(task.name, "新任务");
        assert_eq!(task.sec, 61);
        assert!(!task.completion_action.enabled);
        assert_eq!(task.completion_action.delay_sec, 10);
        assert_eq!(AppState::load(&file.0).current_id, task_id);
    }

    #[test]
    fn task_and_action_save_together_and_roundtrip_without_mutating_source() {
        let file = TaskCreateTestFile::new();
        let state = AppState::default();
        let before = serde_json::to_value(&state).unwrap();
        let action = serde_json::json!({"enabled":true,"kind":"command",
            "command":"Write-Output '</script> 中文 \"quoted\"'","delaySec":17});
        let request = task_request(serde_json::json!({"type":"addTask","name":"创建即配置", "sec":7,
            "completionAction":action,"requestId":42}));
        assert_eq!(request.request_id, 42);
        let (created, task_id) = created_task_state(&state, &request, &file.0).unwrap();
        assert_eq!(serde_json::to_value(&state).unwrap(), before);
        assert_eq!(created.current_id, task_id);
        assert_eq!(created.duration_sec, 7);
        let loaded = AppState::load(&file.0);
        assert_eq!(loaded.current_id, task_id);
        assert_eq!(loaded.tasks.len(), state.tasks.len() + 1);
        assert_eq!(serde_json::to_value(&loaded.tasks.last().unwrap().completion_action).unwrap(), action);
        assert_eq!(serde_json::to_value(&loaded).unwrap(), serde_json::to_value(&created).unwrap());
        assert_eq!(std::fs::read_dir(file.0.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn creating_a_shell_task_keeps_explicit_interpreter_and_script() {
        let file = TaskCreateTestFile::new();
        let state = AppState::default();
        let action = serde_json::json!({"enabled":true,"kind":"shell","command":"printf '%s' '中文'","delaySec":0});
        let request = task_request(serde_json::json!({"type":"addTask","name":"Mac任务","sec":3,
            "completionAction":action,"requestId":43}));
        let (created, _) = created_task_state(&state, &request, &file.0).unwrap();
        let task = created.tasks.last().unwrap();
        assert_eq!(task.completion_action.kind, state::ActionKind::Shell);
        assert_eq!(serde_json::to_value(&task.completion_action).unwrap(), action);
        assert_eq!(AppState::load(&file.0).tasks.last().unwrap().completion_action, task.completion_action);
    }

    #[test]
    fn invalid_new_task_fields_return_errors_without_partial_creation() {
        let file = TaskCreateTestFile::new();
        let state = AppState::default();
        state.save_to_path(&file.0).unwrap();
        let before = serde_json::to_value(&state).unwrap();
        let disk_before = std::fs::read(&file.0).unwrap();
        let base = serde_json::json!({"type":"addTask","name":"有效名称","sec":5,"requestId":91});
        let invalid_fields = [
            ("name", serde_json::json!("   ")),
            ("name", serde_json::json!("\0\t")),
            ("name", serde_json::json!("名".repeat(121))),
            ("name", serde_json::Value::Null),
            ("sec", serde_json::json!(0)),
            ("sec", serde_json::json!(state::MAX_DURATION_SEC + 1)),
            ("sec", serde_json::json!(-1)),
            ("sec", serde_json::json!(1.5)),
            ("completionAction", serde_json::json!("invalid action type")),
            ("completionAction", serde_json::Value::Null),
            ("completionAction", serde_json::json!({"enabled":true,"kind":"command","command":" "})),
            ("completionAction", serde_json::json!({"enabled":true,"kind":"unknown"})),
            ("completionAction", serde_json::json!({"command":"x\0y"})),
            ("completionAction", serde_json::json!({"command":"x".repeat(4097)})),
            ("completionAction", serde_json::json!({"delaySec":301})),
            ("completionAction", serde_json::json!({"delaySec":-1})),
        ];
        for (field, value) in invalid_fields {
            let mut payload = base.clone();
            payload[field] = value;
            let request = task_request(payload);
            assert_eq!(request.request_id, 91);
            assert!(created_task_state(&state, &request, &file.0).is_err());
            assert_eq!(serde_json::to_value(&state).unwrap(), before);
            assert_eq!(std::fs::read(&file.0).unwrap(), disk_before);
        }
    }

    #[test]
    fn failed_task_save_keeps_existing_selection_duration_tasks_and_disk() {
        let file = TaskCreateTestFile::new();
        let mut state = AppState::default();
        state.current_id = "t2".into();
        state.duration_sec = 61;
        state.tasks[1].completion_action.enabled = true;
        state.tasks[1].completion_action.kind = state::ActionKind::Lock;
        state.save_to_path(&file.0).unwrap();
        let before = serde_json::to_value(&state).unwrap();
        let disk_before = std::fs::read(&file.0).unwrap();
        let request = task_request(serde_json::json!({"type":"addTask","name":"保存失败任务","sec":3,
            "completionAction":{"enabled":true,"kind":"command","command":"never executed","delaySec":0},"requestId":92}));
        // Existing file cannot become the parent directory of another state file.
        assert!(created_task_state(&state, &request, &file.0.join("nested.json")).is_err());
        assert_eq!(serde_json::to_value(&state).unwrap(), before);
        assert_eq!(std::fs::read(&file.0).unwrap(), disk_before);
        assert_eq!(AppState::load(&file.0).current_id, "t2");
        assert_eq!(std::fs::read_dir(file.0.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn ipc_seconds_and_clear() {
        assert!(matches!(parse_command(r#"{"type":"setDuration","sec":3}"#), Some(Command::SetDuration(3))));
        assert!(parse_command(r#"{"type":"setDuration","sec":1.5}"#).is_none());
        assert!(parse_command(r#"{"type":"setDuration","sec":-3}"#).is_none());
        assert!(matches!(parse_command(r#"{"type":"clearTasks"}"#), Some(Command::ClearTasks)));
        assert!(matches!(parse_command(r#"{"type":"dragPanel"}"#), Some(Command::DragPanel)));
        assert!(parse_command("invalid").is_none());
    }
    #[test]
    fn viewport_requests_support_new_ids_and_legacy_commands() {
        assert!(matches!(parse_command(r#"{"type":"setShape","open":true,"requestId":42}"#), Some(Command::SetShape(true, 42))));
        assert!(matches!(parse_command(r#"{"type":"setEffect","active":false,"requestId":43}"#), Some(Command::SetEffect(false, 43))));
        assert!(matches!(parse_command(r#"{"type":"setShape","open":false}"#), Some(Command::SetShape(false, 0))));
        assert!(matches!(parse_command(r#"{"type":"setEffect","active":true}"#), Some(Command::SetEffect(true, 0))));
    }
    #[test]
    fn cursor_watch_ipc_requires_explicit_boolean() {
        assert!(matches!(parse_command(r#"{"type":"watchCursor","enabled":true}"#),
            Some(Command::WatchCursor(true))));
        assert!(matches!(parse_command(r#"{"type":"watchCursor","enabled":false}"#),
            Some(Command::WatchCursor(false))));
        assert!(parse_command(r#"{"type":"watchCursor"}"#).is_none());
        assert!(parse_command(r#"{"type":"watchCursor","enabled":1}"#).is_none());
    }
    #[test]
    fn cursor_watch_samples_immediately_then_at_80ms_and_cancels() {
        let now = Instant::now();
        let mut watch = CursorWatch::default();
        assert!(!watch.take_due(now));
        assert_eq!(watch.next_sample, None);
        watch.set_enabled(true, now);
        assert!(watch.take_due(now));
        assert!(!watch.take_due(now + Duration::from_millis(79)));
        assert!(watch.take_due(now + Duration::from_millis(80)));
        let delayed = now + Duration::from_millis(300);
        assert!(watch.take_due(delayed));
        assert_eq!(watch.next_sample, Some(delayed + CURSOR_SAMPLE_INTERVAL));
        assert!(!watch.take_due(delayed));
        watch.set_enabled(false, delayed);
        assert_eq!(watch.next_sample, None);
        assert!(!watch.take_due(delayed + Duration::from_secs(60)));
        watch.set_enabled(true, delayed);
        assert!(watch.take_due(delayed));
    }
    #[test]
    fn cursor_watch_respects_visibility_and_eye_motion_preferences() {
        let mut settings = Settings::default();
        assert!(!cursor_watch_allowed(&settings, true, false, false));
        settings.show_idle_eyes = true;
        assert!(cursor_watch_allowed(&settings, true, false, false));
        assert!(!cursor_watch_allowed(&settings, true, true, false));
        assert!(!cursor_watch_allowed(&settings, true, false, true));
        assert!(!cursor_watch_allowed(&settings, false, false, false));
        settings.reduce_motion = true;
        assert!(!cursor_watch_allowed(&settings, true, false, false));
    }
    #[test]
    fn completion_ipc_is_scoped_and_internal_results_are_not_parseable() {
        for raw in [r#"{"type":"timerState","runId":"r","taskId":"t1","started":true,"running":true}"#,
            r#"{"type":"timerDone","runId":"r","taskId":"t1","task":"test"}"#] {
            assert!(parse_view_command(raw, true).is_some());
            assert!(parse_view_command(raw, false).is_none());
        }
        assert!(parse_command(r#"{"type":"actionFinished","runId":"r","ok":true}"#).is_none());
        assert!(parse_command(r#"{"type":"execute","command":"anything"}"#).is_none());
        assert!(matches!(parse_command(r#"{"type":"cancelCompletionAction","runId":"r"}"#),
            Some(Command::CancelCompletionAction(id)) if id == "r"));
    }
    #[test]
    fn action_config_validates_scope_without_mutating_original() {
        let state = AppState::default();
        let action = serde_json::json!({"enabled":true,"kind":"lock","delaySec":0});
        assert!(updated_action_state(&state, "", action.clone()).is_err());
        assert!(updated_action_state(&state, "missing", action.clone()).is_err());
        let updated = updated_action_state(&state, "t1", action.clone()).unwrap();
        assert!(updated.tasks[0].completion_action.enabled);
        assert!(!state.tasks[0].completion_action.enabled);
        let mut free = state.clone();
        free.tasks.clear(); free.current_id.clear();
        let before = serde_json::to_value(&free).unwrap();
        assert!(updated_action_state(&free, "", action.clone()).is_err());
        assert!(updated_action_state(&free, "missing", action).is_err());
        assert_eq!(serde_json::to_value(&free).unwrap(), before);
        for invalid in [serde_json::json!({"enabled":true,"kind":"command","command":" "}),
            serde_json::json!({"delaySec":-1}), serde_json::json!({"delaySec":301}),
            serde_json::json!({"command":"x\0y"})] {
            assert!(updated_action_state(&state, "t1", invalid).is_err());
        }
    }
    #[test]
    fn task_text_cannot_close_inline_script() {
        let mut state = AppState::default();
        state.tasks[0].name = "</script><script>alert(1)</script>".into();
        state.tasks[0].completion_action.command = "Write-Output '</script> 中文'".into();
        let payload = state_payload(&state);
        assert!(!payload.contains('<'));
        let decoded: AppState = serde_json::from_str(&payload).unwrap();
        assert_eq!(decoded.tasks[0].name, state.tasks[0].name);
        assert_eq!(decoded.tasks[0].completion_action.command, state.tasks[0].completion_action.command);
    }
}
