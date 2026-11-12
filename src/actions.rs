//! Completion actions: in-memory run eligibility, delayed dispatch and execution.
//! No pending execution state is persisted; starting the app never replays actions.
use crate::state::{ActionKind, AppState, CompletionAction};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::{Duration, Instant};

#[cfg(any(target_os = "macos", test))]
mod macos;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TimerUpdate {
    pub run_id: String,
    pub task_id: String,
    pub started: bool,
    pub running: bool,
    pub done: bool,
    pub remaining_ms: f64,
    pub total_ms: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TimerCompletion {
    pub run_id: String,
    pub task_id: String,
    pub task: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase { Idle, Armed, Pending, Running, Success, Error, Cancelled }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionStatus {
    pub run_id: String,
    pub task_id: String,
    pub phase: Phase,
    pub label: String,
    pub message: String,
    pub remaining_sec: u64,
}

impl Default for ActionStatus {
    fn default() -> Self {
        Self { run_id: String::new(), task_id: String::new(), phase: Phase::Idle, label: String::new(),
            message: String::new(), remaining_sec: 0 }
    }
}

#[derive(Clone)]
pub struct ExecutionJob { pub run_id: String, pub action: CompletionAction }

#[derive(Debug, Clone)]
pub struct ExecutionResult { pub ok: bool, pub message: String }

struct Run {
    id: String,
    task_id: String,
    action: CompletionAction,
    finished_state: bool,
    completion_consumed: bool,
    cancelled: bool,
    pending: Option<Instant>,
    launched: bool,
}

#[derive(Default)]
pub struct ActionController {
    seen: HashSet<String>,
    current: Option<Run>,
    status: ActionStatus,
}

/// Never resolve a completion message against a different selected task.
fn configured_action(state: &AppState, task_id: &str) -> Option<CompletionAction> {
    if state.tasks.is_empty() {
        // Free timers retain completion identity for reminders, never an action.
        return task_id.is_empty().then(CompletionAction::default);
    }
    state.current_task().filter(|task| task.id == task_id)
        .map(|task| task.completion_action.clone())
}

impl ActionController {
    pub fn status(&self) -> &ActionStatus { &self.status }

    pub fn observe(&mut self, update: &TimerUpdate, state: &AppState) {
        if update.run_id.is_empty() {
            if !update.started { self.invalidate("计时已重置，本次动作已取消"); }
            return;
        }
        if update.run_id.len() > 128 || update.task_id.len() > 1024
            || !update.remaining_ms.is_finite() || !update.total_ms.is_finite() { return; }
        if let Some(run) = self.current.as_mut().filter(|run| run.id == update.run_id) {
            if run.task_id != update.task_id { return; }
            if !update.started { self.invalidate("计时已重置，本次动作已取消"); return; }
            run.finished_state = update.done && !update.running && update.remaining_ms == 0.0;
            return;
        }
        if self.seen.contains(&update.run_id) || !update.started || !update.running
            || update.done || update.remaining_ms <= 0.0 || update.total_ms <= 0.0 { return; }
        let Some(action) = configured_action(state, &update.task_id) else { return; };
        self.invalidate("新一轮计时已开始，原动作已取消");
        self.seen.insert(update.run_id.clone());
        self.status = if action.enabled && action.validate().is_ok() {
            ActionStatus { run_id: update.run_id.clone(), task_id: update.task_id.clone(), phase: Phase::Armed,
                label: action.kind.label().into(), message: "已为本次计时启用，可随时取消".into(),
                remaining_sec: action.delay_sec }
        } else { ActionStatus::default() };
        self.current = Some(Run { id: update.run_id.clone(), task_id: update.task_id.clone(),
            cancelled: !action.enabled || action.validate().is_err(), action,
            finished_state: false, completion_consumed: false, pending: None, launched: false });
    }

    /// Consumes completion once, including when its optional action was cancelled.
    /// Reminders may still run for a completed timer whose action was cancelled.
    pub fn complete(&mut self, completion: &TimerCompletion, now: Instant) -> bool {
        let Some(run) = self.current.as_mut() else { return false; };
        if run.id != completion.run_id || run.task_id != completion.task_id
            || !run.finished_state || run.completion_consumed { return false; }
        run.completion_consumed = true;
        if !run.cancelled && !run.launched {
            run.pending = Some(now + Duration::from_secs(run.action.delay_sec));
            self.status.phase = Phase::Pending;
            self.status.remaining_sec = run.action.delay_sec;
            self.status.message = "倒计时已结束，等待执行；仍可取消".into();
        }
        true
    }

    pub fn cancel(&mut self, run_id: &str, message: &str) -> bool {
        let Some(run) = self.current.as_mut() else { return false; };
        if run.id != run_id || run.cancelled || run.launched { return false; }
        run.cancelled = true;
        run.pending = None;
        self.status.phase = Phase::Cancelled;
        self.status.remaining_sec = 0;
        self.status.message = message.into();
        true
    }

    pub fn cancel_scope(&mut self, task_id: &str) {
        if let Some(id) = self.current.as_ref().filter(|run| run.task_id == task_id).map(|run| run.id.clone()) {
            self.cancel(&id, "配置已保存，本次动作已取消；下次开始时生效");
        }
    }

    pub fn invalidate(&mut self, message: &str) {
        if let Some(id) = self.current.as_ref().map(|run| run.id.clone()) { self.cancel(&id, message); }
        self.current = None;
    }

    /// Called by the existing event loop; status changes only at whole-second
    /// countdown boundaries. The launch is consumed before handing a job out.
    pub fn poll(&mut self, now: Instant) -> Option<ExecutionJob> {
        let run = self.current.as_mut()?;
        let deadline = run.pending?;
        if run.cancelled || run.launched { return None; }
        if now < deadline {
            let left = deadline.duration_since(now);
            self.status.remaining_sec = left.as_secs() + u64::from(left.subsec_nanos() > 0);
            return None;
        }
        run.pending = None;
        run.launched = true;
        self.status.phase = Phase::Running;
        self.status.remaining_sec = 0;
        self.status.message = "正在执行；已启动的动作不会被中止".into();
        Some(ExecutionJob { run_id: run.id.clone(), action: run.action.clone() })
    }

    pub fn finished(&mut self, run_id: &str, result: ExecutionResult) {
        // A late worker result must never replace a newer timer's action widget.
        if self.status.run_id != run_id || self.status.phase != Phase::Running { return; }
        self.status.phase = if result.ok { Phase::Success } else { Phase::Error };
        self.status.message = result.message;
        self.status.remaining_sec = 0;
    }
}

/// UTF-16LE Base64 is PowerShell's documented EncodedCommand input format.
fn encoded_command(script: &str) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut result = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = ((chunk[0] as u32) << 16)
            | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
            | chunk.get(2).copied().unwrap_or(0) as u32;
        result.push(ALPHABET[((value >> 18) & 63) as usize] as char);
        result.push(ALPHABET[((value >> 12) & 63) as usize] as char);
        result.push(if chunk.len() > 1 { ALPHABET[((value >> 6) & 63) as usize] as char } else { '=' });
        result.push(if chunk.len() > 2 { ALPHABET[(value & 63) as usize] as char } else { '=' });
    }
    result
}

