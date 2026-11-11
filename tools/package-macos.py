#!/usr/bin/env python3
"""Build and package a native macOS app. Python 3.11+, standard library only.

Run on macOS: python3 tools/package-macos.py --target aarch64-apple-darwin
Cross-platform layout check: python tools/package-macos.py --check-layout
The layout check does not compile, sign, launch, or claim to validate macOS.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import signal
import subprocess
import tempfile
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parent.parent
TARGETS = {"aarch64-apple-darwin": "arm64", "x86_64-apple-darwin": "x86_64"}
MIN_MACOS = "11.0"
BUNDLE_ID = "com.focusisland.app"


def version() -> str:
    value = tomllib.loads((ROOT / "Cargo.toml").read_text(encoding="utf-8"))["package"]["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", value):
        raise ValueError("macOS bundle version must be a numeric major.minor.patch")
    return value


def digest(file: Path) -> str:
    with file.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def run(args: list[str | Path], *, env: dict[str, str] | None = None, timeout: int = 600) -> str:
    command = [str(arg) for arg in args]
    print("+", " ".join(command), flush=True)
    result = subprocess.run(command, cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=timeout, check=False)
    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n", flush=True)
    if result.returncode:
        raise RuntimeError(f"{command[0]} exited with {result.returncode}")
    return result.stdout


def bundle_info(app_version: str) -> dict:
    return {
        "CFBundleName": "Focus Island",
        "CFBundleDisplayName": "Focus Island",
        "CFBundleExecutable": "focus-island",
        "CFBundleIdentifier": BUNDLE_ID,
        "CFBundlePackageType": "APPL",
        "CFBundleVersion": app_version,
        "CFBundleShortVersionString": app_version,
        "LSMinimumSystemVersion": MIN_MACOS,
        "LSUIElement": True,
        "NSHighResolutionCapable": True,
        "NSPrincipalClass": "NSApplication",
        "NSAppleEventsUsageDescription": "Focus Island uses System Events only when a task completion action you enabled requests sleep, shutdown, or restart.",
    }


def stage_bundle(binary: Path, payload: Path, app_version: str, architecture: str) -> Path:
    """Pure filesystem assembly; the caller validates/signs the real executable."""
    app = payload / "Focus Island.app"
    macos = app / "Contents" / "MacOS"
    resources = app / "Contents" / "Resources"
    macos.mkdir(parents=True)
    resources.mkdir()
    executable = macos / "focus-island"
    shutil.copyfile(binary, executable)
    executable.chmod(0o755)
    with (app / "Contents" / "Info.plist").open("wb") as target:
        plistlib.dump(bundle_info(app_version), target, sort_keys=True)
    (app / "Contents" / "PkgInfo").write_bytes(b"APPL????")
    readme = f"""Focus Island {app_version} · macOS {architecture}

Requires macOS {MIN_MACOS} or later. This package is for {architecture} only.
Move Focus Island.app to Applications, then open it. The app lives in the menu bar.
Click the pill to expand it; right-click it to open settings.
Create a task or open that task's settings to configure its completion action.
Actions default off and belong only to tasks. Free timers never execute commands.
Available completion actions: Shell command (zsh), sleep, shutdown, and restart.
Shell commands run with the user's home directory (HOME) as their working directory.
Lock screen is not supported on modern macOS and is not offered in the Mac menu.

Signing: ad-hoc signature only. No Developer ID certificate. NOT NOTARIZED.
Gatekeeper may require explicit approval in System Settings > Privacy & Security.
This package does not disable Gatekeeper or remove quarantine attributes.
Notifications and system actions may require macOS permission or be refused.

