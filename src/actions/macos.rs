//! macOS completion actions. Planning is separated from execution so Windows CI
//! can verify command boundaries without invoking a system action.
//!
//! References checked for this implementation:
//! - zsh startup files: https://zsh.sourceforge.io/Doc/Release/Files.html
//! - Apple System Events Power suite:
//!   https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptX/Concepts/as_related_apps.html
//! - Apple automation permission:
//!   https://support.apple.com/guide/mac-help/mchl108e1718/mac
//! - CGSession availability / -suspend (Chromium 123.0.6312.86):
//!   https://chromium.googlesource.com/chromium/src/+/123.0.6312.86/remoting/host/curtain_mode_mac.cc
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use crate::state::{ActionKind, CompletionAction};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const CG_SESSION: &str =
    "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession";

// Intentionally not Debug: the argument vector may contain the user's script.
struct ProcessSpec {
    program: &'static str,
    args: Vec<String>,
}

/// Only the explicit Shell kind may enter zsh. System actions never use user
/// text, a task name, a PATH-resolved executable, or a second shell wrapper.
fn process_spec(action: &CompletionAction, cgsession_available: bool) -> Result<ProcessSpec, String> {
    let spec = match action.kind {
        ActionKind::Command => {
            return Err("此任务保存的是 Windows PowerShell 命令；macOS 不会将它转换为 Shell，请在任务设置中明确选择并编辑 Shell 命令".into());
        }
        ActionKind::Shell => ProcessSpec {
            program: "/bin/zsh",
            // -f disables RCS and user startup files. zsh always reads the
            // system /etc/zshenv; it is not a user startup file.
            args: vec!["-f".into(), "-c".into(), action.command.clone()],
        },
        ActionKind::Lock if cgsession_available => ProcessSpec {
            program: CG_SESSION,
            args: vec!["-suspend".into()],
        },
        ActionKind::Lock => {
            // CGSession was removed in Big Sur. Never substitute display sleep,
            // screen-saver activation or simulated keyboard input for a lock.
            return Err("当前 macOS 不提供可用的 CGSession 锁屏接口，请使用系统的锁定屏幕功能".into());
        }
        ActionKind::Sleep | ActionKind::Shutdown | ActionKind::Restart => {
            let script = match action.kind {
                ActionKind::Sleep => "tell application id \"com.apple.systemevents\" to sleep",
                ActionKind::Shutdown => "tell application id \"com.apple.systemevents\" to shut down",
                ActionKind::Restart => "tell application id \"com.apple.systemevents\" to restart",
                _ => unreachable!(),
            };
            ProcessSpec {
                program: "/usr/bin/osascript",
                args: vec!["-l".into(), "AppleScript".into(), "-e".into(), script.into()],
            }
        }
    };
    Ok(spec)
}

fn home_directory(home: Option<OsString>) -> Result<PathBuf, String> {
    let path = home.map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_dir());
    path.ok_or_else(|| "无法确定可用的用户主目录（HOME），未执行结束动作".into())
}

fn result_message(kind: ActionKind, success: bool, code: Option<i32>) -> Result<String, String> {
    if success {
        return Ok(match kind {
            ActionKind::Shell => "Shell 命令已执行",
            ActionKind::Lock => "已提交锁屏请求",
            ActionKind::Sleep => "已提交睡眠请求",
            ActionKind::Shutdown => "已提交关机请求",
            ActionKind::Restart => "已提交重启请求",
            ActionKind::Command => "此 PowerShell 命令不适用于 macOS",
        }.into());
    }
    let detail = code.map(|value| format!("退出码 {value}"))
        .unwrap_or_else(|| "进程被系统终止".into());
    if kind == ActionKind::Shell {
        Err(format!("Shell 命令执行失败（{detail}）；未保存脚本输出"))
    } else if kind == ActionKind::Lock {
        Err(format!("锁屏请求未完成（{detail}），请使用系统的锁定屏幕功能"))
    } else {
        Err(format!("系统动作未完成（{detail}）；可能被取消或缺少自动化权限，请检查“系统设置 → 隐私与安全性 → 自动化”"))
    }
}

