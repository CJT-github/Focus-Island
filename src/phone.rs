//! In-memory phone notifications. No scripts, file paths or executable actions.
#![cfg_attr(not(target_os = "windows"), allow(dead_code))]
use serde::{Deserialize, Serialize};
use std::sync::{mpsc, Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}};
use std::time::{Duration, Instant};
#[cfg(target_os = "windows")]
mod windows;

pub const MAX_MESSAGE_BYTES: usize = 8192;
const MAX_PARTS: u16 = 1024;
const ASSEMBLY_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneDevice { pub address: String, pub name: String }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneStatus {
    pub supported: bool,
    pub phase: String,
    pub message: String,
    pub devices: Vec<PhoneDevice>,
    pub device_name: String,
    pub device_address: String,
    pub notification_access: Option<bool>,
}
impl Default for PhoneStatus {
    fn default() -> Self {
        let supported = cfg!(target_os = "windows");
        Self { supported, phase: if supported { "disabled" } else { "unsupported" }.into(),
            message: if supported { "手机通知已关闭" } else { "此版本仅支持 Windows 接收 Android 蓝牙通知" }.into(),
            devices: vec![], device_name: String::new(), device_address: String::new(), notification_access: None }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneNotification {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
    pub app: String,
    pub package: String,
    pub title: String,
    pub body: String,
    pub time: u64,
}
impl std::fmt::Debug for PhoneNotification {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PhoneNotification").field("type", &self.kind).field("content", &"<redacted>").finish()
    }
}
#[derive(Clone, Debug, Serialize)]
pub enum PhoneEvent { Status(PhoneStatus), Notification(PhoneNotification) }

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum WireMessage {
    Posted { version: u8, id: String, app: String, package: String, title: String, body: String, time: u64 },
    Removed { version: u8, id: String },
    Status { version: u8, #[serde(rename = "notificationAccess")] notification_access: bool, name: String },
}
pub(super) enum DecodedMessage {
    Notification(PhoneNotification),
    Status { notification_access: bool, name: String },
}
pub(super) fn text(value: &str, limit: usize) -> String {
    value.chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').take(limit).collect()
}
fn valid_id(id: &str) -> bool { !id.trim().is_empty() && id.len() <= 256 && !id.chars().any(char::is_control) }
fn decode(bytes: &[u8]) -> Result<DecodedMessage, &'static str> {
    if bytes.is_empty() || bytes.len() > MAX_MESSAGE_BYTES { return Err("message length"); }
    let value: WireMessage = serde_json::from_slice(bytes).map_err(|_| "invalid notification JSON")?;
    match value {
        WireMessage::Posted { version: 1, id, app, package, title, body, time } if valid_id(&id) =>
            Ok(DecodedMessage::Notification(PhoneNotification { kind: "posted".into(), id,
                app: text(&app, 80), package: text(&package, 240), title: text(&title, 160), body: text(&body, 2000), time })),
        WireMessage::Removed { version: 1, id } if valid_id(&id) =>
            Ok(DecodedMessage::Notification(PhoneNotification { kind: "removed".into(), id,
                app: String::new(), package: String::new(), title: String::new(), body: String::new(), time: 0 })),
        WireMessage::Status { version: 1, notification_access, name } =>
            Ok(DecodedMessage::Status { notification_access, name: text(&name, 80) }),
        _ => Err("unsupported version or invalid identity"),
    }
}
struct PartialMessage { id: u16, count: u16, next: u16, started: Instant, bytes: Vec<u8> }
#[derive(Default)]
pub(super) struct Assembler { partial: Option<PartialMessage> }
impl Assembler {
    pub fn push(&mut self, packet: &[u8], now: Instant) -> Result<Option<DecodedMessage>, &'static str> {
        let result = self.push_inner(packet, now);
        if result.is_err() { self.partial = None; }
        result
    }
    fn push_inner(&mut self, packet: &[u8], now: Instant) -> Result<Option<DecodedMessage>, &'static str> {
        if self.partial.as_ref().is_some_and(|part| now.saturating_duration_since(part.started) >= ASSEMBLY_TIMEOUT) { self.partial = None; }
        if packet.len() <= 8 || packet.len() > MAX_MESSAGE_BYTES + 8 || packet[0] != 1 || packet[1] != 0 { return Err("invalid fragment header"); }
        let read = |offset| u16::from_le_bytes([packet[offset], packet[offset + 1]]);
        let (id, index, count) = (read(2), read(4), read(6));
        if count == 0 || count > MAX_PARTS || index >= count { return Err("invalid fragment range"); }
        if index == 0 {
            if self.partial.is_some() { return Err("overlapping messages"); }
            self.partial = Some(PartialMessage { id, count, next: 0, started: now, bytes: Vec::new() });
        }
        let part = self.partial.as_mut().ok_or("missing first fragment")?;
        if part.id != id || part.count != count || part.next != index { return Err("out of order fragment"); }
        if part.bytes.len() + packet.len() - 8 > MAX_MESSAGE_BYTES { return Err("message too large"); }
        part.bytes.extend_from_slice(&packet[8..]);part.next += 1;
        if part.next == count {
            let complete = self.partial.take().expect("active assembly");
            decode(&complete.bytes).map(Some)
        } else { Ok(None) }
    }
}

