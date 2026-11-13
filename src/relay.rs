//! Outbound HTTPS relay. Credentials and message bodies are never logged.
use crate::state::RelaySettings;
use crate::webhook::WebhookNotification;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Condvar, Mutex, atomic::{AtomicBool, Ordering}};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const RESPONSE_LIMIT: u64 = 384 * 1024;
const BATCH_LIMIT: usize = 20;
const HTTP_TIMEOUT: Duration = Duration::from_secs(5);
const REDELIVERY_AFTER: Duration = Duration::from_secs(10);
#[cfg(not(test))]
const POLL_INTERVAL: Duration = Duration::from_secs(2);
#[cfg(test)]
const POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Clone, Debug)]
pub struct RelayEvent {
    pub epoch: u64,
    pub delivery_id: String,
    pub notification: WebhookNotification,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    pub phase: String,
    pub message: String,
    pub accepted_count: u64,
    pub last_received_at: Option<u64>,
    pub token_revision: u64,
}
impl Default for RelayStatus {
    fn default() -> Self { Self { phase: "disabled".into(), message: "服务器连接未开启".into(), accepted_count: 0, last_received_at: None, token_revision: 0 } }
}
#[derive(Clone, Copy, Debug)]
enum RelayError { Network, Authentication, Protocol }
impl RelayError {
    fn message(self) -> &'static str {
        match self {
            Self::Network => "无法连接服务器，将自动重试",
            Self::Authentication => "连接密钥无效，请检查服务器配置",
            Self::Protocol => "服务器响应不符合通知协议，请检查部署版本",
        }
    }
}
trait Transport: Send + Sync {
    fn request(&self, settings: &RelaySettings, path: &str, body: Option<&[u8]>) -> Result<serde_json::Value, RelayError>;
}
struct HttpsTransport { agent: ureq::Agent }
impl HttpsTransport {
    fn new() -> Self {
        let config = ureq::Agent::config_builder()
            .https_only(true).max_redirects(0).proxy(None)
            .tls_config(ureq::tls::TlsConfig::builder().provider(ureq::tls::TlsProvider::NativeTls)
                .root_certs(ureq::tls::RootCerts::PlatformVerifier).build())
            .http_status_as_error(false).max_response_header_size(8192)
            .timeout_global(Some(HTTP_TIMEOUT))
            .max_idle_connections(1).max_idle_connections_per_host(1).build();
        Self { agent: ureq::Agent::new_with_config(config) }
    }
}
impl Transport for HttpsTransport {
    fn request(&self, settings: &RelaySettings, path: &str, body: Option<&[u8]>) -> Result<serde_json::Value, RelayError> {
        let endpoint = format!("{}{path}", settings.service_url);
        let authorization = format!("Bearer {}", settings.connection_key);
        // No redirects, custom CA bypass, unverified TLS, URL credentials or
        // application logging. Native TLS verifies the platform root chain.
        let mut response = if let Some(body) = body {
            self.agent.post(&endpoint).header("Authorization", &authorization)
                .header("Content-Type", "application/json").header("Accept", "application/json").send(body)
        } else {
            self.agent.get(&endpoint).header("Authorization", &authorization)
                .header("Accept", "application/json").call()
        }.map_err(|_| RelayError::Network)?;
        match response.status().as_u16() {
            200..=299 => {},
            401 | 403 => return Err(RelayError::Authentication),
            _ => return Err(RelayError::Protocol),
        }
        let content_type = response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("");
        if !content_type.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("application/json") {
            return Err(RelayError::Protocol);
        }
        let bytes = response.body_mut().with_config().limit(RESPONSE_LIMIT).read_to_vec().map_err(|_| RelayError::Protocol)?;
        serde_json::from_slice(&bytes).map_err(|_| RelayError::Protocol)
    }
}

