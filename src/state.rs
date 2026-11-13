//! Focus Island · 状态模型与持久化
//!
//! 所有时长均使用整秒；运行中的剩余时间由前端管理，不随偏好变更写回配置。

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// 两位小时输入可表示的最长倒计时：99:59:59。
pub const MAX_DURATION_SEC: u64 = 99 * 3600 + 59 * 60 + 59;
/// 屏幕顶部间距使用逻辑像素；应用定位时再换算为设备像素。
pub const DEFAULT_TOP_OFFSET: u32 = 20;
pub const MAX_TOP_OFFSET: u32 = 1000;
const MAX_TASK_NAME_CHARS: usize = 120;
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

fn unique_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "t{:x}-{:x}-{:x}",
        std::process::id(),
        timestamp,
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn task_name(name: &str) -> String {
    let name: String = name
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_TASK_NAME_CHARS)
        .collect();
    let name = name.trim();
    if name.is_empty() {
        "未命名任务".into()
    } else {
        name.into()
    }
}

/// An opt-in action saved with a task, never an execution log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionKind { Command, Shell, Lock, Sleep, Shutdown, Restart }

impl ActionKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Command => "运行 PowerShell 命令", Self::Shell => "运行 macOS Shell 命令",
            Self::Lock => "锁定屏幕",
            Self::Sleep => "睡眠", Self::Shutdown => "关机", Self::Restart => "重启",
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionAction {
    pub enabled: bool,
    pub kind: ActionKind,
    pub command: String,
    pub delay_sec: u64,
}

impl std::fmt::Debug for CompletionAction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CompletionAction").field("enabled", &self.enabled)
            .field("kind", &self.kind).field("command", &"<redacted>")
            .field("delay_sec", &self.delay_sec).finish()
    }
}

impl Default for CompletionAction {
    fn default() -> Self {
        let kind = if cfg!(target_os = "macos") { ActionKind::Shell } else { ActionKind::Command };
        Self { enabled: false, kind, command: String::new(), delay_sec: 10 }
    }
}

impl<'de> Deserialize<'de> for CompletionAction {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(default, rename_all = "camelCase")]
        struct Fields { enabled: bool, kind: String, command: String, delay_sec: u64 }
        impl Default for Fields {
            fn default() -> Self {
                Self { enabled: false, kind: "command".into(), command: String::new(), delay_sec: 10 }
            }
        }
        let fields = Fields::deserialize(deserializer)?;
        let kind = match fields.kind.as_str() {
            "command" => Some(ActionKind::Command), "shell" => Some(ActionKind::Shell),
            "lock" => Some(ActionKind::Lock),
            "sleep" => Some(ActionKind::Sleep), "shutdown" => Some(ActionKind::Shutdown),
            "restart" => Some(ActionKind::Restart), _ => None,
        };
        Ok(Self { enabled: fields.enabled && kind.is_some(), kind: kind.unwrap_or(ActionKind::Command),
            command: fields.command, delay_sec: fields.delay_sec })
    }
}

impl CompletionAction {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.delay_sec > 300 { return Err("延迟须为 0–300 秒"); }
        if self.command.contains('\0') { return Err("命令不能含空字符"); }
        if self.command.chars().count() > 4096 { return Err("命令不能超过 4096 个字符"); }
        if self.enabled && matches!(self.kind, ActionKind::Command | ActionKind::Shell) && self.command.trim().is_empty() {
            return Err("请先填写要执行的命令");
        }
        Ok(())
    }

    fn normalize(&mut self) {
        if self.validate().is_err() {
            self.enabled = false;
            self.delay_sec = self.delay_sec.min(300);
            if self.command.contains('\0') || self.command.chars().count() > 4096 {
                self.command.clear();
            }
        }
    }
}

/// 单个倒计时任务。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub name: String,
    /// 时长（秒），可精确到秒。
    pub sec: u64,
    #[serde(default, rename = "completionAction", alias = "completion_action")]
    pub completion_action: CompletionAction,
}

impl Task {
    /// Validate a new task and its action together before generating an ID.
    /// Loading old files still uses normalize(), preserving its compatibility rules.
    pub fn try_new(name: String, sec: u64, completion_action: CompletionAction) -> Result<Self, String> {
        if name.trim().is_empty() { return Err("请填写任务名称".into()); }
        if name.chars().any(char::is_control) { return Err("任务名称不能含控制字符".into()); }
        if name.trim().chars().count() > MAX_TASK_NAME_CHARS {
            return Err(format!("任务名称不能超过 {} 个字符", MAX_TASK_NAME_CHARS));
        }
        if !(1..=MAX_DURATION_SEC).contains(&sec) { return Err("任务时长须为 1 秒至 99:59:59".into()); }
        completion_action.validate().map_err(str::to_string)?;
        let mut task = Self::new(name, sec);
        task.completion_action = completion_action;
        Ok(task)
    }

    /// 时间戳与进程内序号组合，避免快速连续新增任务时发生 ID 冲突。
    pub fn new(name: String, sec: u64) -> Self {
        Self {
            id: unique_id(),
            name: task_name(&name),
            sec: sec.clamp(1, MAX_DURATION_SEC),
            completion_action: CompletionAction::default(),
        }
    }

    /// 生成人类可读的时长文案。
    #[allow(dead_code)]
    pub fn duration_label(&self) -> String {
        let h = self.sec / 3600;
        let m = (self.sec % 3600) / 60;
        let s = self.sec % 60;
        match (h, m, s) {
            (0, 0, _) => format!("{} 秒", s),
            (0, _, 0) => format!("{} 分钟", m),
            (0, _, _) => format!("{} 分 {} 秒", m, s),
            (_, 0, 0) => format!("{} 小时", h),
            (_, _, 0) => format!("{} 小时 {} 分", h, m),
            _ => format!("{} 小时 {} 分 {} 秒", h, m, s),
        }
    }
}