/// A successful CCCD write is not a completed protocol handshake. Only a
/// valid status frame resets the retry budget; late or missing status cannot
/// leave a live link permanently connected but unable to forward notifications.
#[derive(Default)]
pub(super) struct ConnectionRecovery { deadline: Option<Instant>, failures: u8 }
impl ConnectionRecovery {
    pub fn subscribed(&mut self, now: Instant) { self.deadline=Some(now+Duration::from_secs(10)); }
    pub fn confirmed(&mut self) { self.deadline=None;self.failures=0; }
    pub fn waiting(&self) -> bool { self.deadline.is_some() }
    pub fn expired(&self, now: Instant) -> bool { self.deadline.is_some_and(|deadline|now>=deadline) }
    pub fn failed(&mut self) -> bool {
        self.deadline=None;self.failures=self.failures.saturating_add(1);self.failures<3
    }
}

type Callback = Arc<dyn Fn(PhoneEvent) + Send + Sync>;
#[derive(Clone, Copy)]
pub(super) enum RequestKind { Configure(bool), Scan, Connect(u64), Disconnect, Shutdown }
pub(super) struct Request { pub epoch: u64, pub kind: RequestKind }
pub(super) struct Shared {
    pub epoch: AtomicU64,
    pub enabled: AtomicBool,
    pub closed: AtomicBool,
    status: Mutex<PhoneStatus>,
    callback: Callback,
}
impl Shared {
    pub fn active(&self, epoch: u64) -> bool {
        !self.closed.load(Ordering::Acquire) && self.enabled.load(Ordering::Acquire) && self.epoch.load(Ordering::Acquire) == epoch
    }
    pub fn publish(&self, status: PhoneStatus) {
        if self.closed.load(Ordering::Acquire) { return; }
        if let Ok(mut latest) = self.status.lock() { *latest = status.clone(); }
        (self.callback)(PhoneEvent::Status(status));
    }
    pub fn notification(&self, epoch: u64, value: PhoneNotification) {
        if self.active(epoch) { (self.callback)(PhoneEvent::Notification(value)); }
    }
}
pub struct PhoneManager { tx: mpsc::Sender<Request>, shared: Arc<Shared> }
impl PhoneManager {
    pub fn new(callback: impl Fn(PhoneEvent) + Send + Sync + 'static) -> Self {
        let (tx, rx) = mpsc::channel();
        let shared = Arc::new(Shared { epoch: AtomicU64::new(0), enabled: AtomicBool::new(false),
            closed: AtomicBool::new(false), status: Mutex::new(PhoneStatus::default()), callback: Arc::new(callback) });
        shared.publish(PhoneStatus::default());
        #[cfg(target_os = "windows")]
        { let worker = shared.clone();
          if std::thread::Builder::new().name("phone-bluetooth".into()).spawn(move || windows::run(rx, worker)).is_err() {
              let mut status = PhoneStatus::default();status.phase = "error".into();status.message = "无法启动蓝牙后台线程".into();shared.publish(status);
          }
        }
        #[cfg(not(target_os = "windows"))]
        drop(rx);
        Self { tx, shared }
    }
    fn request(&self, kind: RequestKind, cancel: bool) {
        let epoch = if cancel { self.shared.epoch.fetch_add(1, Ordering::AcqRel) + 1 } else { self.shared.epoch.load(Ordering::Acquire) };
        let _ = self.tx.send(Request { epoch, kind });
        #[cfg(not(target_os = "windows"))]
        self.shared.publish(PhoneStatus::default());
    }
    pub fn configure(&self, enabled: bool) {
        if self.shared.enabled.swap(enabled, Ordering::AcqRel) != enabled { self.request(RequestKind::Configure(enabled), true); }
    }
    pub fn scan(&self) { self.request(RequestKind::Scan, false); }
    pub fn connect(&self, address: u64) { self.request(RequestKind::Connect(address), true); }
    pub fn disconnect(&self) { self.request(RequestKind::Disconnect, true); }
    pub fn status(&self) -> PhoneStatus { self.shared.status.lock().map(|status| status.clone()).unwrap_or_default() }
}
impl Drop for PhoneManager {
    fn drop(&mut self) {
        self.shared.closed.store(true, Ordering::Release);self.shared.enabled.store(false, Ordering::Release);
        self.request(RequestKind::Shutdown, true);
        // Never join: cancellation makes every callback inert immediately.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn packet(id: u16, index: u16, count: u16, data: &[u8]) -> Vec<u8> {
        let mut packet = vec![1, 0];packet.extend(id.to_le_bytes());packet.extend(index.to_le_bytes());packet.extend(count.to_le_bytes());packet.extend(data);packet
    }
    fn posted(body: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"version":1,"type":"posted","id":"android:key","app":"App","package":"example.app","title":"Hello","body":body,"time":123})).unwrap()
    }
    #[test]
    fn ordered_fragments_allow_utf8_split_and_preserve_data() {
        let body = "中文 </script><script>danger()</script> \" quoted";
        let bytes = posted(body);let split = bytes.iter().position(|byte| *byte == 0xe4).unwrap() + 1;
        let mut assembler = Assembler::default();let now = Instant::now();
        assert!(assembler.push(&packet(7, 0, 2, &bytes[..split]), now).unwrap().is_none());
        let Some(DecodedMessage::Notification(value)) = assembler.push(&packet(7, 1, 2, &bytes[split..]), now).unwrap() else { panic!("notification"); };
        assert_eq!(value.body, body);assert_eq!(value.kind, "posted");
        let encoded = serde_json::to_value(&value).unwrap();assert_eq!(encoded["body"], body);
        assert!(!format!("{:?}", value).contains("danger"));
    }
    #[test]
    fn header_ranges_version_and_reserved_are_rejected() {
        for invalid in [vec![],vec![1;8],packet(1,0,0,b"x"),packet(1,0,1025,b"x"),packet(1,1,1,b"x")] {
            assert!(Assembler::default().push(&invalid,Instant::now()).is_err());
        }
        for index in [0,1] { let mut invalid=packet(1,0,1,&posted("ok"));invalid[index]=9;assert!(Assembler::default().push(&invalid,Instant::now()).is_err()); }
    }
    #[test]
    fn loss_reorder_duplicate_and_interleaving_reset_assembly() {
        let now=Instant::now();
        for invalid in [packet(4,2,3,b"b"),packet(4,0,3,b"b"),packet(5,1,3,b"b"),packet(4,1,2,b"b")] {
            let mut a=Assembler::default();assert!(a.push(&packet(4,0,3,b"a"),now).unwrap().is_none());assert!(a.push(&invalid,now).is_err());
            assert!(a.push(&packet(4,1,3,b"c"),now).is_err());assert!(a.push(&packet(6,0,1,&posted("recovered")),now).unwrap().is_some());
        }
    }
    #[test]
    fn assembly_expires_after_ten_seconds_without_leaking_previous_bytes() {
        let now=Instant::now();let mut a=Assembler::default();a.push(&packet(1,0,2,b"{"),now).unwrap();
        assert!(a.push(&packet(1,1,2,b"}"),now+ASSEMBLY_TIMEOUT).is_err());
        assert!(a.push(&packet(2,0,1,&posted("new")),now+ASSEMBLY_TIMEOUT).unwrap().is_some());
    }
    #[test]
    fn total_bytes_are_bounded_across_fragments() {
        let now=Instant::now();let mut a=Assembler::default();a.push(&packet(1,0,2,&vec![b'a';8192]),now).unwrap();
        assert!(a.push(&packet(1,1,2,b"x"),now).is_err());assert!(Assembler::default().push(&packet(2,0,1,&vec![b'a';8193]),now).is_err());
    }
    #[test]
    fn json_types_versions_id_and_invalid_utf8_are_rejected() {
        for invalid in [b"{}".as_slice(), b"{\"version\":1,\"type\":\"execute\",\"command\":\"x\"}".as_slice(), &[0xff]] { assert!(decode(invalid).is_err()); }
        for change in [serde_json::json!({"version":2}),serde_json::json!({"time":-1}),serde_json::json!({"id":""}),serde_json::json!({"id":"bad\u{0}"}),serde_json::json!({"command":"ignored?"})] {
            let mut value:serde_json::Value=serde_json::from_slice(&posted("ok")).unwrap();for (key,val) in change.as_object().unwrap(){value[key]=val.clone();}assert!(decode(&serde_json::to_vec(&value).unwrap()).is_err());
        }
    }
    #[test]
    fn notification_text_is_truncated_by_characters_and_controls_removed() {
        let Some(DecodedMessage::Notification(value))=Assembler::default().push(&packet(1,0,1,&posted(&"x".repeat(3000))),Instant::now()).unwrap() else { panic!("notification"); };
        assert_eq!(value.body.len(),2000);assert_eq!(text("a\0b\nc\t",20),"ab\nc\t");assert_eq!(text("汉字名",2),"汉字");
    }
    #[test]
    fn status_and_removal_are_distinct_from_posted_notifications() {
        assert!(matches!(decode(br#"{"version":1,"type":"status","notificationAccess":false,"name":"phone"}"#).unwrap(),DecodedMessage::Status{notification_access:false,..}));
        let DecodedMessage::Notification(value)=decode(br#"{"version":1,"type":"removed","id":"key"}"#).unwrap() else { panic!("removal"); };
        assert_eq!(value.kind,"removed");assert!(value.body.is_empty());
    }
    #[test]
    fn addresses_are_serialized_as_decimal_strings() {
        let mut status=PhoneStatus::default();status.device_address="281474976710655".into();let value=serde_json::to_value(status).unwrap();assert!(value["deviceAddress"].is_string());assert!(value.get("notificationAccess").is_some());
    }
    #[test]
    fn identities_use_byte_limits_without_truncating_unicode() {
        assert!(valid_id(&"x".repeat(256)));assert!(!valid_id(&"x".repeat(257)));
        assert!(valid_id(&"汉".repeat(85)));assert!(!valid_id(&"汉".repeat(86)));
    }
    #[test]
    fn cancellation_disable_and_shutdown_reject_late_notifications() {
        let deliveries=Arc::new(AtomicU64::new(0));let received=deliveries.clone();
        let shared=Shared{epoch:AtomicU64::new(1),enabled:AtomicBool::new(true),closed:AtomicBool::new(false),status:Mutex::new(PhoneStatus::default()),callback:Arc::new(move |event|{if matches!(event,PhoneEvent::Notification(_)){received.fetch_add(1,Ordering::SeqCst);}})};
        let DecodedMessage::Notification(value)=decode(&posted("private")).unwrap() else { panic!("notification"); };
        shared.notification(1,value.clone());assert_eq!(deliveries.load(Ordering::SeqCst),1);
        shared.epoch.store(2,Ordering::Release);shared.notification(1,value.clone());
        shared.enabled.store(false,Ordering::Release);shared.notification(2,value.clone());
        shared.enabled.store(true,Ordering::Release);shared.closed.store(true,Ordering::Release);shared.notification(2,value);
        assert_eq!(deliveries.load(Ordering::SeqCst),1);
    }
    #[test]
    fn missing_status_times_out_and_stops_after_three_attempts() {
        let now=Instant::now();let mut recovery=ConnectionRecovery::default();
        for attempt in 0..3 {
            let subscribed=now+Duration::from_secs(attempt*15);recovery.subscribed(subscribed);
            assert!(recovery.waiting());assert!(!recovery.expired(subscribed+Duration::from_millis(9999)));
            assert!(recovery.expired(subscribed+Duration::from_secs(10)));
            assert_eq!(recovery.failed(),attempt<2);assert!(!recovery.waiting());
        }
        assert!(!recovery.failed());
    }
    #[test]
    fn only_valid_status_resets_retry_budget_and_invalidated_links_have_no_deadline() {
        let now=Instant::now();let mut recovery=ConnectionRecovery::default();
        assert!(recovery.failed());recovery.subscribed(now);assert!(recovery.failed());
        recovery.subscribed(now+Duration::from_secs(1));recovery.confirmed();
        assert!(!recovery.waiting());assert!(!recovery.expired(now+Duration::from_secs(100)));
        assert!(recovery.failed());assert!(recovery.failed());assert!(!recovery.failed());
        recovery=ConnectionRecovery::default();assert!(!recovery.waiting());assert!(!recovery.expired(now+Duration::from_secs(100)));
    }
}