pub(super) fn execute(action: &CompletionAction) -> Result<String, String> {
    if !action.enabled { return Err("动作未启用".into()); }
    action.validate().map_err(str::to_owned)?;
    let spec = process_spec(action, Path::new(CG_SESSION).is_file())?;
    let working_directory = home_directory(std::env::var_os("HOME"))?;
    // The caller runs this on its worker thread. Do not print Command/args or
    // retain child output: scripts can contain credentials or private paths.
    let status = Command::new(spec.program)
        .args(&spec.args)
        .current_dir(working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| match error.raw_os_error() {
            Some(code) => format!("无法启动 macOS 结束动作（系统错误 {code}）"),
            None => "无法启动 macOS 结束动作".into(),
        })?;
    result_message(action.kind, status.success(), status.code())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action(kind: ActionKind, command: &str) -> CompletionAction {
        CompletionAction { enabled: true, kind, command: command.into(), delay_sec: 10 }
    }

    #[test]
    fn shell_uses_one_unchanged_script_argument_without_profiles() {
        let script = "printf '%s' \"中文 $HOME\"; printf '%s' '\u{0060}literal\u{0060}'\n# second line";
        let spec = process_spec(&action(ActionKind::Shell, script), false).unwrap();
        assert_eq!(spec.program, "/bin/zsh");
        assert_eq!(spec.args, ["-f", "-c", script]);
    }

    #[test]
    fn powershell_is_never_reinterpreted_or_included_in_errors() {
        let secret = "Write-Output 'PRIVATE_SCRIPT_MARKER'";
        let error = process_spec(&action(ActionKind::Command, secret), true).err().unwrap();
        assert!(error.contains("Windows PowerShell"));
        assert!(!error.contains("PRIVATE_SCRIPT_MARKER"));
    }

    #[test]
    fn system_actions_are_fixed_and_ignore_command_text() {
        let cases = [
            (ActionKind::Sleep, "tell application id \"com.apple.systemevents\" to sleep"),
            (ActionKind::Shutdown, "tell application id \"com.apple.systemevents\" to shut down"),
            (ActionKind::Restart, "tell application id \"com.apple.systemevents\" to restart"),
        ];
        for (kind, script) in cases {
            let spec = process_spec(&action(kind, "do not execute this user text"), false).unwrap();
            assert_eq!(spec.program, "/usr/bin/osascript");
            assert_eq!(spec.args, ["-l", "AppleScript", "-e", script]);
        }
    }

    #[test]
    fn missing_lock_api_fails_instead_of_sleeping_the_display() {
        let lock = action(ActionKind::Lock, "unused");
        let error = process_spec(&lock, false).err().unwrap();
        assert!(error.contains("CGSession"));
        let supported = process_spec(&lock, true).unwrap();
        assert_eq!(supported.program, CG_SESSION);
        assert_eq!(supported.args, ["-suspend"]);
    }

    #[test]
    fn working_directory_requires_an_existing_absolute_home() {
        assert!(home_directory(None).is_err());
        assert!(home_directory(Some("relative-home".into())).is_err());
        let existing = std::env::current_dir().unwrap();
        assert_eq!(home_directory(Some(existing.clone().into_os_string())).unwrap(), existing);
    }

    #[test]
    fn failures_distinguish_shell_and_system_permission_guidance() {
        let shell = result_message(ActionKind::Shell, false, Some(7)).unwrap_err();
        assert!(shell.contains("7"));
        assert!(!shell.contains("自动化"));
        let power = result_message(ActionKind::Shutdown, false, Some(1)).unwrap_err();
        assert!(power.contains("自动化"));
        assert!(result_message(ActionKind::Sleep, true, Some(0)).unwrap().contains("请求"));
    }
}