/// 此字段独立容错，避免一项显示偏好损坏导致整份任务配置回退。
/// 仅接受数值整值；负数/过大值截到边界，其余类型和小数使用默认值。
fn deserialize_top_offset<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value.as_f64()
        .filter(|value| value.is_finite() && value.fract() == 0.0)
        .map(|value| value.clamp(0.0, f64::from(MAX_TOP_OFFSET)) as u32)
        .unwrap_or(DEFAULT_TOP_OFFSET))
}

/// 显示与提醒偏好。IPC 使用 camelCase，旧版磁盘文件的 snake_case 仍可读。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    #[serde(alias = "show_hands")]
    pub show_hands: bool,
    #[serde(alias = "show_second")]
    pub show_second: bool,
    #[serde(alias = "show_idle_eyes")]
    pub show_idle_eyes: bool,
    #[serde(alias = "show_idle_clock")]
    pub show_idle_clock: bool,
    pub sound: bool,
    pub notify: bool,
    #[serde(alias = "always_on_top")]
    pub always_on_top: bool,
    #[serde(alias = "reduce_motion")]
    pub reduce_motion: bool,
    #[serde(alias = "top_offset", deserialize_with = "deserialize_top_offset")]
    pub top_offset: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            show_hands: true,
            show_second: true,
            show_idle_eyes: false,
            show_idle_clock: true,
            sound: true,
            notify: false,
            always_on_top: true,
            reduce_motion: false,
            top_offset: DEFAULT_TOP_OFFSET,
        }
    }
}

impl Settings {
    /// 也保护 Rust 直接构造的设置；反序列化入口已处理类型与负值。
    pub fn normalize_top_offset(&mut self) {
        self.top_offset = self.top_offset.min(MAX_TOP_OFFSET);
    }
}

/// Phone preferences are independent of timer tasks. No notification content is saved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneSettings {
    pub enabled: bool,
    pub display_seconds: u64,
    pub hide_content: bool,
    pub device_address: String,
    pub device_name: String,
}
impl Default for PhoneSettings {
    fn default() -> Self {
        Self { enabled: false, display_seconds: 8, hide_content: false,
            device_address: String::new(), device_name: String::new() }
    }
}
impl PhoneSettings {
    pub fn normalize(&mut self) {
        self.display_seconds = self.display_seconds.clamp(3, 30);
        self.device_address = self.device_address.parse::<u64>().ok()
            .filter(|value| *value > 0 && *value <= 0xffff_ffff_ffff)
            .map(|value| value.to_string()).unwrap_or_default();
        self.device_name = self.device_name.chars().filter(|c| !c.is_control()).take(80).collect();
        if self.device_address.is_empty() { self.device_name.clear(); }
    }
}
// A malformed phone preference must never discard the user's tasks or actions.
impl<'de> Deserialize<'de> for PhoneSettings {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let mut settings = Self::default();
        if let Some(object) = value.as_object() {
            settings.enabled = object.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
            settings.display_seconds = object.get("displaySeconds").and_then(|v| v.as_u64()).unwrap_or(8);
            settings.hide_content = object.get("hideContent").and_then(|v| v.as_bool()).unwrap_or(false);
            settings.device_address = object.get("deviceAddress").and_then(|v| v.as_str()).unwrap_or("").into();
            settings.device_name = object.get("deviceName").and_then(|v| v.as_str()).unwrap_or("").into();
        }
        settings.normalize();
        Ok(settings)
    }
}
/// Independent presentation preferences shared by every notification source.
/// Notification content remains in memory and is never part of AppState.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    pub enabled: bool,
    pub display_seconds: u64,
    pub list_limit: u64,
}
impl Default for NotificationSettings {
    fn default() -> Self { Self { enabled: true, display_seconds: 5, list_limit: 5 } }
}
impl NotificationSettings {
    pub fn normalize(&mut self) {
        self.display_seconds = self.display_seconds.clamp(1, 30);
        self.list_limit = self.list_limit.clamp(1, 10);
    }
}
// Tolerant disk loading is separate from strict configuration IPC validation.
impl<'de> Deserialize<'de> for NotificationSettings {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let mut settings = Self::default();
        if let Some(object) = value.as_object() {
            settings.enabled = object.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
            settings.display_seconds = object.get("displaySeconds").and_then(|v| v.as_u64()).unwrap_or(5);
            settings.list_limit = object.get("listLimit").and_then(|v| v.as_u64()).unwrap_or(5);
        }
        settings.normalize();
        Ok(settings)
    }
}

/// Listener preferences only; credentials and payloads must never reach diagnostics.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct WebhookSettings {
    pub enabled: bool,
    pub scope: String,
    pub port: u16,
    #[serde(rename = "publicBaseUrl")]
    pub public_base_url: String,
    pub token: String,
}

impl Default for WebhookSettings {
    fn default() -> Self {
        Self { enabled: false, scope: "local".into(), port: 17891, public_base_url: String::new(), token: String::new() }
    }
}

impl std::fmt::Debug for WebhookSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebhookSettings").field("enabled", &self.enabled)
            .field("scope", &self.scope).field("port", &self.port)
            .field("public_base_url", &self.public_base_url).field("token", &"<redacted>").finish()
    }
}

