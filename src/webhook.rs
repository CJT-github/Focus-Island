//! Bounded, authenticated incoming notifications. No task or command execution.
use crate::state::WebhookSettings;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::{mpsc, Arc, Condvar, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const HEADER_LIMIT: usize = 8192;
const BODY_LIMIT: usize = 16384;
const CONNECTION_QUEUE: usize = 16;
const WORKERS: usize = 4;
const IO_TIMEOUT: Duration = Duration::from_millis(500);
const REQUEST_DEADLINE: Duration = Duration::from_secs(3);
const RATE_WINDOW: Duration = Duration::from_secs(60);
const RATE_LIMIT: usize = 60;
static SERVER_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static MESSAGE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
pub struct WebhookNotification {
    #[serde(rename = "type")]
    pub kind: String,
    pub source: &'static str,
    pub id: String,
    pub app: String,
    pub title: String,
    pub body: String,
    pub time: u64,
}
impl std::fmt::Debug for WebhookNotification {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebhookNotification").field("type", &self.kind)
            .field("content", &"<redacted>").finish()
    }
}
#[derive(Clone, Debug)]
pub struct WebhookEvent { pub epoch: u64, pub notification: WebhookNotification }

#[derive(Clone, Debug, Serialize)]
pub struct WebhookPublicSettings { pub enabled: bool, pub scope: String, pub port: u16 }
impl From<&WebhookSettings> for WebhookPublicSettings {
    fn from(settings: &WebhookSettings) -> Self {
        Self { enabled: settings.enabled, scope: settings.scope.clone(), port: settings.port }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookStatus {
    pub phase: String,
    pub message: String,
    pub endpoint: String,
    pub lan_addresses: Vec<String>,
    pub accepted_count: u64,
    pub last_received_at: Option<u64>,
    pub settings: WebhookPublicSettings,
}

pub fn generate_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "无法生成安全令牌，请重试".to_string())?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(64);
    for byte in bytes { result.push(HEX[(byte >> 4) as usize] as char); result.push(HEX[(byte & 15) as usize] as char); }
    Ok(result)
}

pub fn validate_settings(settings: &WebhookSettings) -> Result<(), String> {
    if !matches!(settings.scope.as_str(), "local" | "lan") { return Err("请选择本机或局域网访问范围".into()); }
    if settings.port < 1024 { return Err("端口须为 1024–65535 的整数".into()); }
    let valid = settings.token.len() == 64 && settings.token.bytes().all(|byte| byte.is_ascii_hexdigit());
    if (settings.enabled || !settings.token.is_empty()) && !valid {
        return Err("访问令牌无效，请重新生成".into());
    }
    Ok(())
}

struct Runtime { settings: WebhookSettings, epoch: u64, server_id: u64, listening: bool, error: String }
#[derive(Default)]
struct Statistics { accepted: u64, last_received_at: Option<u64> }
struct RateLimiter { start: Instant, count: usize }
impl RateLimiter {
    fn new() -> Self { Self { start: Instant::now(), count: 0 } }
    fn admit(&mut self, now: Instant) -> bool {
        if now.saturating_duration_since(self.start) >= RATE_WINDOW { self.start = now; self.count = 0; }
        if self.count >= RATE_LIMIT { return false; }
        self.count += 1; true
    }
}
type Delivery = dyn Fn(WebhookEvent) -> bool + Send + Sync + 'static;
struct Shared { runtime: Mutex<Runtime>, statistics: Mutex<Statistics>, limiter: Mutex<RateLimiter>, delivery: Arc<Delivery> }

pub struct WebhookManager { shared: Arc<Shared>, server: Option<Server> }
/// A prepared listener and all its worker threads are dormant until commit.
/// Dropping this value (for example after a failed state save) rolls it back.
pub struct PreparedWebhook { settings: WebhookSettings, kind: PreparedKind }
enum PreparedKind { Disabled, Reuse, New(Server) }

impl WebhookManager {
    pub fn new(delivery: impl Fn(WebhookEvent) -> bool + Send + Sync + 'static) -> Self {
        Self { shared: Arc::new(Shared {
            runtime: Mutex::new(Runtime { settings: WebhookSettings::default(), epoch: 0, server_id: 0, listening: false, error: String::new() }),
            statistics: Mutex::new(Statistics::default()), limiter: Mutex::new(RateLimiter::new()), delivery: Arc::new(delivery),
        }), server: None }
    }

    pub fn prepare(&self, settings: &WebhookSettings) -> Result<PreparedWebhook, String> {
        validate_settings(settings)?;
        let kind = if !settings.enabled { PreparedKind::Disabled }
        else {
            let address = SocketAddr::new(IpAddr::V4(if settings.scope == "lan" { Ipv4Addr::UNSPECIFIED } else { Ipv4Addr::LOCALHOST }), settings.port);
            if self.server.as_ref().is_some_and(|server| server.address == address && server.alive.load(Ordering::Acquire)) {
                PreparedKind::Reuse
            } else {
                let overlapping = self.server.as_ref().is_some_and(|server| server.address.port() == settings.port && server.address != address);
                if overlapping { return Err("更改访问范围请先关闭服务，或同时更换端口".into()); }
                let listener = TcpListener::bind(address)
                    .map_err(|_| format!("无法监听端口 {}，请检查端口占用或系统权限", settings.port))?;
                listener.set_nonblocking(true).map_err(|_| "无法配置 Webhook 监听端口".to_string())?;
                PreparedKind::New(Server::prepare(listener, self.shared.clone())?)
            }
        };
        Ok(PreparedWebhook { settings: settings.clone(), kind })
    }

