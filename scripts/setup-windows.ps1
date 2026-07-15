# setup-windows.ps1 — Iron Device Simulator 개발 환경 세팅 (Windows)
#
#   .\scripts\setup-windows.ps1              # 네이티브 Windows + Git Bash (기본)
#   .\scripts\setup-windows.ps1 -Target WSL  # WSL2(Ubuntu)로 위임 (scripts/setup-wsl.sh)
#
# 이 리포의 빌드 스크립트(wasm:build, build:desktop, build:electron ...)는 전부
# bash(#!/usr/bin/env bash)라 cmd/PowerShell에서 곧바로 실행되지 않는다.
#   - Native: Git for Windows의 bash.exe를 npm의 script-shell로 지정해 그대로 재사용한다.
#   - WSL:    WSL2 Ubuntu 안에서 scripts/setup-wsl.sh(Linux와 동일 절차)를 실행한다.
[CmdletBinding()]
param(
  [ValidateSet("Native", "WSL")]
  [string]$Target = "Native"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

function Write-Step($msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "   !!  $msg" -ForegroundColor Yellow }

# =============================================================================
if ($Target -eq "WSL") {
  Write-Step "WSL2 경로로 위임합니다"

  $wslInstalled = $false
  try {
    wsl --status *> $null
    if ($LASTEXITCODE -eq 0) { $wslInstalled = $true }
  } catch { $wslInstalled = $false }

  if (-not $wslInstalled) {
    Write-Warn "WSL2가 설치되어 있지 않습니다. 관리자 PowerShell에서 'wsl --install' 실행 후 재부팅하고 다시 시도하세요."
    exit 1
  }

  # C:\path\to\repo -> /mnt/c/path/to/repo
  $wslPath = (wsl wslpath -a "$RepoRoot").Trim()
  Write-Ok "WSL 경로: $wslPath"

  wsl bash -lc "bash '$wslPath/scripts/setup-wsl.sh'"
  exit $LASTEXITCODE
}

# =============================================================================
# Native Windows + Git Bash 경로
# =============================================================================

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

if (-not (Test-Command "winget")) {
  Write-Warn "winget이 없습니다. Microsoft Store에서 'App Installer'를 설치한 뒤 다시 실행하세요."
  exit 1
}

# ---------------------------------------------------------------------------
Write-Step "1/6 Git for Windows 확인 (Git Bash 필요 — bash 빌드 스크립트 실행용)"
if (Test-Command "git") {
  Write-Ok (git --version)
} else {
  Write-Warn "Git이 없어 설치합니다 (winget install Git.Git)"
  winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
  Write-Warn "설치 후 PATH 반영을 위해 이 터미널을 닫고 새로 열어 스크립트를 다시 실행하세요."
  exit 0
}

$GitBash = Join-Path (Split-Path (Split-Path (Get-Command git).Source)) "bin\bash.exe"
if (-not (Test-Path $GitBash)) {
  # 일반적인 설치 경로 fallback
  $candidates = @(
    "$Env:ProgramFiles\Git\bin\bash.exe",
    "${Env:ProgramFiles(x86)}\Git\bin\bash.exe"
  )
  $GitBash = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $GitBash) {
  Write-Warn "Git Bash(bash.exe)를 찾지 못했습니다. Git for Windows 설치를 확인하세요."
  exit 1
}
Write-Ok "Git Bash: $GitBash"

# ---------------------------------------------------------------------------
Write-Step "2/6 Node.js 20+ 확인"
$needNode = $true
if (Test-Command "node") {
  $nodeMajor = [int]((node -v) -replace '^v(\d+).*', '$1')
  if ($nodeMajor -ge 20) {
    Write-Ok "$(node -v) / npm $(npm -v)"
    $needNode = $false
  } else {
    Write-Warn "Node $(node -v) 는 20 미만입니다 — LTS로 갱신합니다."
  }
}
if ($needNode) {
  winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
  Write-Warn "설치 후 PATH 반영을 위해 이 터미널을 닫고 새로 열어 스크립트를 다시 실행하세요."
  exit 0
}

# ---------------------------------------------------------------------------
Write-Step "3/6 npm script-shell을 Git Bash로 설정 (npm run wasm:build / build:* 가 bash 스크립트를 실행하려면 필요)"
$currentShell = (npm config get script-shell 2>$null)
if ($currentShell -eq $GitBash) {
  Write-Ok "이미 설정됨: $GitBash"
} else {
  npm config set script-shell "$GitBash"
  Write-Ok "설정 완료: $GitBash"
}

# ---------------------------------------------------------------------------
Write-Step "4/6 Emscripten (emcc) 확인 — WASM 엔진 빌드에 필요"
$EmsdkDir = Join-Path $Env:USERPROFILE "emsdk"
$emccOnPath = Test-Command "emcc"

if ($emccOnPath) {
  Write-Ok (emcc --version | Select-Object -First 1)
} else {
  if (-not (Test-Path $EmsdkDir)) {
    Write-Warn "emsdk 클론: $EmsdkDir"
    git clone https://github.com/emscripten-core/emsdk.git $EmsdkDir
  }
  Push-Location $EmsdkDir
  try {
    .\emsdk.bat install latest
    .\emsdk.bat activate latest --permanent
  } finally {
    Pop-Location
  }
  Write-Warn "emsdk를 PATH에 영구 등록했습니다. 이 터미널을 닫고 새로 열어야 'emcc'가 인식됩니다."
  Write-Warn "새 터미널에서 이 스크립트를 다시 실행하면 나머지 단계(npm install, wasm:build)를 이어서 진행합니다."
  exit 0
}

# ---------------------------------------------------------------------------
Write-Step "5/6 npm install"
npm install
Write-Ok "의존성 설치 완료"

# ---------------------------------------------------------------------------
Write-Step "6/6 WASM 엔진 빌드 (public/wasm/ff_prot.{js,wasm})"
npm run wasm:build
Write-Ok "WASM 빌드 완료"

# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "✓ 셋업 완료: $RepoRoot" -ForegroundColor Green
Write-Host @"

다음 단계:
  npm run dev              # http://localhost:3000 (브라우저 WASM 엔진)
  npm run build:desktop    # 정적 번들 (out/)
  npm run build:electron   # Electron 패키징 (dist-electron/windows/*.zip — 포터블)
                            #   Windows 호스트에서는 macOS 패키징 단계를 자동으로 건너뜁니다
                            #   (CoreAudio 헬퍼 컴파일에 swiftc/macOS가 필요하기 때문)

참고:
  - macOS 전용 네이티브 오디오 캡처(window.audioDevice/audioCapture, CoreAudio 헬퍼)는
    Windows 빌드에 포함되지 않습니다 — 실시간 마이크는 브라우저 getUserMedia로 동작하고,
    장치별 SampleRate/Buffer 세부 설정은 아직 macOS 전용입니다 (docs/windows-plan.md 참고).
  - 파일 업로드 분석은 모든 플랫폼에서 동일하게 동작합니다.
  - mac용 .dmg/.zip까지 한 번에 만들려면 macOS 호스트에서 npm run build:electron을
    실행하세요 (Windows/Linux 산출물도 그 호스트에서 함께 크로스 빌드됩니다).
"@