struct Runtime {
    settings: RelaySettings,
    epoch: u64,
    shutdown: bool,
    status: RelayStatus,
    webhook_token: Option<String>,
    info_received: Option<Instant>,
    inflight: HashMap<String, Instant>,
    acknowledgements: HashSet<String>,
}
type Delivery = dyn Fn(RelayEvent) -> bool + Send + Sync + 'static;
struct Shared {
    runtime: Mutex<Runtime>,
    wake: Condvar,
    delivery: Arc<Delivery>,
    delivery_enabled: Arc<AtomicBool>,
    transport: Arc<dyn Transport>,
}
pub struct RelayManager { shared: Arc<Shared>, worker: Option<Worker> }
pub struct PreparedRelay { settings: RelaySettings, worker: Option<Worker> }
struct Worker { stop: Arc<AtomicBool>, shared: Arc<Shared> }
impl Worker {
    fn spawn(shared: Arc<Shared>) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let worker_shared = shared.clone();
        thread::Builder::new().name("focus-relay".into()).spawn(move || run(worker_shared, worker_stop))
            .map_err(|_| "无法启动服务器连接线程".to_string())?;
        Ok(Self { stop, shared })
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        // Synchronize the stop change with the wait condition to avoid a lost
        // wake when a prepared (never committed) worker is rolled back.
        let _runtime = self.shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
        self.stop.store(true, Ordering::Release);
        self.shared.wake.notify_all();
    }
}
impl RelayManager {
    pub fn new(delivery: impl Fn(RelayEvent)->bool + Send + Sync + 'static, delivery_enabled: Arc<AtomicBool>) -> Self {
        Self::with_transport(Arc::new(delivery), delivery_enabled, Arc::new(HttpsTransport::new()))
    }
    fn with_transport(delivery: Arc<Delivery>, delivery_enabled: Arc<AtomicBool>, transport: Arc<dyn Transport>) -> Self {
        Self { shared: Arc::new(Shared {
            runtime: Mutex::new(Runtime { settings: RelaySettings::default(), epoch: 0, shutdown: false,
                status: RelayStatus::default(), webhook_token: None, info_received: None, inflight: HashMap::new(), acknowledgements: HashSet::new() }),
            wake: Condvar::new(), delivery, delivery_enabled, transport,
        }), worker: None }
    }
    pub fn prepare(&self, settings: &RelaySettings) -> Result<PreparedRelay, String> {
        settings.validate()?;
        if self.shared.runtime.lock().unwrap_or_else(|e| e.into_inner()).shutdown { return Err("服务器连接已停止".into()); }
        let worker = if settings.enabled && self.worker.is_none() { Some(Worker::spawn(self.shared.clone())?) } else { None };
        Ok(PreparedRelay { settings: settings.clone(), worker })
    }
    pub fn commit(&mut self, mut prepared: PreparedRelay) -> RelayStatus {
        if let Some(worker) = prepared.worker.take() { self.worker = Some(worker); }
        let mut runtime = self.shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
        runtime.epoch = runtime.epoch.wrapping_add(1);
        runtime.settings = prepared.settings.clone();
        runtime.webhook_token = None;
        runtime.info_received = None;
        runtime.inflight.clear();
        runtime.acknowledgements.clear();
        if runtime.settings.enabled {
            runtime.status.phase = "connecting".into();
            runtime.status.message = "正在连接服务器".into();
        } else {
            runtime.status.phase = "disabled".into();
            runtime.status.message = "服务器连接未开启".into();
        }
        self.shared.wake.notify_all();
        runtime.status.clone()
    }
    pub fn status(&self) -> RelayStatus {
        self.shared.runtime.lock().unwrap_or_else(|e| e.into_inner()).status.clone()
    }
    /// Only an explicit panel response may use this; ordinary status is public.
    pub fn webhook_token(&self) -> Option<String> {
        self.shared.runtime.lock().unwrap_or_else(|e| e.into_inner()).webhook_token.clone()
    }
    pub fn is_current(&self, event: &RelayEvent) -> bool {
        let runtime = self.shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
        !runtime.shutdown && runtime.settings.enabled && runtime.epoch == event.epoch
    }
    pub fn acknowledge(&self, event: &RelayEvent) {
        let mut runtime = self.shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
        if runtime.shutdown || !runtime.settings.enabled || runtime.epoch != event.epoch
            || !self.shared.delivery_enabled.load(Ordering::Acquire) || !runtime.inflight.contains_key(&event.delivery_id) { return; }
        if runtime.acknowledgements.insert(event.delivery_id.clone()) {
            runtime.status.accepted_count += 1;
            runtime.status.last_received_at = Some(timestamp());
        }
        self.shared.wake.notify_all();
    }
    pub fn shutdown(&mut self) {
        {
            let mut runtime = self.shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
            if runtime.shutdown { return; }
            runtime.shutdown = true;
            runtime.epoch = runtime.epoch.wrapping_add(1);
            runtime.settings.enabled = false;
            runtime.webhook_token = None;
            runtime.info_received = None;
            runtime.inflight.clear();
            runtime.acknowledgements.clear();
            runtime.status.phase = "disabled".into();
            runtime.status.message = "服务器连接已关闭".into();
            self.shared.wake.notify_all();
        }
        self.worker.take();
    }
}
impl Drop for RelayManager { fn drop(&mut self) { self.shutdown(); } }