    /// Call only after the corresponding settings have been durably saved.
    /// All fallible binding/thread operations happened in prepare().
    pub fn commit(&mut self, prepared: PreparedWebhook) -> WebhookStatus {
        let PreparedWebhook { settings, kind } = prepared;
        let replacing = !matches!(kind, PreparedKind::Reuse);
        let next = match kind { PreparedKind::New(server) => Some(server), _ => None };
        {
            let mut runtime = self.shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
            runtime.epoch = runtime.epoch.wrapping_add(1);
            runtime.settings = settings;
            runtime.server_id = next.as_ref().or_else(|| if replacing { None } else { self.server.as_ref() }).map_or(0, |server| server.id);
            runtime.listening = runtime.settings.enabled && runtime.server_id != 0;
            runtime.error.clear();
        }
        if replacing { self.server = next; } // Old listener closes synchronously.
        if let Some(server) = &self.server { server.activate(); }
        self.status()
    }

    pub fn shutdown(&mut self) {
        let mut runtime = self.shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
        runtime.epoch = runtime.epoch.wrapping_add(1);
        runtime.listening = false;
        runtime.settings.enabled = false;
        drop(runtime);
        self.server.take();
    }

    pub fn is_current(&self, event: &WebhookEvent) -> bool {
        let runtime = self.shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
        runtime.settings.enabled && runtime.listening && event.epoch == runtime.epoch
    }

    pub fn status(&self) -> WebhookStatus {
        let runtime = self.shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
        let statistics = self.shared.statistics.lock().unwrap_or_else(|e| e.into_inner());
        let phase = if !runtime.settings.enabled { "disabled" } else if runtime.listening { "listening" } else { "error" };
        let message = if !runtime.error.is_empty() { runtime.error.clone() } else { match phase {
            "listening" if runtime.settings.scope == "lan" => "正在接收局域网通知",
            "listening" => "正在接收本机通知", "disabled" => "Webhook 已关闭", _ => "Webhook 尚未启动",
        }.into() };
        WebhookStatus { phase: phase.into(), message,
            endpoint: format!("http://127.0.0.1:{}/api/webhook", runtime.settings.port), lan_addresses: Vec::new(),
            accepted_count: statistics.accepted, last_received_at: statistics.last_received_at,
            settings: (&runtime.settings).into() }
    }
}
impl Drop for WebhookManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct Gate { active: Mutex<bool>, wake: Condvar }
struct Server {
    id: u64, address: SocketAddr, listener: Arc<Mutex<Option<TcpListener>>>,
    stop: Arc<AtomicBool>, alive: Arc<AtomicBool>, gate: Arc<Gate>,
}
struct Connection { stream: TcpStream, accepted: Instant }

