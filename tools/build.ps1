param(
    [ValidateSet('build', 'test', 'check', 'fmt')][string]$Action = 'build',
    [switch]$DebugBuild
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localRoot = Split-Path -Parent $projectRoot
$localToolchain = Join-Path $localRoot '.rustup-home\toolchains\stable-x86_64-pc-windows-msvc\bin'
if (Test-Path -LiteralPath (Join-Path $localToolchain 'cargo.exe')) {
    $env:RUSTUP_HOME = Join-Path $localRoot '.rustup-home'
    $env:CARGO_HOME = Join-Path $localRoot '.cargo-home'
    $env:RUSTC = Join-Path $localToolchain 'rustc.exe'
    $env:PATH = "$localToolchain;$env:PATH"
    $cargo = Join-Path $localToolchain 'cargo.exe'
} else {
    $cargo = (Get-Command cargo -ErrorAction Stop).Source
}
Push-Location -LiteralPath $projectRoot
try {
    if ($Action -eq 'fmt') {
        & $cargo fmt -- --check
    } elseif ($Action -eq 'build' -and -not $DebugBuild) {
        & $cargo build --release --locked --target-dir target/verified
    } else {
        & $cargo $Action --locked
    }
    if ($LASTEXITCODE -ne 0) { throw "cargo $Action failed ($LASTEXITCODE)" }
    if ($Action -eq 'build' -and -not $DebugBuild) {
        $dist = Join-Path $projectRoot 'dist'
        New-Item -ItemType Directory -Force -Path $dist | Out-Null
        Copy-Item -LiteralPath (Join-Path $projectRoot 'target\verified\release\focus-island.exe') -Destination (Join-Path $dist 'FocusIsland.exe') -Force
        Get-Item -LiteralPath (Join-Path $dist 'FocusIsland.exe') | Select-Object FullName, Length
    }
} finally {
    Pop-Location
}
