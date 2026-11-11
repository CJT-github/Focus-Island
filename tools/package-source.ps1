[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$separator = [IO.Path]::DirectorySeparatorChar
$sourcePrefix = $projectRoot.TrimEnd($separator) + $separator
$distRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'dist'))

function Assert-ChildPath([string]$Path, [string]$Parent) {
    $absolute = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the expected directory: $absolute"
    }
    return $absolute
}
function Assert-NoReparse([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Symbolic links and reparse points are excluded: $Path"
    }
    return $item
}
function Assert-SourcePath([string]$Path) {
    $absolute = Assert-ChildPath $Path $projectRoot
    $relative = $absolute.Substring($sourcePrefix.Length)
    $cursor = $projectRoot
    foreach ($part in $relative.Split(@('\', '/'), [StringSplitOptions]::RemoveEmptyEntries)) {
        $cursor = Join-Path $cursor $part
        Assert-NoReparse $cursor | Out-Null
    }
    return $absolute
}
function Get-SafeTreeFiles([string]$Root) {
    $treePath = Assert-SourcePath $Root
    $tree = Assert-NoReparse $treePath
    if (-not $tree.PSIsContainer) { throw "Expected a source directory: $Root" }
    $directories = New-Object 'System.Collections.Generic.Queue[string]'
    $directories.Enqueue($treePath)
    while ($directories.Count -gt 0) {
        $directory = $directories.Dequeue()
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
            # Check each entry before descending, not after a recursive traversal.
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Symbolic links and reparse points are excluded: $($item.FullName)"
            }
            $child = Assert-ChildPath $item.FullName $treePath
            if ($item.PSIsContainer) { $directories.Enqueue($child) } else { $item }
        }
    }
}
function Get-PackageFiles {
    # Explicit allowlist. No repository-wide recursion, build outputs, profile
    # data, verification artifacts, screenshots, logs or local toolchain caches.
    foreach ($name in @('Cargo.toml', 'Cargo.lock', 'README.md', 'PACKAGING.txt', '.gitignore')) {
        $path = Assert-SourcePath (Join-Path $projectRoot $name)
        $item = Assert-NoReparse $path
        if ($item.PSIsContainer) { throw "Expected a source file: $path" }
        $item
    }
    foreach ($directory in @('src', 'ui', '.github/workflows')) {
        Get-SafeTreeFiles (Join-Path $projectRoot $directory)
    }
    $toolsRoot = Assert-SourcePath (Join-Path $projectRoot 'tools')
    foreach ($item in Get-ChildItem -LiteralPath $toolsRoot -Force -File) {
        if ($item.Extension.ToLowerInvariant() -in @('.ps1', '.py', '.cjs')) {
            Assert-NoReparse $item.FullName | Out-Null
            $item
        }
    }
    $trayPath = Join-Path $projectRoot 'tray-icon.png'
    if (Test-Path -LiteralPath $trayPath) {
        $item = Assert-NoReparse (Assert-SourcePath $trayPath)
        if ($item.PSIsContainer) { throw 'tray-icon.png must be a file.' }
        $item
    }
}
function Assert-OutputFile([string]$Path) {
    Assert-ChildPath $Path $distRoot | Out-Null
    if (Test-Path -LiteralPath $Path) {
        $item = Assert-NoReparse $Path
        if ($item.PSIsContainer) { throw "Expected an output file: $Path" }
    }
}

Assert-NoReparse $projectRoot | Out-Null
$manifestPath = Assert-SourcePath (Join-Path $projectRoot 'Cargo.toml')
$manifest = [IO.File]::ReadAllText($manifestPath)
$packageSection = [regex]::Match($manifest, '(?ms)^\[package\]\s*\r?\n(?<body>.*?)(?=^\[|\z)')
$versionMatch = [regex]::Match($packageSection.Groups['body'].Value, '(?m)^version\s*=\s*"(?<version>[^"\r\n]+)"\s*$')
$version = $versionMatch.Groups['version'].Value
if (-not $packageSection.Success -or -not $versionMatch.Success -or
    $version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
    throw 'Cargo.toml must contain a safe package version.'
}
$sourceFiles = @(Get-PackageFiles | Sort-Object FullName)
if ($sourceFiles.Count -eq 0) { throw 'The source allowlist is empty.' }

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
Assert-NoReparse $distRoot | Out-Null
$packageName = "FocusIsland-$version-source.zip"
$zipPath = Assert-ChildPath (Join-Path $distRoot $packageName) $distRoot
$checksumPath = Assert-ChildPath ($zipPath + '.sha256') $distRoot
Assert-OutputFile $zipPath
Assert-OutputFile $checksumPath
$stagePath = Assert-ChildPath (Join-Path $distRoot ('.package-source-' + [Guid]::NewGuid().ToString('N'))) $distRoot
$payloadPath = Assert-ChildPath (Join-Path $stagePath 'payload') $stagePath
$records = New-Object 'System.Collections.Generic.List[object]'