fn current(runtime: &Runtime, epoch: u64, shared: &Shared, stop: &AtomicBool) -> bool {
    !runtime.shutdown && runtime.settings.enabled && runtime.epoch == epoch
        && !stop.load(Ordering::Acquire) && shared.delivery_enabled.load(Ordering::Acquire)
}
fn wait(shared: &Shared, stop: &AtomicBool, epoch: Option<u64>, duration: Duration) {
    let runtime = shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
    if runtime.shutdown || stop.load(Ordering::Acquire) || epoch.is_some_and(|epoch| runtime.epoch != epoch) { return; }
    let _ = shared.wake.wait_timeout(runtime, duration).unwrap_or_else(|e| e.into_inner());
}
fn timestamp() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn valid_hex(value: &str) -> bool { value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()) }
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Info { protocol: u32, webhook_token: String }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Messages { messages: Vec<RemoteMessage> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RemoteMessage { delivery_id: String, notification: RemoteNotification }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteNotification {
    #[serde(rename="type")] kind: String, source: String, id: String, app: String, title: String, body: String, time: u64,
}
fn decode_messages(value: serde_json::Value, epoch: u64) -> Result<Vec<RelayEvent>, RelayError> {
    let parsed: Messages = serde_json::from_value(value).map_err(|_| RelayError::Protocol)?;
    if parsed.messages.len() > BATCH_LIMIT { return Err(RelayError::Protocol); }
    let mut ids = HashSet::new();
    parsed.messages.into_iter().map(|message| {
        if !valid_hex(&message.delivery_id) || !ids.insert(message.delivery_id.clone()) || message.notification.source != "webhook" {
            return Err(RelayError::Protocol);
        }
        let incoming = message.notification;
        let value = serde_json::json!({"type":incoming.kind,"id":incoming.id,"app":incoming.app,"title":incoming.title,"body":incoming.body});
        let mut notification = crate::webhook::decode_notification(value.to_string().as_bytes()).map_err(|_| RelayError::Protocol)?;
        notification.time = incoming.time;
        Ok(RelayEvent { epoch, delivery_id: message.delivery_id, notification })
    }).collect()
}
fn cycle(shared: &Shared, stop: &AtomicBool, settings: &RelaySettings, epoch: u64) -> Result<(), RelayError> {
    let need_info = {
        let runtime = shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
        if !current(&runtime, epoch, shared, stop) { return Ok(()); }
        runtime.webhook_token.is_none() || runtime.info_received.is_none_or(|received| received.elapsed() >= Duration::from_secs(60))
    };
    if need_info {
        let response = shared.transport.request(settings, "/api/relay/info", None)?;
        let info: Info = serde_json::from_value(response).map_err(|_| RelayError::Protocol)?;
        if info.protocol != 1 || !valid_hex(&info.webhook_token) { return Err(RelayError::Protocol); }
        let mut runtime = shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
        if !current(&runtime, epoch, shared, stop) { return Ok(()); }
        if runtime.webhook_token.as_deref() != Some(info.webhook_token.as_str()) {
            runtime.status.token_revision = runtime.status.token_revision.wrapping_add(1);
        }
        runtime.webhook_token = Some(info.webhook_token);
        runtime.info_received = Some(Instant::now());
    }
    let ack_ids: Vec<String> = {
        let runtime = shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
        if !current(&runtime, epoch, shared, stop) { return Ok(()); }
        runtime.acknowledgements.iter().take(BATCH_LIMIT).cloned().collect()
    };
    if !ack_ids.is_empty() {
        let body = serde_json::json!({"ids":ack_ids}).to_string();
        let response = shared.transport.request(settings, "/api/relay/ack", Some(body.as_bytes()))?;
        if response.get("ok").and_then(|v|v.as_bool()) != Some(true) { return Err(RelayError::Protocol); }
        let mut runtime = shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
        if !current(&runtime, epoch, shared, stop) { return Ok(()); }
        for id in &ack_ids { runtime.acknowledgements.remove(id); runtime.inflight.remove(id); }
    }
    {
        let runtime = shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
        if !current(&runtime, epoch, shared, stop) { return Ok(()); }
    }
    let value = shared.transport.request(settings, "/api/relay/messages", None)?;
    let messages = decode_messages(value, epoch)?;
    let mut runtime = shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
    if !current(&runtime, epoch, shared, stop) { return Ok(()); }
    let visible: HashSet<&str> = messages.iter().map(|event| event.delivery_id.as_str()).collect();
    let acknowledged = runtime.acknowledgements.clone();
    // The server returns the first 20 entries. Entries absent from that head
    // have expired, been acknowledged elsewhere, or disappeared on restart.
    runtime.inflight.retain(|id, _| visible.contains(id.as_str()) || acknowledged.contains(id));
    runtime.status.phase = "connected".into();
    runtime.status.message = "已连接，正在接收通知".into();
    for event in messages {
        if runtime.acknowledgements.contains(&event.delivery_id) { continue; }
        if runtime.inflight.get(&event.delivery_id).is_some_and(|sent| sent.elapsed() < REDELIVERY_AFTER) { continue; }
        if runtime.inflight.len() >= BATCH_LIMIT && !runtime.inflight.contains_key(&event.delivery_id) { continue; }
        if (shared.delivery)(event.clone()) {
            runtime.inflight.insert(event.delivery_id, Instant::now());
        }
    }
    Ok(())
}
fn run(shared: Arc<Shared>, stop: Arc<AtomicBool>) {
    let mut failures = 0u32;
    let mut previous_epoch = 0;
    loop {
        let snapshot = {
            let mut runtime = shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
            if runtime.shutdown || stop.load(Ordering::Acquire) { break; }
            if !runtime.settings.enabled || !shared.delivery_enabled.load(Ordering::Acquire) {
                if runtime.settings.enabled {
                    runtime.status.phase = "connecting".into();
                    runtime.status.message = "等待通知框开启".into();
                }
                None
            } else { Some((runtime.settings.clone(), runtime.epoch)) }
        };
        let Some((settings, epoch)) = snapshot else { wait(&shared, &stop, None, Duration::from_millis(100)); continue; };
        if previous_epoch != epoch { failures = 0; previous_epoch = epoch; }
        let delay = match cycle(&shared, &stop, &settings, epoch) {
            Ok(()) => { failures = 0; POLL_INTERVAL },
            Err(error) => {
                let mut runtime = shared.runtime.lock().unwrap_or_else(|e| e.into_inner());
                if current(&runtime, epoch, &shared, &stop) {
                    runtime.webhook_token = None;
                    runtime.info_received = None;
                    runtime.status.phase = "error".into();
                    runtime.status.message = error.message().into();
                }
                failures = failures.saturating_add(1);
                Duration::from_secs((2u64.saturating_pow(failures.min(5))).min(30))
            },
        };
        wait(&shared, &stop, Some(epoch), delay);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{mpsc, atomic::AtomicUsize};
    fn config() -> RelaySettings {
        RelaySettings { enabled: true, service_url: "https://relay.example.com".into(), connection_key: "a".repeat(64) }
    }
    fn message(index: usize) -> serde_json::Value {
        serde_json::json!({"deliveryId":format!("{index:064x}"),"notification":{
            "type":"posted","source":"webhook","id":format!("message-{index}"),"app":"Relay",
            "title":"test","body":"body","time":1234}})
    }
    #[derive(Default)]
    struct Fake {
        queue: Mutex<Vec<serde_json::Value>>,
        paths: Mutex<Vec<String>>,
        fail_ack: AtomicBool,
        token_changed: AtomicBool,
    }
    impl Transport for Fake {
        fn request(&self, _: &RelaySettings, path: &str, body: Option<&[u8]>) -> Result<serde_json::Value, RelayError> {
            self.paths.lock().unwrap().push(path.into());
            match path {
                "/api/relay/info" => Ok(serde_json::json!({"protocol":1,"webhookToken":if self.token_changed.load(Ordering::Acquire) {"c".repeat(64)}else{"b".repeat(64)}})),
                "/api/relay/messages" => Ok(serde_json::json!({"messages":self.queue.lock().unwrap().clone()})),
                "/api/relay/ack" => {
                    if self.fail_ack.swap(false, Ordering::AcqRel) { return Err(RelayError::Network); }
                    let body: serde_json::Value = serde_json::from_slice(body.unwrap()).unwrap();
                    let ids = body["ids"].as_array().unwrap();
                    self.queue.lock().unwrap().retain(|item|!ids.contains(&item["deliveryId"]));
                    Ok(serde_json::json!({"ok":true,"acked":ids.len()}))
                },
                _ => panic!("unexpected fixed API route"),
            }
        }
    }
    fn fixture() -> (RelayManager, Arc<Fake>, Arc<AtomicBool>, mpsc::Receiver<RelayEvent>) {
        let transport = Arc::new(Fake::default());
        let gate = Arc::new(AtomicBool::new(true));
        let (tx, rx) = mpsc::channel();
        let mut manager = RelayManager::with_transport(Arc::new(move |event|tx.send(event).is_ok()), gate.clone(), transport.clone());
        // Exercise deterministic cycles without the production worker's clock.
        manager.commit(PreparedRelay { settings: config(), worker: None });
        (manager, transport, gate, rx)
    }
    fn tick(manager: &RelayManager) -> Result<(), RelayError> {
        let (settings, epoch) = {
            let runtime=manager.shared.runtime.lock().unwrap();
            (runtime.settings.clone(),runtime.epoch)
        };
        cycle(&manager.shared, &AtomicBool::new(false), &settings, epoch)
    }
    #[test]
    fn preparation_rollback_is_dormant_and_invalid_settings_do_not_change_state() {
        let fake=Arc::new(Fake::default());
        let gate=Arc::new(AtomicBool::new(false));
        let mut manager=RelayManager::with_transport(Arc::new(|_|true),gate.clone(),fake.clone());
        let baseline=Arc::strong_count(&manager.shared);
        drop(manager.prepare(&config()).unwrap());
        thread::sleep(Duration::from_millis(60));
        assert!(fake.paths.lock().unwrap().is_empty());
        assert_eq!(manager.status().phase,"disabled");
        assert_eq!(Arc::strong_count(&manager.shared),baseline);
        let prepared=manager.prepare(&config()).unwrap();
        manager.commit(prepared);
        thread::sleep(Duration::from_millis(60));
        assert!(fake.paths.lock().unwrap().is_empty());
        let mut invalid=config();invalid.service_url="http://localhost".into();
        assert!(manager.prepare(&invalid).is_err());
        assert_eq!(manager.shared.runtime.lock().unwrap().settings,config());
        gate.store(true,Ordering::Release);
        let deadline=Instant::now()+Duration::from_secs(2);
        while manager.status().phase!="connected" && Instant::now()<deadline {thread::sleep(Duration::from_millis(20));}
        assert_eq!(manager.status().phase,"connected");
        manager.shutdown();manager.shutdown();
        assert!(manager.prepare(&config()).is_err());
    }
    #[test]
    fn events_are_acked_only_after_ui_confirmation_and_retry_without_double_counting() {
        let (manager,fake,gate,events)=fixture();
        fake.queue.lock().unwrap().push(message(1));
        tick(&manager).unwrap();
        let event=events.recv().unwrap();
        assert!(manager.is_current(&event));
        assert_eq!(manager.status().accepted_count,0);
        assert!(!fake.paths.lock().unwrap().iter().any(|p|p.ends_with("/ack")));
        gate.store(false,Ordering::Release);
        manager.acknowledge(&event);
        let before=fake.paths.lock().unwrap().len();
        tick(&manager).unwrap();
        assert_eq!(fake.paths.lock().unwrap().len(),before);
        assert_eq!(manager.status().accepted_count,0);
        gate.store(true,Ordering::Release);
        manager.acknowledge(&event);
        manager.acknowledge(&event);
        fake.fail_ack.store(true,Ordering::Release);
        assert!(tick(&manager).is_err());
        assert_eq!(manager.shared.runtime.lock().unwrap().acknowledgements.len(),1);
        tick(&manager).unwrap();
        assert!(fake.queue.lock().unwrap().is_empty());
        assert!(events.try_recv().is_err());
        assert_eq!(manager.status().accepted_count,1);
        assert!(manager.status().last_received_at.is_some());
        assert!(manager.shared.runtime.lock().unwrap().inflight.is_empty());
    }
    #[test]
    fn expired_server_entries_free_slots_and_unconfirmed_messages_are_redelivered() {
        let (manager,fake,_gate,events)=fixture();
        *fake.queue.lock().unwrap()=(1..=20).map(message).collect();
        tick(&manager).unwrap();
        assert_eq!(events.try_iter().count(),20);
        assert_eq!(manager.shared.runtime.lock().unwrap().inflight.len(),20);
        *fake.queue.lock().unwrap()=vec![message(21)];
        tick(&manager).unwrap();
        let event=events.recv_timeout(Duration::from_millis(100)).unwrap();
        assert_eq!(event.delivery_id,format!("{:064x}",21));
        assert_eq!(manager.shared.runtime.lock().unwrap().inflight.len(),1);
        tick(&manager).unwrap();
        assert!(events.try_recv().is_err());
        manager.shared.runtime.lock().unwrap().inflight.insert(event.delivery_id.clone(),Instant::now()-REDELIVERY_AFTER);
        tick(&manager).unwrap();
        assert_eq!(events.recv().unwrap().delivery_id,event.delivery_id);
    }
    #[test]
    fn epoch_changes_invalidate_pending_deliveries_and_status_never_serializes_secrets() {
        let (mut manager,fake,_gate,events)=fixture();
        fake.queue.lock().unwrap().push(message(1));
        tick(&manager).unwrap();
        let event=events.recv().unwrap();
        let status=serde_json::to_string(&manager.status()).unwrap();
        assert!(!status.contains(&"a".repeat(64))&&!status.contains(&"b".repeat(64)));
        assert_eq!(manager.webhook_token(),Some("b".repeat(64)));
        let mut changed=config();changed.connection_key="c".repeat(64);
        manager.commit(PreparedRelay{settings:changed,worker:None});
        assert!(!manager.is_current(&event));
        manager.acknowledge(&event);
        assert!(manager.shared.runtime.lock().unwrap().acknowledgements.is_empty());
        assert_eq!(manager.webhook_token(),None);
        manager.shutdown();
        assert!(!manager.is_current(&event));
    }
    #[test]
    fn remote_protocol_validates_batch_ids_sources_text_and_unknown_actions() {
        assert_eq!(decode_messages(serde_json::json!({"messages":[message(1)]}),7).unwrap()[0].epoch,7);
        for change in 0..6 {
            let mut item=message(1);
            match change {
                0=>item["deliveryId"]="short".into(),
                1=>item["notification"]["source"]="phone".into(),
                2=>item["notification"]["command"]="do not execute".into(),
                3=>item["notification"]["type"]="startTimer".into(),
                4=>item["notification"]["body"]="x".repeat(2049).into(),
                _=>item["notification"]["time"]=(-1).into(),
            }
            assert!(decode_messages(serde_json::json!({"messages":[item]}),0).is_err());
        }
        assert!(decode_messages(serde_json::json!({"messages":[message(1),message(1)]}),0).is_err());
        assert!(decode_messages(serde_json::json!({"messages":(0..21).map(message).collect::<Vec<_>>()}),0).is_err());
    }

    #[test]
    fn relay_token_refreshes_without_a_network_failure_and_old_epoch_wait_is_immediate() {
        let (manager,fake,_gate,_events)=fixture();
        tick(&manager).unwrap();
        assert_eq!(manager.webhook_token(),Some("b".repeat(64)));
        fake.token_changed.store(true,Ordering::Release);
        manager.shared.runtime.lock().unwrap().info_received=Some(Instant::now()-Duration::from_secs(61));
        tick(&manager).unwrap();
        assert_eq!(manager.webhook_token(),Some("c".repeat(64)));
        assert_eq!(manager.status().token_revision,2);
        let started=Instant::now();
        wait(&manager.shared,&AtomicBool::new(false),Some(0),Duration::from_secs(30));
        assert!(started.elapsed()<Duration::from_millis(200));
    }
    #[test]
    fn old_network_response_cannot_deliver_after_rotation_or_notification_disable() {
        struct Blocked {
            fake: Fake,
            entered: mpsc::SyncSender<()>,
            release: Mutex<mpsc::Receiver<()>>,
        }
        impl Transport for Blocked {
            fn request(&self, settings:&RelaySettings, path:&str, body:Option<&[u8]>) -> Result<serde_json::Value,RelayError> {
                let value=self.fake.request(settings,path,body)?;
                if path.ends_with("/messages") {
                    self.entered.send(()).unwrap();
                    self.release.lock().unwrap().recv_timeout(Duration::from_secs(2)).unwrap();
                }
                Ok(value)
            }
        }
        for rotate in [true,false] {
            let (entered_tx,entered_rx)=mpsc::sync_channel(1);
            let (release_tx,release_rx)=mpsc::channel();
            let fake=Fake::default();fake.queue.lock().unwrap().push(message(1));
            let transport=Arc::new(Blocked{fake,entered:entered_tx,release:Mutex::new(release_rx)});
            let (event_tx,event_rx)=mpsc::channel();
            let gate=Arc::new(AtomicBool::new(true));
            let mut manager=RelayManager::with_transport(Arc::new(move|event|event_tx.send(event).is_ok()),gate.clone(),transport);
            manager.commit(PreparedRelay{settings:config(),worker:None});
            let shared=manager.shared.clone();
            let worker=thread::spawn(move||cycle(&shared,&AtomicBool::new(false),&config(),1));
            entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            if rotate {
                let mut next=config();next.connection_key="c".repeat(64);
                manager.commit(PreparedRelay{settings:next,worker:None});
            } else {gate.store(false,Ordering::Release);}
            release_tx.send(()).unwrap();
            worker.join().unwrap().unwrap();
            assert!(event_rx.try_recv().is_err());
            assert!(manager.shared.runtime.lock().unwrap().acknowledgements.is_empty());
        }
    }

    fn trusted_transport() -> HttpsTransport {
        let cert=ureq::tls::Certificate::from_pem(TEST_CERT.as_bytes()).unwrap();
        let tls=ureq::tls::TlsConfig::builder().provider(ureq::tls::TlsProvider::NativeTls)
            .root_certs(ureq::tls::RootCerts::Specific(Arc::new(vec![cert]))).build();
        let config=ureq::Agent::config_builder().https_only(true).max_redirects(0).proxy(None)
            .tls_config(tls).http_status_as_error(false).max_response_header_size(8192)
            .timeout_global(Some(HTTP_TIMEOUT)).max_idle_connections(1).max_idle_connections_per_host(1).build();
        HttpsTransport {agent:ureq::Agent::new_with_config(config)}
    }
    fn tls_fixture(code: u16, extra: &str, body: Vec<u8>, slow: bool) -> (RelaySettings, thread::JoinHandle<()>, Arc<AtomicUsize>) {
        let identity=native_tls::Identity::from_pkcs8(TEST_CERT.as_bytes(),TEST_KEY.as_bytes()).unwrap();
        let acceptor=native_tls::TlsAcceptor::new(identity).unwrap();
        let listener=TcpListener::bind(("127.0.0.1",0)).unwrap();
        let port=listener.local_addr().unwrap().port();
        let count=Arc::new(AtomicUsize::new(0));let requests=count.clone();
        let extra=extra.to_string();
        let handle=thread::spawn(move||{
            let (stream,_)=listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(7))).unwrap();
            stream.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
            let Ok(mut stream)=acceptor.accept(stream) else{return;};
            let mut head=Vec::new();let mut byte=[0u8;1];
            while !head.ends_with(b"\r\n\r\n") && head.len()<8192 {
                if stream.read_exact(&mut byte).is_err(){return;}head.push(byte[0]);
            }
            requests.fetch_add(1,Ordering::SeqCst);
            let header=format!("HTTP/1.1 {code} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n",body.len());
            if stream.write_all(header.as_bytes()).is_err(){return;}
            if slow {
                for chunk in body.chunks(1) {
                    if stream.write_all(chunk).is_err(){return;}
                    thread::sleep(Duration::from_millis(250));
                }
            } else {let _=stream.write_all(&body);}
            let _=stream.shutdown();
        });
        let mut settings=config();settings.service_url=format!("https://127.0.0.1:{port}");
        (settings,handle,count)
    }
    #[test]
    fn actual_tls_rejects_unknown_ca_and_http_and_never_disables_verification() {
        let client=HttpsTransport::new();
        assert!(client.agent.config().https_only());
        assert_eq!(client.agent.config().max_redirects(),0);
        assert!(!client.agent.config().tls_config().disable_verification());
        let (settings,server,count)=tls_fixture(200,"",br#"{"ok":true}"#.to_vec(),false);
        assert!(matches!(client.request(&settings,"/api/relay/info",None),Err(RelayError::Network)));
        server.join().unwrap();
        assert_eq!(count.load(Ordering::SeqCst),0);
        let mut invalid=config();invalid.service_url="http://127.0.0.1:1".into();
        assert!(client.request(&invalid,"/api/relay/info",None).is_err());
    }
    #[test]
    fn actual_tls_limits_response_body_and_does_not_follow_redirects_or_leak_401_details() {
        let client=trusted_transport();
        for (code,extra,body,expected) in [
            (200,"",br#"{"ok":true}"#.to_vec(),None),
            (302,"Location: https://127.0.0.1:1/must-not-follow\r\n",b"{}".to_vec(),Some(RelayError::Protocol)),
            (401,"",br#"{"error":"private server detail"}"#.to_vec(),Some(RelayError::Authentication)),
            (200,"",vec![b'x';RESPONSE_LIMIT as usize+1],Some(RelayError::Protocol)),
        ] {
            let (settings,server,count)=tls_fixture(code,extra,body,false);
            let result=client.request(&settings,"/api/relay/info",None);
            if let Some(expected)=expected {
                assert_eq!(result.err().unwrap().message(),expected.message());
            } else {assert_eq!(result.unwrap()["ok"],true);}
            server.join().unwrap();
            assert_eq!(count.load(Ordering::SeqCst),1);
        }
    }
    #[test]
    fn actual_tls_body_trickle_cannot_extend_five_second_total_timeout() {
        let client=trusted_transport();
        let (settings,server,_)=tls_fixture(200,"",vec![b' ';40],true);
        let started=Instant::now();
        assert!(client.request(&settings,"/api/relay/info",None).is_err());
        assert!(started.elapsed()<Duration::from_millis(6500));
        server.join().unwrap();
    }
    // Public, self-signed localhost fixture used only in unit tests. Its key
    // cannot authenticate any real service; no system trust store is changed.
    const TEST_CERT: &str = "-----BEGIN CERTIFICATE-----\nMIIDJzCCAg+gAwIBAgIUf2OGiK2KTrnZ70RLMCohI4Don08wDQYJKoZIhvcNAQEL\nBQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTExMzAzMTMxN1oYDzIxMjYx\nMDIwMDMxMzE3WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB\nAQUAA4IBDwAwggEKAoIBAQCvQ9L8eFCZRLmHvc7Mqtv7Nn1m2WPChhhiJ41URLqF\ndHLKa5oc3JERpHpqzgG8NrnazSt3xhKo60U8td0jrk6PnjLffFNtfwHACF/PHp/Q\n6NhNL/mUKIGAUIfTNYlzA6wodYT0/RnlOmN1FILF/Mnzv6uzyPRCuNFoRJZ5W3M+\nLmSuedGM7Ka7y6Fq1lyPTMAfkKYIHjHJBiF7YDG5o9Tzsjt58YTA0VCnVvb7+fuX\nBvJ7g3bA1FwTJMy2wnyJ7usS8jYmnoDTauPJpL7Y1CFolFH4gU0JKmVOZX5kBEM7\nJQVqKkrrnFX69+vtqqDAl27sLgPzeJo24D6A7xu7GguJAgMBAAGjbzBtMB0GA1Ud\nDgQWBBRoSWrbcb6V6fUicLxFIT6cJb2S5zAfBgNVHSMEGDAWgBRoSWrbcb6V6fUi\ncLxFIT6cJb2S5zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwDwYDVR0TAQH/\nBAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAUyhfKoE5BsQ6/eb4J875UGip+vHZ\nKm/Yjg9mrVnGlyK0QChiddD5zFySWz3/F5ZqXsxZN3UJJeV23QbNw5iGq+2uu1Gx\nGj0IOBLeBMlmak4bntK9CW8MRaV8NoTnqgieskA7ctS9TilgGNJzNZvbBzv3j7AM\n3kL0cTsvHXIcUw8OdutNfvlRpUGIn7W+1zfGjBdz7nLLyupwDGOipHJnQsYraEbX\nj1OiwLCZh9J3Tg64LNFS+3GXaF2IYnmd6P3ZYKw1bEIyLtRN0CdcLZDMg8BzuaLH\np9GC9lvyaNurAeCXzDZ2lv08fCccC5rKeR1NP0dD15gfR7yXZe7XpunhUQ==\n-----END CERTIFICATE-----\n";
    const TEST_KEY: &str = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCvQ9L8eFCZRLmH\nvc7Mqtv7Nn1m2WPChhhiJ41URLqFdHLKa5oc3JERpHpqzgG8NrnazSt3xhKo60U8\ntd0jrk6PnjLffFNtfwHACF/PHp/Q6NhNL/mUKIGAUIfTNYlzA6wodYT0/RnlOmN1\nFILF/Mnzv6uzyPRCuNFoRJZ5W3M+LmSuedGM7Ka7y6Fq1lyPTMAfkKYIHjHJBiF7\nYDG5o9Tzsjt58YTA0VCnVvb7+fuXBvJ7g3bA1FwTJMy2wnyJ7usS8jYmnoDTauPJ\npL7Y1CFolFH4gU0JKmVOZX5kBEM7JQVqKkrrnFX69+vtqqDAl27sLgPzeJo24D6A\n7xu7GguJAgMBAAECggEAFVGa865f4XDYX4BRTBh5ZyqG4PCO/62ngCL/ADHW/V4/\ni0tA5QNYWwzGfkDeOapve4Oq5qgPg4AQvTSC+HDeqf4Mgp5BGKfTCuyJ2OwI9RSp\noOP1yBWQQQ8qomCX/kdDVO2MlW9HC9jJGcf7q0EXQKC/LkCCo64O/M+g/RSIZVb0\nN68Fi/oHfpp1VyGa6JkD/dMiJuMXdW3bDgZBUmWqyipoK97cutecXPGhp8X2J9hf\n5kfYkWfuuUrX5y+9hAcaD6JxsI+tA6gsbJvI7xS6Ie5TCLGMs73w7Q49Wn5W/qzU\n2HE7Rd5qhrrINekh0gqm1XX8LQisYRbNYRTXq9PdQQKBgQDgH8RY8zB+93QEDdCJ\ncBfYrgW3XYKC1DHNN0YHBtL/tUt+MgZ38rQdYChckUTrtoGKv6eNiZLU8InusCAA\nRBq0wBuDkEs+bkRJZcTq7cGOnJm1krIi3a+I9Myge1dlhA/4KljCz/T9IVr8OBJ5\nQD4scEW7k1GjRRN385aqB+BGqQKBgQDIMR9r/v5+mOsdBO/8flZGan9xyOhHYcez\nemNTeDeZD4JrGAUbWI9fdt7g5Iqwz7+5Kx21S+OJKsqtiKIX9TyR4yoFfu1J8nfC\nUnZPUXwr5n97Myv3wB7HOC+T88fA3msv8GQ8HdC2ZlUDJdgBHsn/b4aCUtiWLa1z\nMo/S2IAJ4QKBgAbk80VJNdSyB/+X7TJNIG6p68MYPUuI+380lBLjQtpa2Veockp+\nTMwaiSNP1K7rjlCWVLEl6j5ip9uPz2wyrB+jSTVi2u2wtqkLWGNhrPKWHqRXPuOT\nrjKoVSMaqDWXOmaH5vMXMpIW1JWto+PW9hKn4X1Dqt864L5v39KbK2sBAoGAMAZo\nzVWs4933eUy37dC5Dcd6r2dNIeK5L7tKnLmYTOXFmb93aioCqxovObBZ/TS5f8hy\nJg4AleVoHd1LVYgFcdIXQJ5EeprqU/nIXBrmOPng10NdZt/2AkDeWRYAc6pn+GYp\nBar5aOh/uHOZsBscxmSQ1i7duplWpO4aRrCddsECgYEArF5Fl5gK0ihTK7zfbNRL\nYE+olUaq0ZrYV3a66a14KQB1zMRCdYHXl9/4KehU6HDnxCZFw/Iz+y0X5wyy93ma\nMg7uBxF9bMWEvrQt1VFMGLIAkJbcVFn6uoGMoGkp9iPGHJfDSO5FwXjuVj7xfAiP\n1lODMcR6hfELDkVFY9Vx28M=\n-----END PRIVATE KEY-----\n";
}