impl Server {
    fn prepare(listener: TcpListener, shared: Arc<Shared>) -> Result<Self, String> {
        let address = listener.local_addr().map_err(|_| "无法读取 Webhook 监听地址".to_string())?;
        let server = Self { id: SERVER_SEQUENCE.fetch_add(1, Ordering::Relaxed), address,
            listener: Arc::new(Mutex::new(Some(listener))), stop: Arc::new(AtomicBool::new(false)), alive: Arc::new(AtomicBool::new(true)),
            gate: Arc::new(Gate { active: Mutex::new(false), wake: Condvar::new() }) };
        let (sender, receiver) = mpsc::sync_channel::<Connection>(CONNECTION_QUEUE);
        let receiver = Arc::new(Mutex::new(receiver));
        for index in 0..WORKERS {
            let receiver = receiver.clone(); let shared = shared.clone(); let stop = server.stop.clone(); let id = server.id;
            thread::Builder::new().name(format!("webhook-worker-{index}")).spawn(move || {
                while !stop.load(Ordering::Acquire) {
                    let result = receiver.lock().unwrap_or_else(|e| e.into_inner()).recv_timeout(Duration::from_millis(50));
                    match result {
                        Ok(connection) => handle_connection(connection, id, &shared, &stop),
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            }).map_err(|_| "无法启动 Webhook 工作线程".to_string())?;
        }
        let listener = server.listener.clone(); let stop = server.stop.clone(); let alive = server.alive.clone();
        let gate = server.gate.clone(); let id = server.id;
        thread::Builder::new().name("webhook-listener".into()).spawn(move || {
            let mut active = gate.active.lock().unwrap_or_else(|e| e.into_inner());
            while !*active && !stop.load(Ordering::Acquire) { active = gate.wake.wait(active).unwrap_or_else(|e| e.into_inner()); }
            drop(active);
            while !stop.load(Ordering::Acquire) {
                let accepted = {
                    let listener = listener.lock().unwrap_or_else(|e| e.into_inner());
                    let Some(listener) = listener.as_ref() else { break; };
                    listener.accept()
                };
                match accepted {
                    Ok((stream, _)) => {
                        // Winsock inherits FIONBIO from the listener; each worker
                        // needs blocking reads governed by its bounded timeout.
                        if stream.set_nonblocking(false).is_err() { continue; }
                        let connection = Connection { stream, accepted: Instant::now() };
                        match sender.try_send(connection) {
                            Ok(()) => {}
                            Err(mpsc::TrySendError::Full(mut connection)) => {
                                respond(&mut connection.stream, 503, &serde_json::json!({"ok":false,"error":"service busy"}), Instant::now()+Duration::from_millis(100));
                            }
                            Err(mpsc::TrySendError::Disconnected(_)) => break,
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(15)),
                    Err(_) => {
                        let mut runtime = shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
                        if runtime.server_id == id { runtime.listening = false; runtime.error = "Webhook 监听失败，请关闭后重试".into(); }
                        break;
                    }
                }
            }
            alive.store(false, Ordering::Release);
            listener.lock().unwrap_or_else(|e| e.into_inner()).take();
        }).map_err(|_| "无法启动 Webhook 监听线程".to_string())?;
        Ok(server)
    }

    fn activate(&self) {
        *self.gate.active.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.gate.wake.notify_all();
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        // Mutate the wait condition while holding its mutex so rollback cannot
        // lose the wakeup between the listener's stop check and Condvar::wait.
        let mut active = self.gate.active.lock().unwrap_or_else(|e| e.into_inner());
        self.stop.store(true, Ordering::Release); self.alive.store(false, Ordering::Release);
        *active = true;
        drop(active);
        // Release the bind synchronously without waiting for slow client readers.
        self.listener.lock().unwrap_or_else(|e| e.into_inner()).take();
        self.gate.wake.notify_all();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct HttpError(u16, &'static str);
struct RequestHead { body_offset: usize, content_length: usize, credential: Vec<u8>, secondary: Option<Vec<u8>> }

fn parse_head(bytes: &[u8]) -> Result<Option<RequestHead>, HttpError> {
    let mut headers = [httparse::EMPTY_HEADER; 48];
    let mut request = httparse::Request::new(&mut headers);
    let body_offset = match request.parse(bytes).map_err(|_| HttpError(400, "invalid HTTP request"))? {
        httparse::Status::Partial => {
            if bytes.len() >= HEADER_LIMIT { return Err(HttpError(413, "headers too large")); }
            return Ok(None);
        }
        httparse::Status::Complete(offset) => offset,
    };
    if body_offset > HEADER_LIMIT { return Err(HttpError(413, "headers too large")); }
    // httparse also accepts LF-only framing; enforce unambiguous CRLF framing.
    let header_bytes = &bytes[..body_offset];
    if header_bytes.iter().enumerate().any(|(i, byte)| *byte == b'\n' && (i == 0 || header_bytes[i-1] != b'\r')) {
        return Err(HttpError(400, "invalid line endings"));
    }
    if !matches!(request.version, Some(0 | 1)) { return Err(HttpError(400, "unsupported HTTP version")); }
    let mut length = None; let mut bearer = None; let mut content_type = None; let mut host = None;
    for header in request.headers.iter() {
        let name = header.name;
        if name.eq_ignore_ascii_case("transfer-encoding") || name.eq_ignore_ascii_case("trailer")
            || name.eq_ignore_ascii_case("expect") || name.eq_ignore_ascii_case("upgrade") {
            return Err(HttpError(400, "unsupported HTTP framing"));
        }
        if name.eq_ignore_ascii_case("origin") { return Err(HttpError(400, "browser origins are not supported")); }
        if name.eq_ignore_ascii_case("content-length") {
            if length.is_some() || header.value.is_empty() || !header.value.iter().all(u8::is_ascii_digit) { return Err(HttpError(400, "invalid content length")); }
            let value = std::str::from_utf8(header.value).ok().and_then(|v| v.parse::<usize>().ok()).ok_or(HttpError(413, "body too large"))?;
            if value > BODY_LIMIT { return Err(HttpError(413, "body too large")); }
            length = Some(value);
        }
        if name.eq_ignore_ascii_case("authorization") {
            if bearer.is_some() { return Err(HttpError(400, "duplicate authorization")); }
            let value = header.value;
            if value.len() != 71 || !value[..7].eq_ignore_ascii_case(b"Bearer ") { return Err(HttpError(401, "authentication required")); }
            bearer = Some(value[7..].to_vec());
        }
        if name.eq_ignore_ascii_case("content-type") {
            if content_type.is_some() { return Err(HttpError(400, "duplicate content type")); }
            content_type = Some(std::str::from_utf8(header.value).map_err(|_| HttpError(415, "JSON content type required"))?);
        }
        if name.eq_ignore_ascii_case("host") {
            if host.is_some() || header.value.is_empty() { return Err(HttpError(400, "invalid host")); }
            host = Some(header.value);
        }
    }
    if request.version == Some(1) && host.is_none() { return Err(HttpError(400, "host required")); }
    if request.method != Some("POST") { return Err(HttpError(405, "POST required")); }
    let path_token = if request.path == Some("/api/webhook") { None }
    else if let Some(token) = request.path.and_then(|path| path.strip_prefix("/api/webhook/")) {
        if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(HttpError(401, "authentication required"));
        }
        Some(token.as_bytes().to_vec())
    } else { return Err(HttpError(404, "not found")); };
    let content_length = length.ok_or(HttpError(400, "content length required"))?;
    if content_length == 0 { return Err(HttpError(400, "JSON body required")); }
    let content_type = content_type.ok_or(HttpError(415, "JSON content type required"))?;
    let mut parts = content_type.split(';');
    if !parts.next().unwrap_or("").trim().eq_ignore_ascii_case("application/json") { return Err(HttpError(415, "JSON content type required")); }
    for parameter in parts {
        if !parameter.trim().eq_ignore_ascii_case("charset=utf-8") { return Err(HttpError(415, "UTF-8 JSON required")); }
    }
    let (credential, secondary) = if let Some(token) = path_token { (token, bearer) }
        else { (bearer.ok_or(HttpError(401, "authentication required"))?, None) };
    Ok(Some(RequestHead { body_offset, content_length, credential, secondary }))
}

fn token_equal(expected: &[u8], actual: &[u8]) -> bool {
    // Fixed 64-byte comparison; token length is public and never prefix-compared.
    let mut difference = (expected.len() ^ 64) | (actual.len() ^ 64);
    for index in 0..64 { difference |= usize::from(std::hint::black_box(expected.get(index).copied().unwrap_or(0)) ^ std::hint::black_box(actual.get(index).copied().unwrap_or(0))); }
    std::hint::black_box(difference) == 0 && expected.len() == 64 && actual.len() == 64
}
fn invalid_character(character: char) -> bool {
    character.is_control() || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}
fn optional_string<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Incoming {
    #[serde(default, rename = "type", deserialize_with = "optional_string")] kind: Option<String>,
    #[serde(default, deserialize_with = "optional_string")] id: Option<String>,
    #[serde(default, deserialize_with = "optional_string")] app: Option<String>,
    #[serde(default, deserialize_with = "optional_string")] title: Option<String>,
    #[serde(default, deserialize_with = "optional_string")] body: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FeishuContent { text: String }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FeishuIncoming {
    msg_type: String,
    content: FeishuContent,
    #[serde(default, deserialize_with = "optional_string")] id: Option<String>,
    #[serde(default, deserialize_with = "optional_string")] app: Option<String>,
}
pub(crate) fn decode_notification(bytes: &[u8]) -> Result<WebhookNotification, HttpError> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| HttpError(400, "invalid notification JSON"))?;
    let request: Incoming = if value.get("msg_type").is_some() {
        if value.get("msg_type").and_then(|kind| kind.as_str()) != Some("text") {
            return Err(HttpError(400, "only text msg_type is supported"));
        }
        let value: FeishuIncoming = serde_json::from_slice(bytes).map_err(|_| HttpError(400, "invalid text notification JSON"))?;
        if value.msg_type != "text" { return Err(HttpError(400, "only text msg_type is supported")); }
        if value.content.text.trim().is_empty() { return Err(HttpError(400, "text content required")); }
        Incoming { kind: Some("posted".into()), id: value.id, app: value.app,
            title: Some("新消息".into()), body: Some(value.content.text) }
    } else { serde_json::from_slice(bytes).map_err(|_| HttpError(400, "invalid notification JSON"))? };
    let kind = request.kind.as_deref().unwrap_or("posted");
    if !matches!(kind, "posted" | "removed") { return Err(HttpError(400, "unsupported notification type")); }
    let id = if let Some(id) = request.id {
        if id.trim().is_empty() || id.len() > 256 || id.chars().any(invalid_character) { return Err(HttpError(400, "invalid notification id")); }
        id
    } else if kind == "removed" { return Err(HttpError(400, "removal id required")); }
    else { format!("webhook-{}-{}-{}", std::process::id(), timestamp(), MESSAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed)) };
    fn field(value: Option<String>, limit: usize, multiline: bool) -> Result<String, HttpError> {
        let value = value.unwrap_or_default();
        if value.chars().count() > limit || value.chars().any(|c| invalid_character(c) && !(multiline && matches!(c, '\n' | '\r' | '\t'))) { return Err(HttpError(400, "invalid notification text")); }
        Ok(value.trim().to_string())
    }
    let app = field(request.app, 80, false)?;
    let title = field(request.title, 256, false)?;
    let body = field(request.body, 2048, true)?;
    if kind == "posted" && title.is_empty() && body.is_empty() { return Err(HttpError(400, "title or body required")); }
    Ok(WebhookNotification { kind: kind.into(), source: "webhook", id, app: if app.is_empty() { "Webhook".into() } else { app }, title, body, time: timestamp() })
}
fn timestamp() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }

fn read_more(stream: &mut TcpStream, bytes: &mut Vec<u8>, maximum: usize, deadline: Instant, stop: &AtomicBool) -> Result<(), HttpError> {
    if stop.load(Ordering::Acquire) { return Err(HttpError(503, "service unavailable")); }
    let remaining = deadline.checked_duration_since(Instant::now()).filter(|v| !v.is_zero()).ok_or(HttpError(400, "request timeout"))?;
    stream.set_read_timeout(Some(remaining.min(IO_TIMEOUT))).map_err(|_| HttpError(503, "service unavailable"))?;
    let mut buffer = [0u8; 2048];
    let size = maximum.saturating_sub(bytes.len()).min(buffer.len());
    if size == 0 { return Err(HttpError(413, "request too large")); }
    match stream.read(&mut buffer[..size]) {
        Ok(0) => Err(HttpError(400, "incomplete request")),
        Ok(count) => { bytes.extend_from_slice(&buffer[..count]); Ok(()) }
        Err(_) => Err(HttpError(400, "request timeout")),
    }
}
fn receive_request(connection: &mut Connection, server_id: u64, shared: &Shared, stop: &AtomicBool) -> Result<(u64, WebhookNotification), HttpError> {
    let deadline = connection.accepted + REQUEST_DEADLINE;
    let mut bytes = Vec::with_capacity(2048);
    let head = loop {
        if let Some(head) = parse_head(&bytes)? { break head; }
        read_more(&mut connection.stream, &mut bytes, HEADER_LIMIT, deadline, stop)?;
    };
    let epoch = {
        let runtime = shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
        if !runtime.listening || !runtime.settings.enabled || runtime.server_id != server_id { return Err(HttpError(503, "service unavailable")); }
        if !token_equal(runtime.settings.token.as_bytes(), &head.credential)
            || head.secondary.as_ref().is_some_and(|token| !token_equal(runtime.settings.token.as_bytes(), token)) {
            return Err(HttpError(401, "authentication required"));
        }
        runtime.epoch
    };
    if !shared.limiter.lock().unwrap_or_else(|e| e.into_inner()).admit(Instant::now()) { return Err(HttpError(429, "rate limit exceeded")); }
    let expected = head.body_offset + head.content_length;
    if bytes.len() > expected { return Err(HttpError(400, "extra request data")); }
    while bytes.len() < expected { read_more(&mut connection.stream, &mut bytes, expected, deadline, stop)?; }
    if Instant::now() >= deadline { return Err(HttpError(400, "request timeout")); }
    let notification = decode_notification(&bytes[head.body_offset..expected])?;
    Ok((epoch, notification))
}

fn handle_connection(mut connection: Connection, server_id: u64, shared: &Shared, stop: &AtomicBool) {
    let result = receive_request(&mut connection, server_id, shared, stop).and_then(|(epoch, notification)| {
        let runtime = shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
        if !runtime.listening || !runtime.settings.enabled || runtime.server_id != server_id || runtime.epoch != epoch || stop.load(Ordering::Acquire) {
            return Err(HttpError(503, "service unavailable"));
        }
        let id = notification.id.clone();
        if !(shared.delivery)(WebhookEvent { epoch, notification }) { return Err(HttpError(503, "notification display unavailable")); }
        let mut statistics = shared.statistics.lock().unwrap_or_else(|e| e.into_inner());
        statistics.accepted += 1; statistics.last_received_at = Some(timestamp());
        Ok(id)
    });
    let (code, body) = match result {
        Ok(id) => (202, serde_json::json!({"ok":true,"id":id,"code":0,"msg":"success"})),
        Err(HttpError(code, error)) => (code, serde_json::json!({"ok":false,"error":error})),
    };
    respond(&mut connection.stream, code, &body, (Instant::now() + IO_TIMEOUT).min(connection.accepted + REQUEST_DEADLINE));
}
fn respond(stream: &mut TcpStream, code: u16, body: &serde_json::Value, deadline: Instant) {
    let reason = match code { 202=>"Accepted",400=>"Bad Request",401=>"Unauthorized",404=>"Not Found",
        405=>"Method Not Allowed",413=>"Payload Too Large",415=>"Unsupported Media Type",429=>"Too Many Requests",_=>"Service Unavailable" };
    let body = body.to_string();
    let extra = match code { 401=>"WWW-Authenticate: Bearer\r\n",405=>"Allow: POST\r\n",429=>"Retry-After: 60\r\n",_=>"" };
    let response = format!("HTTP/1.1 {code} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n{extra}\r\n{body}", body.len());
    let mut bytes = response.as_bytes();
    while !bytes.is_empty() {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()).filter(|v| !v.is_zero()) else { break; };
        if stream.set_write_timeout(Some(remaining.min(IO_TIMEOUT))).is_err() { break; }
        match stream.write(bytes) { Ok(0) | Err(_) => break, Ok(count) => bytes = &bytes[count..] }
    }
    // Send FIN only after queuing the complete response. Closing both halves
    // while an oversized request is still arriving makes Winsock send RST,
    // which can discard the 413 before an HTTP client has received it.
    let _ = stream.shutdown(Shutdown::Write);
    if code >= 400 {
        // Discard, never parse or retain, a bounded amount of unread input.
        // A peer that keeps uploading cannot extend the request deadline or
        // occupy a worker indefinitely. The accept-thread busy path shares
        // this bound and its shorter caller-supplied deadline.
        let drain_deadline = deadline.min(Instant::now() + Duration::from_millis(100));
        let mut remaining_bytes = 64 * 1024;
        let mut buffer = [0u8; 4096];
        while remaining_bytes > 0 {
            let Some(remaining) = drain_deadline.checked_duration_since(Instant::now()).filter(|v| !v.is_zero()) else { break; };
            if stream.set_read_timeout(Some(remaining)).is_err() { break; }
            let size = remaining_bytes.min(buffer.len());
            match stream.read(&mut buffer[..size]) {
                Ok(0) | Err(_) => break,
                Ok(count) => remaining_bytes -= count,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::Receiver;
    fn settings(port: u16) -> WebhookSettings {
        WebhookSettings { enabled: true, scope: "local".into(), port, token: "a".repeat(64), ..WebhookSettings::default() }
    }
    fn unused_port() -> u16 {
        TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port()
    }
    fn started() -> (WebhookManager, WebhookSettings, Receiver<WebhookEvent>) {
        let (sender, receiver) = mpsc::channel();
        let mut manager = WebhookManager::new(move |event| sender.send(event).is_ok());
        let settings = settings(unused_port());
        let prepared = manager.prepare(&settings).unwrap();
        assert_eq!(manager.status().phase, "disabled");
        manager.commit(prepared);
        (manager, settings, receiver)
    }
    fn request(path: &str, token: Option<&str>, body: &str) -> Vec<u8> {
        let auth = token.map(|token| format!("Authorization: Bearer {token}\r\n")).unwrap_or_default();
        format!("POST {path} HTTP/1.1\r\nHost: localhost\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).into_bytes()
    }
    fn exchange(port: u16, bytes: &[u8]) -> (u16, serde_json::Value, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        stream.write_all(bytes).unwrap();
        let _ = stream.shutdown(Shutdown::Write);
        let mut response = String::new();
        if let Err(error) = stream.read_to_string(&mut response) { assert!(!response.is_empty(), "{error}"); }
        let (head, body) = response.split_once("\r\n\r\n").expect("HTTP response");
        (head.split_whitespace().nth(1).unwrap().parse().unwrap(), serde_json::from_str(body).unwrap(), head.into())
    }
    fn send(settings: &WebhookSettings, body: &str) -> (u16, serde_json::Value, String) {
        exchange(settings.port, &request("/api/webhook", Some(&settings.token), body))
    }

    #[test]
    fn token_generation_validation_and_comparison_are_fixed_length_and_redacted() {
        let first = generate_token().unwrap(); let second = generate_token().unwrap();
        assert_eq!(first.len(), 64); assert_ne!(first, second);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(token_equal(first.as_bytes(), first.as_bytes()));
        assert!(!token_equal(first.as_bytes(), second.as_bytes()));
        assert!(!token_equal(first.as_bytes(), &first.as_bytes()[..63]));
        let mut different = first.as_bytes().to_vec(); different[63] ^= 1;
        assert!(!token_equal(first.as_bytes(), &different));
        for port in [0, 1, 1023] { assert!(validate_settings(&settings(port)).is_err()); }
        let notification = decode_notification(br#"{"id":"private-id","title":"private-title","body":"private-body"}"#).unwrap();
        let debug = format!("{notification:?}");
        assert!(!debug.contains("private"));
        assert!(debug.contains("redacted"));
    }

    #[test]
    fn posted_removed_and_feishu_text_have_one_forced_source_and_strict_limits() {
        let event = decode_notification(br#"{"id":"shared","app":"CI","title":"Complete","body":"line one\nline two"}"#).unwrap();
        assert_eq!(event.source, "webhook"); assert_eq!(event.id, "shared");
        assert!(event.body.contains('\n'));
        let removed = decode_notification(br#"{"type":"removed","id":"shared"}"#).unwrap();
        assert_eq!(removed.kind, "removed");
        let feishu = decode_notification(br#"{"msg_type":"text","content":{"text":"Build complete"},"id":"build","app":"CI"}"#).unwrap();
        assert_eq!(feishu.title, "新消息"); assert_eq!(feishu.body, "Build complete"); assert_eq!(feishu.app, "CI");
        let first = decode_notification(br#"{"body":"no id"}"#).unwrap();
        let second = decode_notification(br#"{"body":"no id"}"#).unwrap();
        assert_ne!(first.id, second.id);
        for json in [
            r#"{}"#, r#"{"type":"removed"}"#, r#"{"id":null,"title":"x"}"#,
            r#"{"title":"x","source":"phone"}"#, r#"{"title":"x","command":"anything"}"#,
            r#"{"type":"timer","title":"x"}"#, r#"{"title":32}"#,
            r#"{"msg_type":"image","content":{"text":"x"}}"#,
            r#"{"msg_type":"text","content":{"text":"x","file":"path"}}"#,
            r#"{"msg_type":"text","content":{"text":""}}"#,
        ] { assert!(decode_notification(json.as_bytes()).is_err(), "{json}"); }
        for (field, limit) in [("app",80),("title",256),("body",2048)] {
            let mut value = serde_json::json!({"body":"valid"});
            value[field] = serde_json::Value::String("界".repeat(limit));
            assert!(decode_notification(value.to_string().as_bytes()).is_ok());
            value[field] = serde_json::Value::String("界".repeat(limit+1));
            assert!(decode_notification(value.to_string().as_bytes()).is_err());
        }
        let mut value = serde_json::json!({"id":"界".repeat(85),"title":"valid"});
        assert!(decode_notification(value.to_string().as_bytes()).is_ok());
        value["id"] = serde_json::Value::String("界".repeat(86));
        assert!(decode_notification(value.to_string().as_bytes()).is_err());
    }

    #[test]
    fn header_parser_rejects_ambiguous_framing_browser_origins_and_wrong_routes() {
        let valid = String::from_utf8(request("/api/webhook", Some(&"a".repeat(64)), r#"{"title":"x"}"#)).unwrap();
        for (changed, code) in [
            (valid.replace("Content-Length:", "Transfer-Encoding: chunked\r\nContent-Length:"),400),
            (valid.replace("Content-Length:", "Content-Length: 13\r\nContent-Length:"),400),
            (valid.replace("Content-Type:", "Origin: https://example.test\r\nContent-Type:"),400),
            (valid.replace("Content-Type:", "Authorization: Bearer secret\r\nContent-Type:"),400),
            (valid.replace("Host:", "Host: localhost\r\nHost:"),400),
            (valid.replace("application/json","text/plain"),415),
            (valid.replace("POST ","GET "),405),
            (valid.replace("/api/webhook ","/other "),404),
            (valid.replace("\r\n","\n"),400),
            (valid.replace("Content-Length: 13", "Content-Length: +13"),400),
            (valid.replace("Content-Length: 13", "Content-Length: 999999999999999999999999"),413),
        ] { assert_eq!(parse_head(changed.as_bytes()).err().unwrap().0, code); }
        let unknown = request(&format!("/api/webhook/{}", "x".repeat(64)), None, r#"{"title":"x"}"#);
        assert_eq!(parse_head(&unknown).err().unwrap().0,401);
        assert!(parse_head(b"POST /api/webhook HTTP/1.1\r\nHost:").unwrap().is_none());
        assert_eq!(parse_head(format!("POST /api/webhook HTTP/1.1\r\nX: {}", "a".repeat(HEADER_LIMIT)).as_bytes()).err().unwrap().0,413);
    }

    #[test]
    fn real_tcp_bearer_and_secret_url_accept_native_and_feishu_messages() {
        let (manager, settings, events) = started();
        let (code, body, header) = send(&settings, r#"{"id":"same","title":"First"}"#);
        assert_eq!(code,202); assert_eq!(body["id"],"same"); assert_eq!(body["code"],0);
        assert!(header.contains("Connection: close")); assert!(!header.contains(&settings.token));
        let first = events.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(manager.is_current(&first)); assert_eq!(first.notification.title,"First");
        let url = format!("/api/webhook/{}",settings.token);
        let (code,body,_) = exchange(settings.port,&request(&url,None,r#"{"msg_type":"text","content":{"text":"Second"},"id":"same"}"#));
        assert_eq!(code,202); assert_eq!(body["msg"],"success");
        let second = events.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(second.notification.id, first.notification.id);
        assert_eq!(second.notification.body,"Second"); assert_eq!(second.notification.source,"webhook");
        let (code,_,_) = send(&settings,r#"{"type":"removed","id":"same"}"#); assert_eq!(code,202);
        assert_eq!(events.recv_timeout(Duration::from_secs(1)).unwrap().notification.kind,"removed");
        let status = manager.status(); assert_eq!(status.accepted_count,3); assert!(status.last_received_at.is_some());
        let public = serde_json::to_string(&status).unwrap(); assert!(!public.contains(&settings.token));
    }

    #[test]
    fn real_tcp_bad_auth_origin_oversized_body_and_unknown_actions_never_deliver() {
        let (_manager, settings, events) = started();
        let wrong = request("/api/webhook",Some(&"b".repeat(64)),r#"{"title":"x"}"#);
        assert_eq!(exchange(settings.port,&wrong).0,401);
        let path = format!("/api/webhook/{}","b".repeat(64));
        assert_eq!(exchange(settings.port,&request(&path,None,r#"{"title":"x"}"#)).0,401);
        let original = String::from_utf8(request("/api/webhook",Some(&settings.token),r#"{"title":"x"}"#)).unwrap();
        assert_eq!(exchange(settings.port,original.replace("Host:","Origin: null\r\nHost:").as_bytes()).0,400);
        assert_eq!(exchange(settings.port,original.replace("Content-Length: 13","Content-Length: 16385").as_bytes()).0,413);
        assert_eq!(send(&settings,r#"{"title":"x","command":"do not run"}"#).0,400);
        assert_eq!(send(&settings,r#"{"type":"startTimer","title":"x"}"#).0,400);
        assert!(events.try_recv().is_err());
    }

    #[test]
    fn real_oversized_upload_gets_complete_413_without_client_half_close() {
        let (_manager, settings, events) = started();
        let body = serde_json::json!({"body":"x".repeat(17000)}).to_string();
        let bytes = request("/api/webhook", Some(&settings.token), &body);
        assert!(body.len() > BODY_LIMIT);
        for _ in 0..8 {
            let mut stream = TcpStream::connect(("127.0.0.1", settings.port)).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            // Match HTTP clients: upload the actual large body and wait for
            // the response without proactively shutting down the send side.
            stream.write_all(&bytes).unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).expect("complete HTTP response, not a reset");
            let (head, body) = response.split_once("\r\n\r\n").unwrap();
            assert!(head.starts_with("HTTP/1.1 413"));
            assert_eq!(serde_json::from_str::<serde_json::Value>(body).unwrap()["ok"], false);
        }
        assert!(events.try_recv().is_err());
    }

    #[test]
    fn prepare_rollback_and_bind_failure_preserve_listener_token_and_epoch() {
        let (mut manager, settings, events) = started();
        let mut rotated = settings.clone(); rotated.token = "b".repeat(64);
        let initial = send(&settings,r#"{"title":"before"}"#); assert_eq!(initial.0,202);
        let event = events.recv_timeout(Duration::from_secs(1)).unwrap();
        let prepared = manager.prepare(&rotated).unwrap(); drop(prepared);
        assert!(manager.is_current(&event)); assert_eq!(send(&settings,r#"{"title":"after rollback"}"#).0,202);
        assert_eq!(send(&rotated,r#"{"title":"bad rotated"}"#).0,401);
        let occupied = TcpListener::bind(("127.0.0.1",0)).unwrap();
        let mut conflict = settings.clone(); conflict.port = occupied.local_addr().unwrap().port();
        assert!(manager.prepare(&conflict).is_err()); assert_eq!(manager.status().settings.port,settings.port);
        let mut other = settings.clone(); other.port = unused_port();
        let prepared = manager.prepare(&other).unwrap();
        assert!(TcpListener::bind(("127.0.0.1",other.port)).is_err());
        drop(prepared);
        assert!(TcpListener::bind(("127.0.0.1",other.port)).is_ok());
        let mut scope = settings.clone(); scope.scope="lan".into();
        assert!(manager.prepare(&scope).err().unwrap().contains("更改访问范围"));
        manager.shutdown();
    }

    #[test]
    fn token_rotation_reuses_same_port_and_invalidates_bearer_url_and_queued_events() {
        let (mut manager, settings, events) = started();
        assert_eq!(send(&settings,r#"{"title":"old generation"}"#).0,202);
        let old = events.recv_timeout(Duration::from_secs(1)).unwrap();
        let mut rotated = settings.clone(); rotated.token="b".repeat(64);
        let prepared = manager.prepare(&rotated).unwrap(); manager.commit(prepared);
        assert!(!manager.is_current(&old));
        assert_eq!(send(&settings,r#"{"title":"old bearer"}"#).0,401);
        let old_url=format!("/api/webhook/{}",settings.token);
        assert_eq!(exchange(settings.port,&request(&old_url,None,r#"{"title":"old URL"}"#)).0,401);
        assert_eq!(send(&rotated,r#"{"title":"new bearer"}"#).0,202);
        let new_url=format!("/api/webhook/{}",rotated.token);
        assert_eq!(exchange(settings.port,&request(&new_url,None,r#"{"msg_type":"text","content":{"text":"new URL"}}"#)).0,202);
        let current=events.recv_timeout(Duration::from_secs(1)).unwrap(); assert!(manager.is_current(&current));
        manager.shutdown(); manager.shutdown();
        assert!(!manager.is_current(&current)); assert_eq!(manager.status().phase,"disabled");
        assert!(TcpListener::bind(("127.0.0.1",settings.port)).is_ok());
    }

    #[test]
    fn configuration_change_rejects_inflight_old_authenticated_body() {
        let (mut manager, settings, events) = started();
        let body=r#"{"title":"must not be delivered after rotation"}"#;
        let request=request("/api/webhook",Some(&settings.token),body);
        let cut=request.len()-body.len()+1;
        let mut stream=TcpStream::connect(("127.0.0.1",settings.port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        stream.write_all(&request[..cut]).unwrap();
        thread::sleep(Duration::from_millis(100));
        let mut rotated=settings.clone();rotated.token="b".repeat(64);
        let prepared=manager.prepare(&rotated).unwrap();manager.commit(prepared);
        stream.write_all(&request[cut..]).unwrap();
        let mut response=String::new();let _=stream.read_to_string(&mut response);
        assert!(response.starts_with("HTTP/1.1 503")||response.starts_with("HTTP/1.1 401"));
        assert!(events.try_recv().is_err());
    }

    #[test]
    fn unavailable_consumer_is_503_and_does_not_increment_accepted_statistics() {
        let mut manager=WebhookManager::new(|_|false);
        let settings=settings(unused_port());let prepared=manager.prepare(&settings).unwrap();manager.commit(prepared);
        assert_eq!(send(&settings,r#"{"title":"x"}"#).0,503);
        assert_eq!(manager.status().accepted_count,0);
    }

    #[test]
    fn rate_limit_caps_authenticated_requests_and_resets_after_the_window() {
        let mut limiter=RateLimiter::new();let now=Instant::now();
        for _ in 0..60 {assert!(limiter.admit(now));}
        assert!(!limiter.admit(now));assert!(limiter.admit(now+Duration::from_secs(61)));
        let (manager,settings,_events)=started();
        manager.shared.limiter.lock().unwrap().count=60;
        assert_eq!(send(&settings,r#"{"title":"limited"}"#).0,429);
        assert_eq!(manager.status().accepted_count,0);
    }

    #[test]
    fn slow_trickle_cannot_extend_the_absolute_deadline() {
        let (_manager,settings,events)=started();
        let mut stream=TcpStream::connect(("127.0.0.1",settings.port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        let started=Instant::now();
        stream.write_all(b"POST /api/webhook HTTP/1.1\r\nHost: ").unwrap();
        for _ in 0..22 {
            if stream.write_all(b"a").is_err(){break;}
            thread::sleep(Duration::from_millis(160));
        }
        let mut output=String::new();
        if let Err(error) = stream.read_to_string(&mut output) {
            assert!(!matches!(error.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock));
        }
        assert!(started.elapsed()<Duration::from_secs(5));
        assert!(events.try_recv().is_err());
    }

    #[test]
    fn bounded_worker_queue_rejects_excess_connections_without_spawning_unbounded_workers() {
        let (_manager,settings,_events)=started();
        let mut clients=Vec::new();
        for _ in 0..WORKERS+CONNECTION_QUEUE+4 {
            let stream=TcpStream::connect(("127.0.0.1",settings.port)).unwrap();
            stream.set_read_timeout(Some(Duration::from_millis(900))).unwrap();
            clients.push(stream);
        }
        let mut busy=false;
        for mut stream in clients.into_iter().rev().take(4) {
            let mut output=String::new();let _=stream.read_to_string(&mut output);
            busy |= output.starts_with("HTTP/1.1 503");
        }
        assert!(busy);
    }

    #[test]
    fn abandoned_prepared_listeners_release_ports_and_waiting_threads() {
        let manager=WebhookManager::new(|_|true);
        let baseline=Arc::strong_count(&manager.shared);
        for _ in 0..20 {
            let config=settings(unused_port());
            drop(manager.prepare(&config).unwrap());
            assert!(TcpListener::bind(("127.0.0.1",config.port)).is_ok());
        }
        let deadline=Instant::now()+Duration::from_secs(2);
        while Arc::strong_count(&manager.shared)>baseline && Instant::now()<deadline { thread::sleep(Duration::from_millis(20)); }
        assert_eq!(Arc::strong_count(&manager.shared),baseline);
    }
}