try {
    New-Item -ItemType Directory -Path $payloadPath -Force | Out-Null
    foreach ($source in $sourceFiles) {
        $sourcePath = Assert-SourcePath $source.FullName
        $relative = $sourcePath.Substring($sourcePrefix.Length)
        $destination = Assert-ChildPath (Join-Path $payloadPath $relative) $payloadPath
        $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $destination
        $copiedHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($sourceHash -ne $copiedHash) { throw "Source changed during staging: $relative" }
        $records.Add([PSCustomObject]@{ Source = $sourcePath; Name = $relative.Replace('\', '/'); Hash = $sourceHash })
    }

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $temporaryZip = Assert-ChildPath (Join-Path $stagePath $packageName) $stagePath
    # Explicit '/' entry names keep the project portable to macOS and GitHub,
    # including older Windows PowerShell/.NET Framework hosts.
    $writer = [IO.Compression.ZipFile]::Open($temporaryZip, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($record in $records) {
            $stagedFile = Assert-ChildPath (Join-Path $payloadPath $record.Name) $payloadPath
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($writer, $stagedFile, $record.Name, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $writer.Dispose() }
    $archive = [IO.Compression.ZipFile]::OpenRead($temporaryZip)
    try {
        # Some .NET Framework versions use backslashes in ZIP entry names.
        $entries = @{}
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if ($entries.ContainsKey($name)) { throw "Duplicate ZIP entry: $name" }
            $entries[$name] = $entry
        }
        if ($entries.Count -ne $records.Count) { throw 'ZIP entry count differs from the source allowlist.' }
        foreach ($record in $records) {
            if (-not $entries.ContainsKey($record.Name)) { throw "ZIP is missing $($record.Name)" }
            $stream = $entries[$record.Name].Open()
            $sha = [Security.Cryptography.SHA256]::Create()
            try {
                $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
            } finally { $sha.Dispose(); $stream.Dispose() }
            if ($hash -ne $record.Hash) { throw "ZIP/source hash mismatch: $($record.Name)" }
        }
    } finally { $archive.Dispose() }

    # Fail rather than ship a mixed snapshot if a developer edited source while
    # this package was being assembled. The previous final ZIP stays untouched.
    $finalFiles = @(Get-PackageFiles | Sort-Object FullName)
    if (($finalFiles.FullName -join "\n") -ne ($sourceFiles.FullName -join "\n")) {
        throw 'The source allowlist changed during packaging. Retry after edits finish.'
    }
    foreach ($record in $records) {
        if ((Get-FileHash -LiteralPath $record.Source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $record.Hash) {
            throw "Source changed during packaging: $($record.Name)"
        }
    }
    $zipHash = (Get-FileHash -LiteralPath $temporaryZip -Algorithm SHA256).Hash.ToLowerInvariant()
    Move-Item -LiteralPath $temporaryZip -Destination $zipPath -Force
    [IO.File]::WriteAllText($checksumPath, "$zipHash  $packageName" + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    [PSCustomObject]@{
        Version = $version
        Package = $zipPath
        PackageBytes = (Get-Item -LiteralPath $zipPath).Length
        SHA256 = $zipHash
        Checksum = $checksumPath
        FileCount = $records.Count
        Entries = @($records | ForEach-Object { $_.Name })
    } | ConvertTo-Json -Depth 3
} finally {
    $cleanupPath = Assert-ChildPath $stagePath $distRoot
    if ((Split-Path -Parent $cleanupPath) -ne $distRoot -or
        (Split-Path -Leaf $cleanupPath) -notmatch '^\.package-source-[0-9a-f]{32}$') {
        throw 'Refusing to clean an unexpected staging directory.'
    }
    if (Test-Path -LiteralPath $cleanupPath) {
        Assert-NoReparse $cleanupPath | Out-Null
        $links = @(Get-ChildItem -LiteralPath $cleanupPath -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
        if ($links.Count -gt 0) { throw 'Refusing to clean a staging directory containing reparse points.' }
        Remove-Item -LiteralPath $cleanupPath -Recurse -Force
    }
}