fn process_spec(action: &CompletionAction, system_dir: &std::path::Path)
    -> Option<(std::path::PathBuf, Vec<String>)> {
    match action.kind {
        ActionKind::Command => Some((system_dir.join("WindowsPowerShell").join("v1.0").join("powershell.exe"),
            vec!["-NoProfile".into(), "-NonInteractive".into(), "-EncodedCommand".into(), encoded_command(&action.command)])),
        ActionKind::Shutdown | ActionKind::Restart => Some((system_dir.join("shutdown.exe"),
            vec![if action.kind == ActionKind::Shutdown { "/s" } else { "/r" }.into(), "/t".into(), "0".into()])),
        _ => None,
    }
}

pub fn execute(job: &ExecutionJob) -> ExecutionResult {
    let result = if !job.action.enabled {
        Err("动作未启用".into())
    } else if let Err(message) = job.action.validate() {
        Err(message.into())
    } else {
        #[cfg(target_os = "windows")]
        { native::execute(&job.action) }
        #[cfg(target_os = "macos")]
        { macos::execute(&job.action) }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        { Err("此平台尚不支持结束动作".into()) }
    };
    match result {
        Ok(message) => ExecutionResult { ok: true, message },
        Err(message) => ExecutionResult { ok: false, message },
    }
}

