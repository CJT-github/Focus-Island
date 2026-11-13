param(
    [string]$JdkPath = $env:JAVA_HOME,
    [switch]$AcceptSdkLicense,
    [string[]]$Tasks = @('testDebugUnitTest', 'lintDebug', 'assembleDebug')
)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$toolRoot = Join-Path $projectRoot '.tools'
$sdkRoot = Join-Path $projectRoot '.android-sdk'
$gradleVersion = '8.13'
$gradleSha = '20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78'
$sdkZipName = 'commandlinetools-win-15859902_latest.zip'
$sdkSha = '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a'
if (!$JdkPath) {
    $candidate = 'C:\Program Files\Eclipse Adoptium\jdk-17.0.20.8-hotspot'
    if (Test-Path -LiteralPath (Join-Path $candidate 'bin\java.exe')) { $JdkPath = $candidate }
}
if (!$JdkPath -or !(Test-Path -LiteralPath (Join-Path $JdkPath 'bin\java.exe'))) {
    throw 'JDK 17 is required. Pass -JdkPath or set JAVA_HOME for this shell.'
}
New-Item -ItemType Directory -Force -Path $toolRoot | Out-Null

function Get-VerifiedArchive([string]$Url, [string]$Path, [string]$Sha256) {
    $valid = (Test-Path -LiteralPath $Path) -and ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ieq $Sha256)
    if (!$valid) {
        Write-Host "Downloading $Url"
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path
    }
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ine $Sha256) {
        throw "Checksum mismatch: $Path"
    }
}
$oldEnvironment = @{}
foreach ($key in @('JAVA_HOME', 'ANDROID_HOME', 'ANDROID_USER_HOME', 'GRADLE_USER_HOME', 'PATH')) {
    $oldEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}
try {
    $env:JAVA_HOME = $JdkPath
    $env:ANDROID_HOME = $sdkRoot
    $env:ANDROID_USER_HOME = Join-Path $projectRoot '.android-user-home'
    $env:GRADLE_USER_HOME = Join-Path $projectRoot '.gradle-user-home'
    $env:PATH = (Join-Path $JdkPath 'bin') + ';' + $env:PATH
    $gradleZip = Join-Path $toolRoot "gradle-$gradleVersion-bin.zip"
    Get-VerifiedArchive "https://services.gradle.org/distributions/gradle-$gradleVersion-bin.zip" $gradleZip $gradleSha
    $gradle = Join-Path $toolRoot "gradle-$gradleVersion\bin\gradle.bat"
    if (!(Test-Path -LiteralPath $gradle)) { Expand-Archive -LiteralPath $gradleZip -DestinationPath $toolRoot -Force }
    $sdkManager = Join-Path $sdkRoot 'cmdline-tools\cmdline-tools\bin\sdkmanager.bat'
    if (!(Test-Path -LiteralPath $sdkManager)) {
        $sdkZip = Join-Path $toolRoot $sdkZipName
        Get-VerifiedArchive "https://dl.google.com/android/repository/$sdkZipName" $sdkZip $sdkSha
        Expand-Archive -LiteralPath $sdkZip -DestinationPath (Join-Path $sdkRoot 'cmdline-tools') -Force
    }
    $packages = @('platforms;android-36', 'build-tools;35.0.0', 'platform-tools')
    if ($AcceptSdkLicense) {
        # Explicit opt-in for unattended development/CI. Licenses stay inside this project SDK.
        1..20 | ForEach-Object { 'y' } | & $sdkManager "--sdk_root=$sdkRoot" @packages
    } else {
        & $sdkManager "--sdk_root=$sdkRoot" @packages
    }
    if ($LASTEXITCODE -ne 0) { throw "Android SDK setup failed: $LASTEXITCODE" }
    & $gradle -p $projectRoot --no-daemon --console=plain @Tasks
    if ($LASTEXITCODE -ne 0) { throw "Gradle failed: $LASTEXITCODE" }
    Write-Host "APK: $(Join-Path $projectRoot 'app\build\outputs\apk\debug\app-debug.apk')"
} finally {
    foreach ($key in $oldEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($key, $oldEnvironment[$key], 'Process')
    }
}
