# audio-device-helper (Windows/ASIO) — MSVC 보조 빌드
#
# 정식 빌드는 상위 폴더의 build-win.sh(mingw 크로스 컴파일)다. 이 CMakeLists.txt와 나란히
# 있는 build.ps1은 Windows에서 MSVC로 직접 빌드해야 할 때만 쓰는 보조 경로다.
# 소스는 상위 ../src/, SDK 기본값은 ../third_party/, 산출물은 ../dist/ (모두 헬퍼 루트 공유).
#
# 산출물: ../dist/audio-device-helper.exe
#   electron/ipc/audio-device.js 의 AUDIO_HELPER_PATH(dev 폴백)와 electron-builder.yml 의
#   win extraResources가 이 경로/이름 규칙을 전제한다. 바꾸면 양쪽을 같이 고쳐야 한다.
#
# ASIO SDK는 재배포가 금지돼 리포에 커밋하지 않는다. 빌드하는 사람이 직접 배치하고
# 아래 ASIO_SDK_DIR로 위치를 알려준다 (build.ps1이 환경변수 ASIOSDK_DIR도 읽는다).
cmake_minimum_required(VERSION 3.15)
project(audio-device-helper CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT WIN32)
  message(FATAL_ERROR "이 헬퍼는 Windows 전용이다 (ASIO = COM). macOS는 native/macos/ 쪽 Swift 헬퍼를 쓴다.")
endif()

# --- ASIO SDK 위치 ------------------------------------------------------------
set(ASIO_SDK_DIR "$ENV{ASIOSDK_DIR}" CACHE PATH "Steinberg ASIO SDK 2.3 루트 (common/, host/ 를 포함하는 폴더)")
if(NOT ASIO_SDK_DIR)
  # 헬퍼 루트(../)의 third_party/ 를 build-win.sh와 공유한다.
  set(ASIO_SDK_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/ASIOSDK")
endif()

if(NOT EXISTS "${ASIO_SDK_DIR}/common/asio.h")
  message(FATAL_ERROR
    "ASIO SDK를 찾지 못했다: ${ASIO_SDK_DIR}\n"
    "  Steinberg ASIO SDK 2.3을 받아 common/ host/ 가 보이도록 풀고,\n"
    "  -DASIO_SDK_DIR=<경로> 또는 환경변수 ASIOSDK_DIR로 지정한다.")
endif()

add_executable(audio-device-helper
  ../src/main.cpp
  ../src/asio_backend.cpp
  # --- SDK에서 끌어오는 host 측 소스 3개 -------------------------------------
  # ASIO SDK는 라이브러리로 빌드해 링크하는 물건이 아니라 소스를 직접 컴파일해 넣는 구조다.
  # driver/ 밑(asiodrvr, dllentry, combase, register)은 ASIO 드라이버를 *만들* 때 쓰는
  # 것이라 호스트인 우리는 절대 포함하면 안 된다 — 넣으면 DllMain 등이 딸려와 링크가 깨진다.
  "${ASIO_SDK_DIR}/common/asio.cpp"          # ASIOxxx() 자유 함수 (전역 theAsioDriver)
  "${ASIO_SDK_DIR}/host/asiodrivers.cpp"     # AsioDrivers, 전역 asioDrivers, loadAsioDriver()
  "${ASIO_SDK_DIR}/host/pc/asiolist.cpp"     # 레지스트리 열거 + CoCreateInstance
)

target_include_directories(audio-device-helper PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/../src"
  "${ASIO_SDK_DIR}/common"
  "${ASIO_SDK_DIR}/host"
  "${ASIO_SDK_DIR}/host/pc"
)

# WINDOWS/MAC 매크로는 asiosys.h가 _WIN32/_WIN64를 보고 스스로 정의한다 — 수동 정의 금지
# (직접 -DWINDOWS=1 을 주면 asiosys.h의 분기와 충돌한다).
target_link_libraries(audio-device-helper PRIVATE ole32 oleaut32 uuid user32 advapi32)

if(MSVC)
  target_compile_options(audio-device-helper PRIVATE /W3 /permissive-)
  # SDK 소스가 90년대 코드라 strcpy/sprintf 경고가 쏟아진다. 우리 코드의 경고를 가리므로 끈다.
  target_compile_definitions(audio-device-helper PRIVATE _CRT_SECURE_NO_WARNINGS)
  # 정적 CRT. electron-builder가 exe만 리소스로 복사하므로 VC++ 재배포 패키지에
  # 의존하면 사용자 PC에서 실행이 실패한다.
  set_property(TARGET audio-device-helper PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

# 빌드 타입과 무관하게 헬퍼 루트의 ../dist/ 한 곳으로 떨군다 — build-win.sh·macOS dist/ 규칙과 대칭.
set_target_properties(audio-device-helper PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY         "${CMAKE_CURRENT_SOURCE_DIR}/../dist"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG   "${CMAKE_CURRENT_SOURCE_DIR}/../dist"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_SOURCE_DIR}/../dist"
)