/// Parse a user-supplied HTTPS origin; credentials, path prefixes and query data
/// are never accepted as a public endpoint base. Empty input disables this hint.
pub fn normalized_public_base_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() { return Some(String::new()); }
    if value.len() > 2048 || value.chars().any(char::is_control)
        || value.contains(['\\', '?', '#']) || !value.get(..8)?.eq_ignore_ascii_case("https://") {
        return None;
    }
    let authority = value.get(8..)?.strip_suffix('/').unwrap_or(&value[8..]);
    if authority.is_empty() || authority.contains(['/', '@']) || authority.ends_with(':') { return None; }
    let parsed = url::Url::parse(value).ok()?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some()
        || parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() || parsed.port() == Some(0) {
        return None;
    }
    match parsed.host()? {
        url::Host::Domain(domain) => {
            let domain = domain.strip_suffix('.').unwrap_or(domain);
            if domain.is_empty() || domain.len() > 253 || domain.split('.').any(|label|
                label.is_empty() || label.len() > 63 || label.starts_with('-') || label.ends_with('-')
                    || !label.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')) {
                return None;
            }
        }
        url::Host::Ipv4(_) | url::Host::Ipv6(_) => {}
    }
    Some(parsed.origin().ascii_serialization())
}

impl WebhookSettings {
    pub fn has_valid_token(&self) -> bool {
        self.token.len() == 64 && self.token.bytes().all(|byte| byte.is_ascii_hexdigit())
    }

    pub fn normalize(&mut self) {
        if !matches!(self.scope.as_str(), "local" | "lan") { self.scope = "local".into(); }
        if self.port < 1024 { self.port = 17891; }
        self.public_base_url = normalized_public_base_url(&self.public_base_url).unwrap_or_default();
        if !self.has_valid_token() {
            self.enabled = false;
            self.token.clear();
        }
    }
}

// The disk format is deliberately tolerant; explicit configuration is validated separately.
// Loading an older or damaged profile never creates a credential or opens an unauthenticated port.
impl<'de> Deserialize<'de> for WebhookSettings {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let mut settings = Self::default();
        if let Some(object) = value.as_object() {
            settings.enabled = object.get("enabled").and_then(|value| value.as_bool()).unwrap_or(false);
            settings.scope = object.get("scope").and_then(|value| value.as_str()).unwrap_or("local").into();
            settings.port = object.get("port").and_then(|value| value.as_u64())
                .and_then(|value| u16::try_from(value).ok()).filter(|value| *value >= 1024).unwrap_or(17891);
            settings.public_base_url = object.get("publicBaseUrl").and_then(|value| value.as_str()).unwrap_or("").into();
            settings.token = object.get("token").and_then(|value| value.as_str()).unwrap_or("").into();
        }
        settings.normalize();
        Ok(settings)
    }
}


/// Outbound server connection. Never serialize this key into a UI broadcast.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelaySettings {
    pub enabled: bool,
    pub service_url: String,
    pub connection_key: String,
}
impl Default for RelaySettings {
    fn default() -> Self { Self { enabled: false, service_url: String::new(), connection_key: String::new() } }
}
impl std::fmt::Debug for RelaySettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelaySettings").field("enabled", &self.enabled)
            .field("service_url", &self.service_url).field("connection_key", &"<redacted>").finish()
    }
}
impl RelaySettings {
    pub fn has_valid_key(&self) -> bool {
        self.connection_key.len() == 64 && self.connection_key.bytes().all(|b| b.is_ascii_hexdigit())
    }
    pub fn validate(&self) -> Result<(), String> {
        if normalized_public_base_url(&self.service_url).as_deref() != Some(self.service_url.as_str()) {
            return Err("服务地址须为有效 HTTPS 域名地址，不能带路径、账号或查询参数".into());
        }
        if (!self.connection_key.is_empty() && !self.has_valid_key())
            || (self.enabled && (!self.has_valid_key() || self.service_url.is_empty())) {
            return Err("开启服务器连接需填写 HTTPS 服务地址和 64 位连接密钥".into());
        }
        Ok(())
    }
    pub fn normalize(&mut self) {
        self.service_url = normalized_public_base_url(&self.service_url).unwrap_or_default();
        if !self.has_valid_key() { self.connection_key.clear(); }
        if self.service_url.is_empty() || self.connection_key.is_empty() { self.enabled = false; }
    }
}
impl<'de> Deserialize<'de> for RelaySettings {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let mut settings = Self::default();
        if let Some(object) = value.as_object() {
            settings.enabled = object.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
            settings.service_url = object.get("serviceUrl").and_then(|v| v.as_str()).unwrap_or("").into();
            settings.connection_key = object.get("connectionKey").and_then(|v| v.as_str()).unwrap_or("").into();
        }
        settings.normalize();
        Ok(settings)
    }
}

/// 应用持久化状态。新增字段缺失时使用默认值，保留已有用户数据。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppState {
    pub tasks: Vec<Task>,
    pub current_id: String,
    /// 当前配置的倒计时时长（秒），可以与所选任务的原始时长不同。
    pub duration_sec: u64,
    pub settings: Settings,
    pub phone: PhoneSettings,
    pub notifications: NotificationSettings,
    pub webhook: WebhookSettings,
    pub relay: RelaySettings,
}

impl Default for AppState {
    fn default() -> Self {
        let tasks = vec![
            Task { id: "t1".into(), name: "深度工作".into(), sec: 25 * 60, completion_action: CompletionAction::default() },
            Task { id: "t2".into(), name: "阅读论文".into(), sec: 45 * 60, completion_action: CompletionAction::default() },
            Task { id: "t3".into(), name: "代码评审".into(), sec: 15 * 60, completion_action: CompletionAction::default() },
        ];
        Self {
            current_id: tasks[0].id.clone(),
            duration_sec: tasks[0].sec,
            tasks,
            settings: Settings::default(),
            phone: PhoneSettings::default(),
            notifications: NotificationSettings::default(),
            webhook: WebhookSettings::default(),
            relay: RelaySettings::default(),
        }
    }
}

impl AppState {
    /// 当前选中的任务（若已被删除则回退到首个任务）。
    pub fn current_task(&self) -> Option<&Task> {
        self.tasks
            .iter()
            .find(|t| t.id == self.current_id)
            .or_else(|| self.tasks.first())
    }

