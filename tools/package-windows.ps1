[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [string]$SourceExe
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Windows packaging must run on Windows.'
}
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -ne 'X64' -or
    -not [Environment]::Is64BitProcess) {
    throw 'Windows x64 packaging requires an x64 Windows host and 64-bit PowerShell.'
}
if ($SourceExe -and -not $SkipBuild) { throw '-SourceExe requires -SkipBuild.' }

$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$distRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'dist'))
function Assert-ChildPath([string]$Path, [string]$Parent) {
    $absolute = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    if (-not $absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the expected directory: $absolute"
    }
    return $absolute
}
function Assert-RegularFile([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Expected a regular file: $Path"
    }
}
function Assert-SourcePath([string]$Path) {
    $absolute = Assert-ChildPath $Path $projectRoot
    $relative = $absolute.Substring($projectRoot.TrimEnd('\').Length + 1)
    $cursor = $projectRoot
    $rootItem = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Project root must not be a reparse point.' }
    foreach ($part in $relative.Split(@('\', '/'), [StringSplitOptions]::RemoveEmptyEntries)) {
        $cursor = Join-Path $cursor $part
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse points are excluded: $cursor" }
    }
    Assert-RegularFile $absolute
    return $absolute
}
function Assert-X64Executable([string]$Path) {
    Assert-RegularFile $Path
    $stream = [IO.File]::OpenRead($Path)
    $reader = New-Object IO.BinaryReader($stream)
    try {
        if ($stream.Length -lt 256 -or $reader.ReadUInt16() -ne 0x5A4D) { throw 'Missing MZ header.' }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadUInt32()
        if ($peOffset -lt 0x40 -or $peOffset + 94 -gt $stream.Length) { throw 'Invalid PE header offset.' }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0x8664) { throw 'Expected an x64 PE executable.' }
        $stream.Position = $peOffset + 24
        if ($reader.ReadUInt16() -ne 0x20B) { throw 'Expected PE32+ format.' }
        $stream.Position = $peOffset + 92
        if ($reader.ReadUInt16() -ne 2) { throw 'Expected a Windows GUI executable.' }
    } finally { $reader.Dispose(); $stream.Dispose() }
}

$manifest = [IO.File]::ReadAllText((Join-Path $projectRoot 'Cargo.toml'))
$packageSection = [regex]::Match($manifest, '(?ms)^\[package\]\s*\r?\n(?<body>.*?)(?=^\[|\z)')
$versionMatch = [regex]::Match($packageSection.Groups['body'].Value, '(?m)^version\s*=\s*"(?<version>[^"\r\n]+)"\s*$')
$version = $versionMatch.Groups['version'].Value
if (-not $packageSection.Success -or -not $versionMatch.Success -or $version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw 'Cargo.toml must contain a safe package version.'
}

if (-not $SkipBuild) {
    # Keep the same local toolchain discovery and locked build as build.ps1.
    # Deliberately omit its copy to dist/FocusIsland.exe, which may be running.
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
    $targetRoot = Assert-ChildPath (Join-Path $projectRoot 'target\verified') $projectRoot
    Push-Location -LiteralPath $projectRoot
    try {
        & $cargo build --release --locked --target-dir $targetRoot
        if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }
    } finally { Pop-Location }
}
if (-not $SourceExe) { $SourceExe = Join-Path $projectRoot 'target\verified\release\focus-island.exe' }
if (-not [IO.Path]::IsPathRooted($SourceExe)) { $SourceExe = Join-Path $projectRoot $SourceExe }
$sourcePath = (Resolve-Path -LiteralPath $SourceExe -ErrorAction Stop).ProviderPath
Assert-X64Executable $sourcePath
$sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
$distItem = Get-Item -LiteralPath $distRoot
if ($distItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'dist must not be a junction or symbolic link.' }
$packageName = "FocusIsland-$version-windows-x64.zip"
$zipPath = Assert-ChildPath (Join-Path $distRoot $packageName) $distRoot
$checksumPath = Assert-ChildPath ($zipPath + '.sha256') $distRoot
$stagePath = Assert-ChildPath (Join-Path $distRoot ('.package-windows-' + [Guid]::NewGuid().ToString('N'))) $distRoot
$payloadPath = Assert-ChildPath (Join-Path $stagePath 'payload') $stagePath
$utf8 = New-Object Text.UTF8Encoding($true)
New-Item -ItemType Directory -Path $payloadPath -Force | Out-Null
try {
    $packagedExe = Assert-ChildPath (Join-Path $payloadPath 'FocusIsland.exe') $payloadPath
    Copy-Item -LiteralPath $sourcePath -Destination $packagedExe
    Assert-X64Executable $packagedExe
    if ((Get-FileHash -LiteralPath $packagedExe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sourceHash) {
        throw 'The staged executable does not match the source.'
    }
    $usage = @"
Focus Island $version · Windows x64 便携版

运行环境
Windows 10 / Windows 11，64 位 x64。
需要 Microsoft Edge WebView2 Runtime（Evergreen）；本包不内置该运行时。
缺少运行时时，从微软官方页面安装 Evergreen Runtime（x64）：
https://developer.microsoft.com/microsoft-edge/webview2/

使用
1. 完整解压 ZIP，再双击 FocusIsland.exe。无需安装应用，也不需要 Rust 开发环境。
2. 点击屏幕顶部药丸展开圆盘；右键打开功能面板，拖动顶部标题区可移动窗口。菜单包含倒计时、Webhook、手机通知和通用设置四项。
3. 在任务列表新增任务，或点击任务行的设置按钮配置该任务的结束动作。
   结束动作默认关闭，仅绑定任务；自由计时不执行命令。
4. 关闭设置只隐藏窗口；从系统托盘菜单选择“退出”结束程序。
5. 配置保存在 %APPDATA%\FocusIsland\state.json；移动或更新程序不会删除配置。
6. 在“通用设置 → 通知框”开关消息展示、配置停留时间与列表数量，或发送测试通知。新消息默认展示 5 秒后收为数量；点击数量查看列表，勾选关闭并自动补位。
7. 手机通知第一版支持 Windows + Android 8.0 及以上。另行安装 FocusIsland-Companion-android-debug.apk，允许通知访问，与电脑完成系统蓝牙配对，在手机端选择电脑并开始共享，再从本程序“功能面板 → 手机通知”启用并扫描连接。
   手机消息进入统一通知框，默认展示 5 秒后收为数量，可配置仅应用名。手机真机后台、省电和配对兼容性需实际验证；iPhone 接入尚未实现。
8. “Webhook”支持专属链接及 Bearer 鉴权，接收通用 JSON 或飞书 text 消息；只展示通知，不执行任务或命令。
   公网使用“服务器连接”：填写 HTTPS 服务地址与连接密钥后自动接收，不需要本机 SSH。服务器首次安装见 deploy/relay/README.md。
   本包附 deploy/relay 的完整中继部署资料。本机/局域网接收仍可独立开启；旧 SSH 转发资料在 deploy/webhook。

文件校验
ZIP 的 SHA256 位于随包提供的 $packageName.sha256 文件。
解压后的文件 SHA256 记录在 SHA256SUMS.txt。
在 PowerShell 中执行：
Get-FileHash -Algorithm SHA256 .\FocusIsland.exe
将 Hash 与 SHA256SUMS.txt 中 FocusIsland.exe 对应的值比较。
"@
    [IO.File]::WriteAllText((Join-Path $payloadPath '使用说明.txt'), $usage, $utf8)
    foreach ($licenseName in @('LICENSE', 'LICENSE.txt', 'LICENSE.md', 'COPYING', 'COPYING.txt')) {
        $licensePath = Join-Path $projectRoot $licenseName
        if (Test-Path -LiteralPath $licensePath -PathType Leaf) {
            Assert-RegularFile $licensePath
            Copy-Item -LiteralPath $licensePath -Destination (Join-Path $payloadPath $licenseName)
        }
    }
    # Keep deployment paths identical to the source tree so README links work.
    # Exact allowlist only: never ship deploy/webhook/.env or recurse into deploy.
    foreach ($relative in @('deploy/webhook/Caddyfile', 'deploy/webhook/compose.yml',
        'deploy/webhook/README.md', 'deploy/webhook/.env.example', 'tools/webhook-tunnel.ps1',
        'deploy/relay/server.cjs', 'deploy/relay/server.test.cjs', 'deploy/relay/init.cjs', 'deploy/relay/Dockerfile', 'deploy/relay/compose.yml', 'deploy/relay/Caddyfile', 'deploy/relay/.env.example', 'deploy/relay/.dockerignore', 'deploy/relay/README.md')) {
        $extraSource = Assert-SourcePath (Join-Path $projectRoot $relative)
        $extraHash = (Get-FileHash -LiteralPath $extraSource -Algorithm SHA256).Hash.ToLowerInvariant()
        $destination = Assert-ChildPath (Join-Path $payloadPath $relative) $payloadPath
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $extraSource -Destination $destination
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $extraHash) {
            throw "Deployment file changed during staging: $relative"
        }
    }
    $payloadPrefix = $payloadPath.TrimEnd('\') + '\'
    $records = @(
        Get-ChildItem -LiteralPath $payloadPath -Recurse -Force -File | Sort-Object FullName | ForEach-Object {
            Assert-RegularFile $_.FullName
            [PSCustomObject]@{
                Path = $_.FullName
                Name = $_.FullName.Substring($payloadPrefix.Length).Replace('\', '/')
                Hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
    )
    $manifestLines = @($records | ForEach-Object { $_.Hash + '  ' + $_.Name })
    $hashManifest = Join-Path $payloadPath 'SHA256SUMS.txt'
    [IO.File]::WriteAllLines($hashManifest, $manifestLines, $utf8)
    $records += [PSCustomObject]@{
        Path = $hashManifest
        Name = 'SHA256SUMS.txt'
        Hash = (Get-FileHash -LiteralPath $hashManifest -Algorithm SHA256).Hash.ToLowerInvariant()
    }

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $temporaryZip = Assert-ChildPath (Join-Path $stagePath $packageName) $stagePath
    # Explicit forward slashes avoid .NET Framework's Windows-only ZIP paths.
    $writer = [IO.Compression.ZipFile]::Open($temporaryZip, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($record in $records) {
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($writer, $record.Path, $record.Name, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $writer.Dispose() }
    $archive = [IO.Compression.ZipFile]::OpenRead($temporaryZip)
    try {
        $expectedNames = @($records | ForEach-Object { $_.Name })
        if ($archive.Entries.Count -ne $expectedNames.Count) { throw 'ZIP entry count does not match the staged files.' }
        foreach ($record in $records) {
            $entry = $archive.GetEntry($record.Name)
            if ($null -eq $entry) { throw "ZIP is missing $($record.Name)" }
            $entryStream = $entry.Open()
            $sha = [Security.Cryptography.SHA256]::Create()
            try {
                $entryHash = [BitConverter]::ToString($sha.ComputeHash($entryStream)).Replace('-', '').ToLowerInvariant()
            } finally { $sha.Dispose(); $entryStream.Dispose() }
            if ($entryHash -ne $record.Hash) { throw "ZIP content verification failed: $($record.Name)" }
        }
    } finally { $archive.Dispose() }
    $zipHash = (Get-FileHash -LiteralPath $temporaryZip -Algorithm SHA256).Hash.ToLowerInvariant()
    Move-Item -LiteralPath $temporaryZip -Destination $zipPath -Force
    [IO.File]::WriteAllText($checksumPath, "$zipHash  $packageName" + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    [PSCustomObject]@{
        Version = $version
        SourceExe = $sourcePath
        ExecutableSHA256 = $sourceHash
        Package = $zipPath
        PackageBytes = (Get-Item -LiteralPath $zipPath).Length
        SHA256 = $zipHash
        Checksum = $checksumPath
        Entries = $expectedNames
    } | ConvertTo-Json -Depth 3
} finally {
    # Only remove this invocation's own stage after checking its absolute boundary.
    $cleanupPath = Assert-ChildPath $stagePath $distRoot
    if ((Split-Path -Parent $cleanupPath) -ne $distRoot -or (Split-Path -Leaf $cleanupPath) -notmatch '^\.package-windows-[0-9a-f]{32}$') {
        throw 'Refusing to clean an unexpected staging directory.'
    }
    if (Test-Path -LiteralPath $cleanupPath) {
        $stageItem = Get-Item -LiteralPath $cleanupPath
        $links = @(Get-ChildItem -LiteralPath $cleanupPath -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
        if (($stageItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $links.Count -gt 0) {
            throw 'Refusing to clean a staging directory containing reparse points.'
        }
        Remove-Item -LiteralPath $cleanupPath -Recurse -Force
    }
}