#[cfg(target_os = "windows")]
mod native {
    use super::*;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::sync::Mutex;

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct Luid { low: u32, high: i32 }
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct Privileges { count: u32, luid: Luid, attributes: u32 }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
        fn GetCurrentProcess() -> isize;
        fn GetLastError() -> u32;
        fn SetLastError(error: u32);
        fn CloseHandle(handle: isize) -> i32;
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn OpenProcessToken(process: isize, access: u32, token: *mut isize) -> i32;
        fn LookupPrivilegeValueW(system: *const u16, name: *const u16, luid: *mut Luid) -> i32;
        fn AdjustTokenPrivileges(token: isize, disable: i32, state: *const Privileges,
            size: u32, previous: *mut Privileges, returned: *mut u32) -> i32;
    }
    #[link(name = "user32")]
    extern "system" { fn LockWorkStation() -> i32; }
    #[link(name = "powrprof")]
    extern "system" { fn SetSuspendState(hibernate: u8, force: u8, disable_wake: u8) -> u8; }

    fn last_error(operation: &str) -> String {
        format!("{}失败（系统错误 {}）", operation, unsafe { GetLastError() })
    }

    fn system_directory() -> Result<PathBuf, String> {
        let mut buffer = vec![0u16; 32768];
        let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
        if length == 0 || length >= buffer.len() { return Err(last_error("获取系统目录")); }
        Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length])))
    }

    struct ShutdownPrivilege { token: isize, previous: Privileges }
    impl ShutdownPrivilege {
        fn acquire() -> Result<Self, String> {
            let mut token = 0;
            if unsafe { OpenProcessToken(GetCurrentProcess(), 0x0020 | 0x0008, &mut token) } == 0 {
                return Err(last_error("读取睡眠权限"));
            }
            let mut requested = Privileges { count: 1, attributes: 0x0002, ..Privileges::default() };
            let name: Vec<u16> = "SeShutdownPrivilege\0".encode_utf16().collect();
            if unsafe { LookupPrivilegeValueW(std::ptr::null(), name.as_ptr(), &mut requested.luid) } == 0 {
                let error = last_error("查找睡眠权限");
                unsafe { CloseHandle(token); }
                return Err(error);
            }
            let mut previous = Privileges::default();
            let mut returned = 0;
            unsafe { SetLastError(0); }
            let success = unsafe { AdjustTokenPrivileges(token, 0, &requested,
                std::mem::size_of::<Privileges>() as u32, &mut previous, &mut returned) };
            let error = unsafe { GetLastError() };
            if success == 0 || error != 0 {
                unsafe { CloseHandle(token); }
                return Err(format!("无法启用睡眠权限（系统错误 {}）", error));
            }
            Ok(Self { token, previous })
        }
    }
    impl Drop for ShutdownPrivilege {
        fn drop(&mut self) {
            unsafe {
                AdjustTokenPrivileges(self.token, 0, &self.previous, 0, std::ptr::null_mut(), std::ptr::null_mut());
                CloseHandle(self.token);
            }
        }
    }

    pub fn execute(action: &CompletionAction) -> Result<String, String> {
        if action.kind == ActionKind::Shell { return Err("macOS Shell 命令不能在 Windows 上执行，请选择 PowerShell 命令".into()); }
        if action.kind == ActionKind::Lock {
            return if unsafe { LockWorkStation() } != 0 { Ok("已发送锁屏请求".into()) }
                else { Err(last_error("锁屏请求")) };
        }
        if action.kind == ActionKind::Sleep {
            // SetSuspendState requires SE_SHUTDOWN_NAME; successful privilege
            // adjustment may still return ERROR_NOT_ALL_ASSIGNED. Restore the
            // previous privilege state after waking, including on failure.
            // https://learn.microsoft.com/windows/win32/api/powrprof/nf-powrprof-setsuspendstate
            static SLEEP_PRIVILEGE: Mutex<()> = Mutex::new(());
            let _lock = SLEEP_PRIVILEGE.lock().map_err(|_| "睡眠权限状态不可用".to_string())?;
            let _privilege = ShutdownPrivilege::acquire()?;
            return if unsafe { SetSuspendState(0, 0, 0) } != 0 { Ok("睡眠请求已执行".into()) }
                else { Err(last_error("睡眠请求")) };
        }
        let system_dir = system_directory()?;
        let (program, args) = process_spec(action, &system_dir).ok_or("不支持的动作")?;
        let executable = std::env::current_exe().map_err(|_| "无法确定命令工作目录".to_string())?;
        let working_dir = executable.parent().ok_or("无法确定命令工作目录")?;
        // Run only on a worker thread, without a console or captured output.
        // There is deliberately no script timeout and no termination on cancel.
        let status = Command::new(program).args(args).current_dir(working_dir)
            .creation_flags(0x0800_0000).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .status().map_err(|error| format!("启动或等待动作失败：{}", error))?;
        if !status.success() {
            return Err(match status.code() { Some(code) => format!("动作退出码 {}", code), None => "动作未正常退出".into() });
        }
        Ok(match action.kind {
            ActionKind::Command => "命令执行完成", ActionKind::Shutdown => "已发送关机请求",
            ActionKind::Restart => "已发送重启请求", _ => unreachable!(),
        }.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(delay: u64) -> AppState {
        let mut state = AppState::default();
        state.tasks[0].completion_action = CompletionAction {
            enabled: true, kind: ActionKind::Command, command: "fake executor only".into(), delay_sec: delay,
        };
        state
    }
    fn running(id: &str) -> TimerUpdate {
        TimerUpdate { run_id: id.into(), task_id: "t1".into(), started: true, running: true,
            done: false, remaining_ms: 3000.0, total_ms: 3000.0 }
    }
    fn done(id: &str) -> TimerUpdate {
        TimerUpdate { running: false, done: true, remaining_ms: 0.0, ..running(id) }
    }
    fn completion(id: &str) -> TimerCompletion {
        TimerCompletion { run_id: id.into(), task_id: "t1".into(), task: "display only".into() }
    }
    fn fake_execute(job: &ExecutionJob, calls: &mut Vec<String>) -> ExecutionResult {
        calls.push(job.run_id.clone());
        ExecutionResult { ok: true, message: "fake success".into() }
    }

    #[test]
    fn completion_requires_latest_finished_state_and_consumes_exactly_once() {
        let state = state(3);
        let now = Instant::now();
        let mut controller = ActionController::default();
        controller.observe(&running("one"), &state);
        assert_eq!(controller.status().phase, Phase::Armed);
        assert!(!controller.complete(&completion("one"), now));
        let mut unfinished = done("one");
        unfinished.remaining_ms = 1.0;
        controller.observe(&unfinished, &state);
        assert!(!controller.complete(&completion("one"), now));
        controller.observe(&done("one"), &state);
        controller.observe(&running("one"), &state);
        assert!(!controller.complete(&completion("one"), now));
        controller.observe(&done("one"), &state);
        assert!(controller.complete(&completion("one"), now));
        assert!(!controller.complete(&completion("one"), now));
        assert_eq!(controller.status().phase, Phase::Pending);
        assert_eq!(controller.status().task_id, "t1");
        assert!(controller.poll(now + Duration::from_secs(2)).is_none());
        assert_eq!(controller.status().remaining_sec, 1);
        let job = controller.poll(now + Duration::from_secs(3)).unwrap();
        assert!(controller.poll(now + Duration::from_secs(30)).is_none());
        assert!(!controller.cancel("one", "cancel"));
        let mut calls = Vec::new();
        controller.finished("one", fake_execute(&job, &mut calls));
        assert_eq!(calls, vec!["one"]);
        assert_eq!(controller.status().phase, Phase::Success);
        assert_eq!(controller.status().task_id, "t1");
    }

    #[test]
    fn completed_idle_display_does_not_cancel_or_repeat_delayed_actions() {
        let state = state(30);
        let now = Instant::now();
        let mut controller = ActionController::default();
        controller.observe(&running("idle-run"), &state);
        controller.observe(&done("idle-run"), &state);
        assert!(controller.complete(&completion("idle-run"), now));
        let idle_update: TimerUpdate = serde_json::from_value(serde_json::json!({
            "runId":"idle-run", "taskId":"t1", "started":true,
            "running":false, "done":true, "remainingMs":0, "totalMs":3000,
            "idleAfterCompletion":true
        })).unwrap();
        controller.observe(&idle_update, &state);
        assert_eq!(controller.status().phase, Phase::Pending);
        assert!(controller.poll(now + Duration::from_secs(10)).is_none());
        assert_eq!(controller.status().remaining_sec, 20);
        controller.observe(&idle_update, &state);
        assert!(!controller.complete(&completion("idle-run"), now + Duration::from_secs(20)));
        let job = controller.poll(now + Duration::from_secs(30)).unwrap();
        assert_eq!(job.run_id, "idle-run");
        let mut calls = Vec::new();
        controller.finished("idle-run", fake_execute(&job, &mut calls));
        controller.observe(&idle_update, &state);
        assert!(controller.poll(now + Duration::from_secs(300)).is_none());
        assert_eq!(controller.status().phase, Phase::Success);
        assert_eq!(calls, vec!["idle-run"]);
    }
    #[test]
    fn pause_resume_keeps_snapshot_and_config_save_cancels_scope() {
        let mut state = state(1);
        let mut controller = ActionController::default();
        controller.observe(&running("one"), &state);
        let paused = TimerUpdate { running: false, ..running("one") };
        controller.observe(&paused, &state);
        state.tasks[0].completion_action.command = "changed for next run".into();
        controller.observe(&running("one"), &state);
        assert_eq!(controller.current.as_ref().unwrap().action.command, "fake executor only");
        controller.cancel_scope("t2");
        assert_eq!(controller.status().phase, Phase::Armed);
        controller.cancel_scope("t1");
        assert_eq!(controller.status().phase, Phase::Cancelled);
        assert_eq!(controller.status().task_id, "t1");
        controller.observe(&done("one"), &state);
        assert!(controller.complete(&completion("one"), Instant::now()));
        assert!(controller.poll(Instant::now() + Duration::from_secs(10)).is_none());
        controller.observe(&running("two"), &state);
        assert_eq!(controller.current.as_ref().unwrap().action.command, "changed for next run");
    }

    #[test]
    fn cancellation_reset_new_run_and_restart_never_replay_pending_actions() {
        let state = state(1);
        let now = Instant::now();
        for cancel_while_pending in [false, true] {
            let mut controller = ActionController::default();
            controller.observe(&running("one"), &state);
            if cancel_while_pending {
                controller.observe(&done("one"), &state);
                assert!(controller.complete(&completion("one"), now));
            }
            assert!(!controller.cancel("wrong-id", "cancel"));
            assert!(controller.cancel("one", "cancel"));
            controller.observe(&done("one"), &state);
            controller.complete(&completion("one"), now);
            assert!(controller.poll(now + Duration::from_secs(10)).is_none());
            controller.invalidate("reset");
            controller.observe(&running("one"), &state);
            assert!(controller.current.is_none());
        }
        let mut controller = ActionController::default();
        controller.observe(&running("old"), &state);
        controller.observe(&done("old"), &state);
        controller.complete(&completion("old"), now);
        controller.observe(&running("new"), &state);
        assert!(!controller.complete(&completion("old"), now));
        assert!(controller.poll(now + Duration::from_secs(10)).is_none());
        controller.observe(&TimerUpdate::default(), &state);
        controller.observe(&done("new"), &state);
        assert!(!controller.complete(&completion("new"), now));
        let mut restarted = ActionController::default();
        restarted.observe(&done("old"), &state);
        assert!(!restarted.complete(&completion("old"), now));
        assert!(restarted.poll(now + Duration::from_secs(100)).is_none());
    }

    #[test]
    fn task_scope_and_disabled_actions_do_not_grant_execution() {
        let mut state = state(0);
        let mut controller = ActionController::default();
        controller.observe(&TimerUpdate { task_id: "t2".into(), ..running("wrong-task") }, &state);
        assert!(controller.current.is_none());
        controller.observe(&TimerUpdate { task_id: String::new(), ..running("wrong-free") }, &state);
        assert!(controller.current.is_none());
        state.tasks[0].completion_action.enabled = false;
        controller.observe(&running("disabled"), &state);
        assert_eq!(controller.status().phase, Phase::Idle);
        state.tasks[0].completion_action.enabled = true;
        controller.observe(&running("disabled"), &state);
        controller.observe(&done("disabled"), &state);
        assert!(controller.complete(&completion("disabled"), Instant::now()));
        assert!(controller.poll(Instant::now()).is_none());
        controller.observe(&running("valid"), &state);
        controller.observe(&done("valid"), &state);
        let wrong = TimerCompletion { task_id: "t2".into(), ..completion("valid") };
        assert!(!controller.complete(&wrong, Instant::now()));
    }

    #[test]
    fn free_timer_completes_once_but_never_executes_legacy_free_actions() {
        for kind in ["shutdown", "command"] {
            let state: AppState = serde_json::from_value(serde_json::json!({
                "tasks":[],"current_id":"","duration_sec":3,
                "freeCompletionAction":{"enabled":true,"kind":kind,"command":"must never execute","delaySec":0},
                "free_completion_action":{"enabled":true,"kind":kind,"command":"must never execute","delaySec":0}
            })).unwrap();
            let mut controller = ActionController::default();
            let start = TimerUpdate { task_id: String::new(), ..running("free") };
            controller.observe(&start, &state);
            assert!(controller.current.is_some());
            assert_eq!(controller.status().phase, Phase::Idle);
            assert!(controller.status().task_id.is_empty());
            let status_json = serde_json::to_value(controller.status()).unwrap();
            assert_eq!(status_json["taskId"], "");
            controller.observe(&TimerUpdate { running: false, done: true, remaining_ms: 0.0, ..start }, &state);
            let now = Instant::now();
            let completed = TimerCompletion { task_id: String::new(), ..completion("free") };
            assert!(controller.complete(&completed, now));
            assert!(!controller.complete(&completed, now));
            assert!(controller.poll(now).is_none());
            assert!(controller.poll(now + Duration::from_secs(3600)).is_none());
            assert_eq!(controller.status().phase, Phase::Idle);
        }
    }

    #[test]
    fn late_worker_results_do_not_replace_another_tasks_action_status() {
        let mut state = state(0);
        let mut controller = ActionController::default();
        controller.observe(&running("one"), &state);
        controller.observe(&done("one"), &state);
        let now = Instant::now();
        assert!(controller.complete(&completion("one"), now));
        let job = controller.poll(now).unwrap();
        assert_eq!(controller.status().task_id, "t1");
        state.tasks[1].completion_action = state.tasks[0].completion_action.clone();
        state.current_id = "t2".into();
        controller.observe(&TimerUpdate { task_id: "t2".into(), ..running("two") }, &state);
        let mut calls = Vec::new();
        controller.finished("one", fake_execute(&job, &mut calls));
        assert_eq!(controller.status().run_id, "two");
        assert_eq!(controller.status().task_id, "t2");
        assert_eq!(controller.status().phase, Phase::Armed);
        let status_json = serde_json::to_value(controller.status()).unwrap();
        assert_eq!(status_json["taskId"], "t2");
        assert!(status_json.get("task_id").is_none());
    }

    #[test]
    fn execution_error_is_reported_without_retrying() {
        let state = state(0);
        let now = Instant::now();
        let mut controller = ActionController::default();
        controller.observe(&running("one"), &state);
        controller.observe(&done("one"), &state);
        controller.complete(&completion("one"), now);
        assert!(controller.poll(now).is_some());
        controller.finished("one", ExecutionResult { ok: false, message: "动作退出码 7".into() });
        assert_eq!(controller.status().phase, Phase::Error);
        assert_eq!(controller.status().task_id, "t1");
        assert!(controller.poll(now).is_none());
        assert!(!controller.complete(&completion("one"), now));
    }

    #[test]
    fn process_specs_use_system_paths_encoded_script_and_never_force_shutdown() {
        let system = std::path::Path::new(r"C:\Windows\System32");
        let mut action = state(0).tasks[0].completion_action.clone();
        action.command = "A".into();
        let (program, args) = process_spec(&action, system).unwrap();
        assert_eq!(program, system.join("WindowsPowerShell").join("v1.0").join("powershell.exe"));
        assert_eq!(args, ["-NoProfile", "-NonInteractive", "-EncodedCommand", "QQA="]);
        assert_eq!(encoded_command("中"), "LU4=");
        for (kind, flag) in [(ActionKind::Shutdown, "/s"), (ActionKind::Restart, "/r")] {
            action.kind = kind;
            let (program, args) = process_spec(&action, system).unwrap();
            assert_eq!(program, system.join("shutdown.exe"));
            assert_eq!(args, [flag, "/t", "0"]);
            assert!(!args.iter().any(|arg| arg == "/f"));
        }
        for kind in [ActionKind::Lock, ActionKind::Sleep] {
            action.kind = kind;
            assert!(process_spec(&action, system).is_none());
        }
    }
}