    /// 修复磁盘或 IPC 数据中的无效值，保留有效的秒数和显式清空的任务列表。
    pub fn normalize(&mut self) {
        let mut ids = HashSet::new();
        for task in &mut self.tasks {
            if task.id.trim().is_empty() || !ids.insert(task.id.clone()) {
                loop {
                    task.id = unique_id();
                    if ids.insert(task.id.clone()) {
                        break;
                    }
                }
            }
            task.name = task_name(&task.name);
            task.sec = task.sec.clamp(1, MAX_DURATION_SEC);
            task.completion_action.normalize();
        }
        self.current_id = self.current_task().map(|task| task.id.clone()).unwrap_or_default();
        self.duration_sec = self.duration_sec.clamp(1, MAX_DURATION_SEC);
        self.settings.normalize_top_offset();
        self.phone.normalize();
        self.notifications.normalize();
        self.webhook.normalize();
        self.relay.normalize();
    }

    /// 载入状态；文件缺失时初始化，损坏或读取失败时记录原因并使用默认状态。
    pub fn load(path: &Path) -> Self {
        let raw = match std::fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Self::default(),
            Err(err) => {
                crate::log(&format!("无法读取状态 {}: {}", path.display(), err));
                return Self::default();
            }
        };
        let mut state: Self = match serde_json::from_str(&raw) {
            Ok(state) => state,
            Err(err) => {
                crate::log(&format!("状态文件无效 {}: {}", path.display(), err));
                return Self::default();
            }
        };
        state.normalize();
        state
    }

    /// 先写同目录临时文件并刷新，再替换目标，避免写入中断截断现有状态。
    /// 失败保留内存状态及原有文件，并输出可诊断的路径和错误。
    pub fn save(&self, path: &Path) {
        if let Err(err) = self.save_to_path(path) {
            crate::log(&format!("无法保存状态 {}: {}", path.display(), err));
        }
    }

    pub(crate) fn save_to_path(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent().filter(|dir| !dir.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)?;
        }
        let mut normalized = self.clone();
        normalized.normalize();
        let raw = serde_json::to_vec_pretty(&normalized).map_err(io::Error::other)?;
        let temp = path.with_extension(format!("{}.tmp", unique_id()));
        let result = (|| {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            file.write_all(&raw)?;
            file.sync_all()?;
            drop(file);
            // Windows 的 std::fs::rename 使用 MOVEFILE_REPLACE_EXISTING。
            std::fs::rename(&temp, path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TestFile(PathBuf);

    impl TestFile {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("focus-island-{}", unique_id()));
            std::fs::create_dir(&dir).unwrap();
            Self(dir.join("state.json"))
        }
    }

    impl Drop for TestFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
            let _ = std::fs::remove_dir(self.0.parent().unwrap());
        }
    }

    #[test]
    fn webhook_legacy_and_damaged_preferences_preserve_tasks_and_remain_disabled() {
        let original = AppState::default();
        let original_json = serde_json::to_value(&original).unwrap();
        assert_eq!(original_json["webhook"],
            serde_json::json!({"enabled":false,"scope":"local","port":17891,"publicBaseUrl":"","token":""}));
        let mut legacy = original_json.clone();
        legacy.as_object_mut().unwrap().remove("webhook");
        assert_eq!(serde_json::from_value::<AppState>(legacy).unwrap().webhook, WebhookSettings::default());
        for value in [serde_json::json!(null), serde_json::json!(false), serde_json::json!([]),
            serde_json::json!("corrupt"),
            serde_json::json!({"enabled":"true","scope":[],"port":-1,"token":{}}),
            serde_json::json!({"enabled":true,"scope":"unknown","port":65536,"token":null})] {
            let mut damaged = original_json.clone();
            damaged["webhook"] = value;
            let loaded: AppState = serde_json::from_value(damaged).unwrap();
            assert_eq!(loaded.webhook, WebhookSettings::default());
            assert_eq!(serde_json::to_value(loaded).unwrap(), original_json);
        }
    }

    #[test]
    fn webhook_invalid_credentials_cannot_enable_listener_or_discard_saved_task() {
        let file = TestFile::new();
        let original = serde_json::json!({
            "tasks":[{"id":"kept","name":"Kept task","sec":7,
                "completionAction":{"enabled":true,"kind":"lock","delaySec":3}}],
            "current_id":"kept","duration_sec":11,
            "settings":{"sound":false,"reduceMotion":true}
        });
        for token in [String::new(), "a".repeat(63), "a".repeat(65), "g".repeat(64),
            "\u{00e9}".repeat(32), format!("{} ", "a".repeat(63)),
            format!("{}\n", "a".repeat(63))] {
            let mut value = original.clone();
            value["webhook"] = serde_json::json!({"enabled":true,"scope":"lan","port":17892,"token":token});
            let raw = serde_json::to_vec(&value).unwrap();
            std::fs::write(&file.0, &raw).unwrap();
            let loaded = AppState::load(&file.0);
            assert!(!loaded.webhook.enabled);
            assert!(loaded.webhook.token.is_empty());
            assert_eq!(loaded.webhook.scope, "lan");
            assert_eq!(loaded.webhook.port, 17892);
            assert_eq!(loaded.tasks.len(), 1);
            assert_eq!(loaded.tasks[0].id, "kept");
            assert_eq!(loaded.tasks[0].sec, 7);
            assert!(loaded.tasks[0].completion_action.enabled);
            assert_eq!(loaded.tasks[0].completion_action.kind, ActionKind::Lock);
            assert_eq!(loaded.current_id, "kept");
            assert_eq!(loaded.duration_sec, 11);
            assert!(!loaded.settings.sound);
            assert_eq!(std::fs::read(&file.0).unwrap(), raw, "load must not rewrite or mint credentials");
        }
    }

    #[test]
    fn webhook_credentials_persist_exactly_but_never_appear_in_debug() {
        let file = TestFile::new();
        let mut state = AppState::default();
        let token = "aB0123456789cDeF".repeat(4);
        state.webhook = WebhookSettings { enabled: true, scope: "lan".into(), port: 17892, public_base_url: "https://notify.example.com".into(), token: token.clone() };
        assert!(state.webhook.has_valid_token());
        state.save_to_path(&file.0).unwrap();
        let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&file.0).unwrap()).unwrap();
        assert_eq!(saved["webhook"]["token"], token);
        assert_eq!(AppState::load(&file.0).webhook, state.webhook);
        for debug in [format!("{:?}", state.webhook), format!("{:#?}", state)] {
            assert!(!debug.contains(&token));
            assert!(debug.contains("<redacted>"));
        }
        state.webhook.enabled = false;
        state.save_to_path(&file.0).unwrap();
        assert_eq!(AppState::load(&file.0).webhook.token, token, "disabling keeps a valid credential until explicit rotation");
    }

    #[test]
    fn webhook_public_url_accepts_only_https_origins_and_clears_damage() {
        for (input, expected) in [
            ("", ""), ("   ", ""), ("https://notify.example.com", "https://notify.example.com"),
            ("HTTPS://Notify.Example.COM:443/", "https://notify.example.com"),
            ("https://notify.example.com:8443/", "https://notify.example.com:8443"),
            ("https://192.0.2.5/", "https://192.0.2.5"),
            ("https://[2001:db8::1]:8443/", "https://[2001:db8::1]:8443"),
        ] {
            assert_eq!(normalized_public_base_url(input).as_deref(), Some(expected));
        }
        let token = "f".repeat(64);
        for input in [
            "http://notify.example.com", "https://", "https://user@notify.example.com",
            "https://@notify.example.com", "https://user:password@notify.example.com",
            "https://notify.example.com/api", "https://notify.example.com/.",
            "https://notify.example.com//", "https://notify.example.com?secret",
            "https://notify.example.com/#", "https://notify.example.com\\",
            "https://notify.example.com:", "https://notify.example.com:0",
            "https://notify.example.com:65536", "https://bad..example.com",
            "https://-bad.example.com", "https://bad_host.example.com", "https://noti\nfy.example.com",
        ] {
            assert!(normalized_public_base_url(input).is_none(), "accepted invalid public origin: {input:?}");
            let loaded: WebhookSettings = serde_json::from_value(serde_json::json!({
                "enabled":true,"scope":"lan","port":17892,"publicBaseUrl":input,"token":token
            })).unwrap();
            assert!(loaded.enabled, "public URL damage must not change the local listener");
            assert!(loaded.public_base_url.is_empty());
            assert_eq!(loaded.scope, "lan");
            assert_eq!(loaded.port, 17892);
            assert_eq!(loaded.token, token);
        }
        let loaded: WebhookSettings = serde_json::from_value(serde_json::json!({
            "publicBaseUrl":{},"enabled":true,"token":token
        })).unwrap();
        assert!(loaded.public_base_url.is_empty());
        assert!(loaded.enabled);
    }

    #[test]
    fn webhook_normalization_limits_scope_and_port_without_inventing_a_token() {
        let token = "f".repeat(64);
        for port in [serde_json::json!(0), serde_json::json!(1), serde_json::json!(1023), serde_json::json!(-1), serde_json::json!(65536),
            serde_json::json!(1.25), serde_json::json!("17891"), serde_json::json!(null)] {
            let loaded: WebhookSettings = serde_json::from_value(serde_json::json!({
                "enabled":true,"scope":"unrecognized","port":port,"token":token
            })).unwrap();
            assert!(loaded.enabled);
            assert_eq!(loaded.scope, "local");
            assert_eq!(loaded.port, 17891);
            assert_eq!(loaded.token, token);
        }
        let mut state = AppState::default();
        state.webhook = WebhookSettings { enabled:true, scope:"all".into(), port:0, token, ..WebhookSettings::default() };
        state.normalize();
        assert!(state.webhook.enabled);
        assert_eq!(state.webhook.scope, "local");
        assert_eq!(state.webhook.port, 17891);
        state.webhook.token.clear();
        state.normalize();
        assert!(!state.webhook.enabled);
        assert!(state.webhook.token.is_empty());
    }

    #[test]
    fn notification_preferences_default_and_tolerate_damage_without_losing_tasks() {
        let original = AppState::default();
        let original_json = serde_json::to_value(&original).unwrap();
        assert_eq!(original_json["notifications"],
            serde_json::json!({"enabled":true,"displaySeconds":5,"listLimit":5}));
        let mut legacy = original_json.clone();
        legacy.as_object_mut().unwrap().remove("notifications");
        assert_eq!(serde_json::from_value::<AppState>(legacy).unwrap().notifications,
            NotificationSettings::default());
        for value in [serde_json::json!(null), serde_json::json!(false), serde_json::json!([]),
            serde_json::json!({"enabled":"true","displaySeconds":"5","listLimit":-1}),
            serde_json::json!({"enabled":null,"displaySeconds":2.5,"listLimit":{}})] {
            let mut damaged = original_json.clone();
            damaged["notifications"] = value;
            let loaded: AppState = serde_json::from_value(damaged).unwrap();
            assert_eq!(loaded.notifications, NotificationSettings::default());
            assert_eq!(serde_json::to_value(loaded).unwrap(), original_json);
        }
        let settings: NotificationSettings = serde_json::from_value(serde_json::json!({
            "enabled":false,"displaySeconds":99,"listLimit":0})).unwrap();
        assert!(!settings.enabled);
        assert_eq!(settings.display_seconds, 30);
        assert_eq!(settings.list_limit, 1);
    }

    #[test]
    fn legacy_file_without_top_offset_keeps_tasks_and_defaults_to_twenty() {
        let file = TestFile::new();
        std::fs::write(&file.0,
            r#"{"tasks":[{"id":"kept","name":"原有任务","sec":7}],"current_id":"kept","duration_sec":11,"settings":{"sound":false,"reduceMotion":true}}"#,
        ).unwrap();
        let loaded = AppState::load(&file.0);
        assert_eq!(Settings::default().top_offset, 20);
        assert_eq!(serde_json::from_str::<Settings>("{}").unwrap().top_offset, 20);
        assert_eq!(loaded.settings.top_offset, 20);
        assert_eq!(loaded.tasks.len(), 1);
        assert_eq!(loaded.tasks[0].name, "原有任务");
        assert_eq!(loaded.tasks[0].sec, 7);
        assert_eq!(loaded.current_id, "kept");
        assert_eq!(loaded.duration_sec, 11);
        assert!(!loaded.settings.sound);
        assert!(loaded.settings.reduce_motion);
    }

    #[test]
    fn top_offset_roundtrips_frontend_key_alias_and_normalized_boundaries() {
        let file = TestFile::new();
        let mut state = AppState::default();
        for offset in [0, 20, 384, 1000] {
            state.settings = serde_json::from_value(
                serde_json::json!({"topOffset": offset}),
            ).unwrap();
            assert_eq!(state.settings.top_offset, offset);
            state.save_to_path(&file.0).unwrap();
            let saved: serde_json::Value = serde_json::from_slice(
                &std::fs::read(&file.0).unwrap(),
            ).unwrap();
            assert_eq!(saved["settings"]["topOffset"], offset);
            assert!(saved["settings"].get("top_offset").is_none());
            assert_eq!(AppState::load(&file.0).settings.top_offset, offset);
        }
        let legacy: Settings = serde_json::from_str(r#"{"top_offset":42}"#).unwrap();
        assert_eq!(legacy.top_offset, 42);
        state.settings.top_offset = u32::MAX;
        state.save_to_path(&file.0).unwrap();
        assert_eq!(AppState::load(&file.0).settings.top_offset, MAX_TOP_OFFSET);
        state.settings.normalize_top_offset();
        assert_eq!(state.settings.top_offset, MAX_TOP_OFFSET);
    }

    #[test]
    fn invalid_top_offsets_never_discard_tasks_or_other_preferences() {
        let file = TestFile::new();
        for (raw, expected) in [
            ("null", 20), ("true", 20), (r#""40""#, 20), ("{}", 20), ("[]", 20),
            ("3.5", 20), ("-3.5", 20), ("1000.5", 20),
            ("-1", 0), ("-9223372036854775808", 0), ("-1e300", 0),
            ("1001", 1000), ("18446744073709551615", 1000), ("1e300", 1000),
            ("20.0", 20), ("0", 0), ("1e3", 1000),
        ] {
            let mut value = serde_json::json!({
                "tasks":[{"id":"kept","name":"保留任务","sec":7}],
                "current_id":"kept", "duration_sec":11,
                "settings":{"sound":false, "showHands":false, "reduceMotion":true},
            });
            value["settings"]["topOffset"] = serde_json::from_str(raw).unwrap();
            std::fs::write(&file.0, serde_json::to_vec(&value).unwrap()).unwrap();
            let loaded = AppState::load(&file.0);
            assert_eq!(loaded.settings.top_offset, expected, "topOffset={raw}");
            assert_eq!(loaded.tasks.len(), 1, "topOffset={raw}");
            assert_eq!(loaded.tasks[0].name, "保留任务");
            assert_eq!(loaded.tasks[0].sec, 7);
            assert_eq!(loaded.current_id, "kept");
            assert_eq!(loaded.duration_sec, 11);
            assert!(!loaded.settings.sound);
            assert!(!loaded.settings.show_hands);
            assert!(loaded.settings.reduce_motion);
        }
    }

    #[test]
    fn idle_display_defaults_to_clock_without_eyes() {
        assert!(!Settings::default().show_idle_eyes);
        assert!(!AppState::default().settings.show_idle_eyes);
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert!(!settings.show_idle_eyes);
        assert!(settings.show_idle_clock);
        assert!(Settings::default().show_idle_clock);
    }

    #[test]
    fn legacy_file_without_idle_display_fields_preserves_state_and_preferences() {
        let file = TestFile::new();
        std::fs::write(&file.0,
            r#"{"tasks":[{"id":"custom","name":"喝水","sec":7}],"current_id":"custom","duration_sec":11,"settings":{"showHands":false,"showSecond":false,"sound":false,"notify":true,"alwaysOnTop":false,"reduceMotion":true}}"#,
        ).unwrap();
        let state = AppState::load(&file.0);
        assert!(!state.settings.show_idle_eyes);
        assert!(state.settings.show_idle_clock);
        assert!(!state.settings.show_hands);
        assert!(!state.settings.show_second);
        assert!(!state.settings.sound);
        assert!(state.settings.notify);
        assert!(!state.settings.always_on_top);
        assert!(state.settings.reduce_motion);
        assert_eq!(state.current_id, "custom");
        assert_eq!(state.tasks[0].sec, 7);
        assert_eq!(state.duration_sec, 11);
    }

    #[test]
    fn idle_display_roundtrips_both_values_with_frontend_keys() {
        let file = TestFile::new();
        let mut state = AppState::default();
        for enabled in [true, false] {
            // Exercise the same Settings deserialization used by updateSettings IPC.
            state.settings = serde_json::from_value(
                serde_json::json!({"showIdleEyes": enabled, "showIdleClock": !enabled}),
            ).unwrap();
            assert_eq!(state.settings.show_idle_eyes, enabled);
            assert_eq!(state.settings.show_idle_clock, !enabled);
            state.save_to_path(&file.0).unwrap();
            let saved: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(&file.0).unwrap(),
            ).unwrap();
            assert_eq!(saved["settings"]["showIdleEyes"], enabled);
            assert_eq!(saved["settings"]["showIdleClock"], !enabled);
            assert!(saved["settings"].get("show_idle_eyes").is_none());
            assert!(saved["settings"].get("show_idle_clock").is_none());
            let restored = AppState::load(&file.0);
            assert_eq!(restored.settings.show_idle_eyes, enabled);
            assert_eq!(restored.settings.show_idle_clock, !enabled);
        }
        let legacy: Settings = serde_json::from_str(r#"{"show_idle_eyes":true,"show_idle_clock":false}"#).unwrap();
        assert!(legacy.show_idle_eyes);
        assert!(!legacy.show_idle_clock);
    }

    #[test]
    fn preferences_use_frontend_keys_and_accept_legacy_files() {
        let settings: Settings = serde_json::from_str(
            r#"{"show_hands":false,"show_second":false,"always_on_top":false,"reduce_motion":true}"#,
        )
        .unwrap();
        let value = serde_json::to_value(&settings).unwrap();
        assert_eq!(value["showHands"], false);
        assert_eq!(value["showSecond"], false);
        assert_eq!(value["alwaysOnTop"], false);
        assert_eq!(value["reduceMotion"], true);
        assert_eq!(value["sound"], true);
        assert!(value.get("show_hands").is_none());
        let restored: Settings = serde_json::from_value(value).unwrap();
        assert!(!restored.show_hands);
        assert!(restored.reduce_motion);
    }

    #[test]
    fn missing_preferences_do_not_discard_existing_tasks() {
        let mut state: AppState = serde_json::from_str(
            r#"{"tasks":[{"id":"custom","name":"喝水","sec":7}],"current_id":"custom","duration_sec":11}"#,
        )
        .unwrap();
        state.normalize();
        assert_eq!(state.tasks.len(), 1);
        assert_eq!(state.tasks[0].sec, 7);
        assert_eq!(state.duration_sec, 11);
        assert!(state.settings.show_hands);
    }

    #[test]
    fn normalize_repairs_ids_and_bounds_without_losing_seconds() {
        let mut state = AppState {
            tasks: vec![
                Task { id: "same".into(), name: " 第一项 ".into(), sec: 61, completion_action: CompletionAction::default() },
                Task { id: "same".into(), name: " ".into(), sec: 0, completion_action: CompletionAction::default() },
                Task { id: "".into(), name: "大时长".into(), sec: u64::MAX, completion_action: CompletionAction::default() },
            ],
            current_id: "deleted".into(),
            duration_sec: 3_661,
            ..AppState::default()
        };
        state.normalize();
        assert_eq!(state.current_id, "same");
        assert_eq!(state.duration_sec, 3_661);
        assert_eq!(state.tasks[0].sec, 61);
        assert_eq!(state.tasks[0].name, "第一项");
        assert_eq!(state.tasks[1].sec, 1);
        assert_eq!(state.tasks[1].name, "未命名任务");
        assert_eq!(state.tasks[2].sec, MAX_DURATION_SEC);
        let ids: HashSet<_> = state.tasks.iter().map(|task| &task.id).collect();
        assert_eq!(ids.len(), 3);
        assert!(!ids.iter().any(|id| id.is_empty()));
    }

    #[test]
    fn rapid_task_creation_has_distinct_ids() {
        let ids: HashSet<_> = (0..1_000)
            .map(|_| Task::new("短休息".into(), 7).id)
            .collect();
        assert_eq!(ids.len(), 1_000);
    }

    #[test]
    fn save_and_reload_keep_seconds_and_empty_task_lists() {
        let file = TestFile::new();
        let mut state = AppState::default();
        state.duration_sec = 61;
        state.tasks = vec![Task::new("喝水".into(), 7)];
        state.current_id = state.tasks[0].id.clone();
        state.settings.sound = false;
        state.save_to_path(&file.0).unwrap();
        let loaded = AppState::load(&file.0);
        assert_eq!(loaded.duration_sec, 61);
        assert_eq!(loaded.tasks[0].sec, 7);
        assert_eq!(loaded.current_id, state.current_id);
        assert!(!loaded.settings.sound);

        state.tasks.clear();
        state.duration_sec = 3;
        state.save_to_path(&file.0).unwrap();
        let loaded = AppState::load(&file.0);
        assert!(loaded.tasks.is_empty());
        assert!(loaded.current_id.is_empty());
        assert_eq!(loaded.duration_sec, 3);
        assert!(loaded.current_task().is_none());
        assert_eq!(std::fs::read_dir(file.0.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn invalid_file_falls_back_and_failed_save_leaves_original() {
        let file = TestFile::new();
        std::fs::write(&file.0, "{broken").unwrap();
        assert_eq!(AppState::load(&file.0).duration_sec, 1_500);

        // 以已有文件作为父目录，模拟无法写入；原有内容不得受影响。
        let blocked = file.0.join("nested.json");
        assert!(AppState::default().save_to_path(&blocked).is_err());
        assert_eq!(std::fs::read_to_string(&file.0).unwrap(), "{broken");
    }

    #[test]
    fn completion_actions_default_off_and_unknown_kind_preserves_tasks() {
        let mut state: AppState = serde_json::from_str(r#"{"tasks":[{"id":"a","name":"保留","sec":3,"completionAction":{"enabled":true,"kind":"futureAction"}},{"id":"b","name":"旧任务","sec":5}],"current_id":"a","duration_sec":3}"#).unwrap();
        state.normalize();
        assert_eq!(state.tasks.len(), 2);
        assert!(!state.tasks[0].completion_action.enabled);
        assert!(!state.tasks[1].completion_action.enabled);
        assert_eq!(state.tasks[1].completion_action.delay_sec, 10);
    }
    #[test]
    fn legacy_free_actions_are_ignored_without_losing_tasks_or_preferences() {
        let file = TestFile::new();
        for field in ["freeCompletionAction", "free_completion_action"] {
            for kind in ["shutdown", "command"] {
                let mut value = serde_json::json!({
                    "tasks":[{"id":"kept","name":"保留任务","sec":7,
                        "completionAction":{"enabled":true,"kind":"lock","delaySec":3}}],
                    "current_id":"kept","duration_sec":11,
                    "settings":{"sound":false,"reduceMotion":true}
                });
                value[field] = serde_json::json!({"enabled":true,"kind":kind,"command":"must never execute","delaySec":0});
                std::fs::write(&file.0, serde_json::to_vec(&value).unwrap()).unwrap();
                let state = AppState::load(&file.0);
                assert_eq!(state.tasks.len(), 1);
                assert_eq!(state.current_id, "kept");
                assert_eq!(state.duration_sec, 11);
                assert_eq!(state.tasks[0].name, "保留任务");
                assert!(state.tasks[0].completion_action.enabled);
                assert_eq!(state.tasks[0].completion_action.kind, ActionKind::Lock);
                assert!(!state.settings.sound);
                assert!(state.settings.reduce_motion);
                state.save_to_path(&file.0).unwrap();
                let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&file.0).unwrap()).unwrap();
                assert!(saved.get("freeCompletionAction").is_none());
                assert!(saved.get("free_completion_action").is_none());
            }
        }
    }
    #[test]
    fn completion_action_validation_and_persistence_preserve_script_as_data() {
        let file = TestFile::new();
        let mut state = AppState::default();
        let action = CompletionAction { enabled: true, kind: ActionKind::Command,
            command: "Write-Output '</script> 中文 \"quotes\"'".into(), delay_sec: 0 };
        assert!(action.validate().is_ok());
        state.tasks[0].completion_action = action.clone();
        state.tasks[1].completion_action = CompletionAction { kind: ActionKind::Lock, delay_sec: 300, ..action.clone() };
        state.save_to_path(&file.0).unwrap();
        let restored = AppState::load(&file.0);
        assert_eq!(restored.tasks[0].completion_action, action);
        assert_eq!(restored.tasks[1].completion_action, state.tasks[1].completion_action);
        let value = serde_json::to_value(&state).unwrap();
        assert!(value["tasks"][0].get("completionAction").is_some());
        assert!(value.get("freeCompletionAction").is_none());
        assert!(value.get("free_completion_action").is_none());
        for invalid in [CompletionAction { command: " ".into(), ..action.clone() },
            CompletionAction { command: "a\0b".into(), ..action.clone() },
            CompletionAction { command: "x".repeat(4097), ..action.clone() },
            CompletionAction { delay_sec: 301, ..action.clone() }] {
            assert!(invalid.validate().is_err());
        }
        assert!(CompletionAction { command: "x".repeat(4096), ..action }.validate().is_ok());
    }
    #[test]
    fn command_interpreters_stay_distinct_across_load_save_and_validation() {
        let file = TestFile::new();
        let mut state = AppState::default();
        for (index, kind) in [ActionKind::Command, ActionKind::Shell].into_iter().enumerate() {
            state.tasks[index].completion_action = CompletionAction {
                enabled: true, kind, command: "literal script; '$HOME' 中文".into(), delay_sec: 0,
            };
        }
        state.save_to_path(&file.0).unwrap();
        let loaded = AppState::load(&file.0);
        assert_eq!(loaded.tasks[0].completion_action, state.tasks[0].completion_action);
        assert_eq!(loaded.tasks[1].completion_action, state.tasks[1].completion_action);
        let shell = &loaded.tasks[1].completion_action;
        assert_eq!(serde_json::to_value(shell).unwrap()["kind"], "shell");
        assert!(CompletionAction { command: " ".into(), ..shell.clone() }.validate().is_err());
        assert!(CompletionAction { command: "x\0y".into(), ..shell.clone() }.validate().is_err());
        let legacy: CompletionAction = serde_json::from_str(r#"{"enabled":true,"command":"old PowerShell"}"#).unwrap();
        assert_eq!(legacy.kind, ActionKind::Command);
    }

    #[test]
    fn duration_labels_include_nonzero_seconds() {
        assert_eq!(Task::new("测试".into(), 3).duration_label(), "3 秒");
        assert_eq!(Task::new("测试".into(), 61).duration_label(), "1 分 1 秒");
        assert_eq!(Task::new("测试".into(), 3_601).duration_label(), "1 小时 0 分 1 秒");
    }

    #[test]
    fn relay_settings_validate_https_and_preserve_no_legacy_secrets() {
        let empty: RelaySettings = serde_json::from_str("{}").unwrap();
        assert!(!empty.enabled && empty.connection_key.is_empty());
        assert!(empty.validate().is_ok());
        let valid = RelaySettings { enabled: true, service_url: "https://hooks.example.com".into(), connection_key: "ab".repeat(32) };
        assert!(valid.validate().is_ok());
        assert!(!format!("{:?}", valid).contains(&valid.connection_key));
        for url in ["http://localhost", "https://user:pass@example.com", "https://example.com/path", "https://example.com?q=x"] {
            let mut bad = valid.clone(); bad.service_url = url.into(); assert!(bad.validate().is_err());
            bad.normalize(); assert!(!bad.enabled);
        }
        let corrupt: RelaySettings = serde_json::from_str(r#"{"enabled":true,"serviceUrl":"https://hooks.example.com","connectionKey":"short"}"#).unwrap();
        assert!(!corrupt.enabled && corrupt.connection_key.is_empty());
    }
}
