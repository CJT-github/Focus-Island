#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$')]
    [string]$Server,
    [ValidatePattern('^$|^[A-Za-z_][A-Za-z0-9_.-]{0,63}$')]
    [string]$User,
    [ValidateRange(1,65535)][int]$SshPort = 22,
    [ValidateRange(1024,65535)][int]$LocalPort = 17891,
    [ValidateRange(1024,65535)][int]$RemotePort = 17892,
    [string]$IdentityFile,
    [switch]$Reconnect
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$sshCommand = Get-Command ssh.exe -ErrorAction SilentlyContinue
if (-not $sshCommand) { throw '未找到 OpenSSH 客户端。请先安装 Windows 可选功能中的 OpenSSH 客户端。' }
$destination = if ($User) { "$User@$Server" } else { $Server }
$forwardSpec = '127.0.0.1:{0}:127.0.0.1:{1}' -f $RemotePort,$LocalPort
$sshArguments = @(
    '-N', '-T', '-n',
    '-p', [string]$SshPort,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'LogLevel=ERROR',
    '-R', $forwardSpec
)
if ($IdentityFile) {
    $keyPath = (Resolve-Path -LiteralPath $IdentityFile -ErrorAction Stop).ProviderPath
    if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) { throw 'IdentityFile 必须是现有私钥文件的本机路径。' }
    $sshArguments += @('-i', $keyPath, '-o', 'IdentitiesOnly=yes')
}
$sshArguments += $destination
Write-Host "Focus Island 公网连接：服务器 127.0.0.1:$RemotePort -> 本机 127.0.0.1:$LocalPort"
Write-Host '请保持 Focus Island Webhook 已开启；按 Ctrl+C 断开。'
Write-Host '首次使用前，请手动通过 SSH 核对服务器指纹并完成公钥登录。此脚本不会跳过指纹校验或索取密码。'
$attempt = 0
do {
    & $sshCommand.Source @sshArguments
    $sshExit = $LASTEXITCODE
    if (-not $Reconnect -or $sshExit -eq 0) {
        if ($sshExit -ne 0) { throw "SSH 隧道退出（$sshExit）。请检查公钥、服务器指纹、端口转发权限及服务端端口占用。" }
        break
    }
    $attempt++
    $pause = [Math]::Min(60, 5 * $attempt)
    Write-Warning "SSH 连接中断，$pause 秒后重连；按 Ctrl+C 停止。"
    Start-Sleep -Seconds $pause
} while ($Reconnect)