Build verification runs Rust tests and the app's isolated GUI self-test.
It does not establish real-person mouse, desktop, permission-dialog or sleep/
shutdown/restart behavior. No real system action is executed by the self-test.
The configuration remains in the user's Application Support directory.
"""
    (payload / "README.txt").write_text(readme, encoding="utf-8")
    for name in ("LICENSE", "LICENSE.txt", "LICENSE.md", "COPYING", "COPYING.txt"):
        source = ROOT / name
        if source.is_file() and not source.is_symlink():
            shutil.copyfile(source, payload / name)
    return app


def validate_binary(binary: Path, architecture: str) -> None:
    if not binary.is_file() or binary.is_symlink():
        raise ValueError("Expected a regular Mach-O executable")
    if "Mach-O" not in run(["/usr/bin/file", "-b", binary]):
        raise ValueError("The source is not a Mach-O binary")
    arches = run(["/usr/bin/lipo", "-archs", binary]).strip().split()
    if arches != [architecture]:
        raise ValueError(f"Expected one {architecture} slice, found {arches}")
    load_commands = run(["/usr/bin/otool", "-l", binary])
    minimums = re.findall(r"\bminos\s+(\d+(?:\.\d+)+)", load_commands)
    minimums += re.findall(r"cmd LC_VERSION_MIN_MACOSX\s+cmdsize \d+\s+version (\d+(?:\.\d+)+)", load_commands)
    if not minimums or any(tuple(map(int, value.split(".")[:2])) > (11, 0) for value in minimums):
        raise ValueError(f"Executable minimum macOS does not satisfy {MIN_MACOS}: {minimums}")
    dependencies = run(["/usr/bin/otool", "-L", binary]).splitlines()[1:]
    for line in dependencies:
        library = line.strip().split(" (", 1)[0]
        if library and not library.startswith(("/usr/lib/", "/System/Library/")):
            raise ValueError(f"Unbundled dynamic dependency: {library}")


def gui_selftest(executable: Path, workspace: Path) -> None:
    """The app has a 25-second deadline; an external 40-second watchdog is final."""
    result = subprocess.run(["/bin/launchctl", "print", f"gui/{os.getuid()}"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if result.returncode:
        raise RuntimeError("No macOS GUI login session is available. The GUI self-test was NOT passed.")
    profile = workspace / "selftest-profile"
    profile.mkdir()
    log = profile / "diagnostic.log"
    # An explicit isolated state prevents any saved task action from running.
    state = {"tasks": [], "current_id": "", "duration_sec": 3,
             "settings": {"sound": False, "notify": False, "showIdleEyes": False}}
    (profile / "state.json").write_text(json.dumps(state), encoding="utf-8")
    command = [str(executable), "--selftest", "--data-dir", str(profile), "--log-file", str(log)]
    process = subprocess.Popen(command, cwd=workspace, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, start_new_session=True)
    try:
        output, _ = process.communicate(timeout=40)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass  # The process can finish between the timeout and the kill.
        output, _ = process.communicate()
        print(output or "", end="")
        if log.exists():
            print(log.read_text(encoding="utf-8", errors="replace"))
        raise RuntimeError("GUI self-test exceeded the external 40-second watchdog") from None
    if output:
        print(output, end="" if output.endswith("\n") else "\n")
    diagnostics = log.read_text(encoding="utf-8", errors="replace") if log.exists() else ""
    print(diagnostics)
    if process.returncode != 0 or "SELFTEST PASS:" not in diagnostics or "SELFTEST FAIL:" in diagnostics:
        raise RuntimeError(f"GUI self-test failed (exit {process.returncode}); no artifacts will be published")
    print("GUI self-test passed; this is not a manual mouse/desktop acceptance test.")


def layout_check() -> None:
    base = ROOT / "target"
    base.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".macos-layout-", dir=base) as directory:
        stage = Path(directory)
        assert stage.resolve().parent == base.resolve() and stage.name.startswith(".macos-layout-")
        source = stage / "fixture.bin"
        source.write_bytes(b"Layout fixture only; never executable macOS evidence.\n")
        app = stage_bundle(source, stage / "payload", version(), "arm64")
        info = plistlib.loads((app / "Contents" / "Info.plist").read_bytes())
        assert info == bundle_info(version())
        assert "System Events" in info["NSAppleEventsUsageDescription"]
        assert digest(source) == digest(app / "Contents" / "MacOS" / "focus-island")
        assert (app / "Contents" / "Resources").is_dir()
        assert (app / "Contents" / "PkgInfo").read_bytes() == b"APPL????"
        assert "NOT NOTARIZED" in (stage / "payload" / "README.txt").read_text(encoding="utf-8")
        assert TARGETS == {"aarch64-apple-darwin": "arm64", "x86_64-apple-darwin": "x86_64"}
    print(json.dumps({"layoutCheck": "passed", "macOSBuildRun": False,
                      "bundleId": BUNDLE_ID, "minimumMacOS": MIN_MACOS}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=TARGETS)
    parser.add_argument("--skip-build", action="store_true", help="Use an existing release binary; still run the GUI self-test")
    parser.add_argument("--binary", type=Path, help="Existing executable, only with --skip-build")
    parser.add_argument("--check-layout", action="store_true", help="Validate bundle assembly on any OS; does not create release archives")
    args = parser.parse_args()
    if args.check_layout:
        layout_check()
        return
    if platform.system() != "Darwin":
        parser.error("Real Mac packaging must run on macOS; use --check-layout for a static local check")
    target = args.target or ("aarch64-apple-darwin" if platform.machine() == "arm64" else "x86_64-apple-darwin")
    architecture = TARGETS[target]
    if platform.machine() != architecture:
        parser.error("Build each architecture on its matching native macOS runner")
    if args.binary and not args.skip_build:
        parser.error("--binary requires --skip-build")
    app_version = version()
    build_root = ROOT / "target" / "package-macos"
    env = {**os.environ, "MACOSX_DEPLOYMENT_TARGET": MIN_MACOS}
    if not args.skip_build:
        run(["cargo", "test", "--locked", "--target", target, "--target-dir", build_root], env=env, timeout=1800)
        run(["cargo", "build", "--release", "--locked", "--target", target, "--target-dir", build_root], env=env, timeout=1800)
    binary = (args.binary or build_root / target / "release" / "focus-island").absolute()
    validate_binary(binary, architecture)
    dist = ROOT / "dist"
    if dist.is_symlink():
        raise ValueError("dist must not be a symbolic link")
    dist.mkdir(exist_ok=True)
    package_name = f"FocusIsland-{app_version}-macos-{architecture}"
    with tempfile.TemporaryDirectory(prefix=".package-macos-", dir=dist) as directory:
        stage = Path(directory)
        payload = stage / package_name
        app = stage_bundle(binary, payload, app_version, architecture)
        executable = app / "Contents" / "MacOS" / "focus-island"
        run(["/usr/bin/plutil", "-lint", app / "Contents" / "Info.plist"])
        run(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", app])
        run(["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", app])
        gui_selftest(executable, stage)
        # Check that running the self-test did not mutate the signed bundle.
        run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app])
        contents = sorted(file for file in payload.rglob("*") if file.is_file())
        (payload / "SHA256SUMS.txt").write_text("".join(f"{digest(file)}  {file.relative_to(payload).as_posix()}\n" for file in contents), encoding="utf-8")
        archive = stage / f"{package_name}.zip"
        run(["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", payload, archive])
        with zipfile.ZipFile(archive) as zipped:
            required = f"{package_name}/Focus Island.app/Contents/MacOS/focus-island"
            if zipped.testzip() or required not in zipped.namelist():
                raise RuntimeError("ZIP verification failed")
        (payload / "Applications").symlink_to("/Applications", target_is_directory=True)
        dmg = stage / f"{package_name}.dmg"
        run(["/usr/bin/hdiutil", "create", "-volname", f"Focus Island {app_version}", "-srcfolder", payload,
             "-ov", "-format", "UDZO", dmg])
        run(["/usr/bin/hdiutil", "verify", dmg])
        for source in (archive, dmg):
            destination = dist / source.name
            checksum_path = dist / f"{source.name}.sha256"
            if destination.is_symlink() or checksum_path.is_symlink():
                raise ValueError("Refusing to overwrite a package output symbolic link")
            checksum = digest(source)
            source.replace(destination)
            checksum_path.write_text(f"{checksum}  {source.name}\n", encoding="utf-8")
            print(json.dumps({"package": str(destination), "sha256": checksum, "signing": "ad-hoc", "notarized": False}))


if __name__ == "__main__":
    main()
