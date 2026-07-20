# build.ps1 — audio-device-helper (Windows/ASIO) 빌드
#
# macOS 쪽 build-mac.sh와 대칭. 산출물은 dist/audio-device-helper.exe 하나다.
#
#   .\build.ps1                          # third_party/ASIOSDK 또는 $env:ASIOSDK_DIR 사용
#   .\build.ps1 -AsioSdkDir D:\ASIOSDK   # SDK 위치 직접 지정
#   .\build.ps1 -Arch Win32              # 32비트 (기본은 x64)
#
# 요구사항: Visual Studio 2019+ (C++ 데스크톱 워크로드), CMake 3.15+
#
# ⚠️ 비트수를 맞춰야 한다. 64비트 헬퍼는 64비트 ASIO 드라이버만 열거·오픈할 수 있다.
#    Electron이 x64이므로 기본값 x64를 유지하는 게 맞다.
[CmdletBinding()]
param(
  [string]$AsioSdkDir = $env:ASIOSDK_DIR,
  [ValidateSet('x64', 'Win32')]
  [string]$Arch = 'x64',
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$buildDir = Join-Path $root "build-$Arch"

if (-not $AsioSdkDir) {
  $AsioSdkDir = Join-Path $root 'third_party\ASIOSDK'
}

if (-not (Test-Path (Join-Path $AsioSdkDir 'common\asio.h'))) {
  Write-Error @"
ASIO SDK를 찾지 못했습니다: $AsioSdkDir

Steinberg ASIO SDK 2.3을 받아 common\ 과 host\ 가 보이도록 풀어주세요.
SDK는 재배포가 금지돼 리포에 포함되지 않습니다. 다음 중 하나로 지정합니다:

  .\build.ps1 -AsioSdkDir <경로>
  `$env:ASIOSDK_DIR = '<경로>'
  또는 $root\third_party\ASIOSDK 에 배치
"@
}

if ($Clean -and (Test-Path $buildDir)) {
  Write-Host "정리: $buildDir"
  Remove-Item -Recurse -Force $buildDir
}

Write-Host "ASIO SDK : $AsioSdkDir"
Write-Host "아키텍처 : $Arch"

cmake -S $root -B $buildDir -A $Arch "-DASIO_SDK_DIR=$AsioSdkDir"
if ($LASTEXITCODE -ne 0) { Write-Error "CMake 구성 실패" }

cmake --build $buildDir --config Release
if ($LASTEXITCODE -ne 0) { Write-Error "빌드 실패" }

$exe = Join-Path $root 'dist\audio-device-helper.exe'
if (-not (Test-Path $exe)) { Write-Error "산출물이 없습니다: $exe" }

Write-Host ""
Write-Host "완료: $exe" -ForegroundColor Green
Write-Host ""
Write-Host "확인:" -ForegroundColor Cyan
Write-Host "  .\dist\audio-device-helper.exe list"
Write-Host "  .\dist\audio-device-helper.exe query --device `"{CLSID}`""
