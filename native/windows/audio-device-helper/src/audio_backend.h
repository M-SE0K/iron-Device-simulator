// audio_backend.h — 오디오 백엔드 추상 경계.
//
// main.cpp는 CLI 계약(argv 파싱 / JSON 출력 / 종료 코드)만 담당하고, 실제 장치 접근은
// 전부 이 인터페이스 뒤에 둔다. 현재 구현체는 asio_backend.cpp 하나뿐이지만, ASIO
// 드라이버가 설치되지 않은 Windows PC를 위한 wasapi_backend.cpp를 나중에 파일 추가만으로
// 붙이려면 지금 경계를 그어두는 편이 싸다.
//
// macOS(mac.swift)와는 소스를 공유하지 않는다 — 공유되는 것은 CLI 계약뿐이다.
// (native/macos/audio-device-helper/README.md 의 "명령어" 절이 단일 진실원)
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace audio {

// list 항목 하나. macOS의 AudioInputDevice(native-bridge.d.ts)와 키가 일치해야 한다.
struct DeviceInfo {
  std::string uid;          // ASIO는 CLSID 문자열 "{...}" — 이름보다 안정적이라 uid로 쓴다
  std::string name;         // 레지스트리 표시 이름
  long inputChannels = 0;   // probed=false면 0 (드라이버를 열지 못한 것)
  double sampleRate = 0;    // probed=false면 0 → JSON에서 null
  bool isDefault = false;   // ASIO엔 OS 기본 장치 개념이 없다 — 첫 항목에만 true
  bool probed = false;      // 드라이버를 실제로 열어 능력을 읽었는지
};

// query 응답. macOS 대비 bufferPreferred/bufferGranularity/latency가 추가 키다
// (가산이라 계약 호환). set 응답의 applied 키는 이쪽이 아니라 DeviceState 경로에 있다.
struct DeviceCaps {
  std::string name;
  std::string uid;
  double sampleRate = 0;
  long bufferSize = 0;              // 드라이버 preferred — ASIO의 "현재값"에 해당
  std::vector<double> supportedSampleRates;
  long bufferMin = 0;
  long bufferMax = 0;
  long bufferPreferred = 0;
  long bufferGranularity = 0;       // -1이면 2의 거듭제곱만 허용
  long inputChannels = 0;
  long outputChannels = 0;
  long inputLatency = 0;
  long outputLatency = 0;
};

// get / set 공통 응답.
struct DeviceState {
  std::string name;
  std::string uid;
  double sampleRate = 0;
  long bufferSize = 0;
};

// 모든 함수는 성공 시 true, 실패 시 false를 돌려주고 error에 사유를 채운다.
// error 문자열은 macOS 헬퍼의 관례를 따른다 (no-asio-driver, device-not-found(...) 등).
//
// deviceUid가 비어 있으면 "기본 장치" — ASIO에는 OS 기본 개념이 없으므로 레지스트리
// 첫 번째 드라이버를 쓴다.

bool listDevices(std::vector<DeviceInfo>& out, bool probe, std::string& error);
bool queryDevice(const std::string& deviceUid, DeviceCaps& out, std::string& error);
bool getDevice(const std::string& deviceUid, DeviceState& out, std::string& error);

// setDevice — 요청한 sampleRate를 드라이버에 적용하고, bufferSize는 드라이버가 허용하는
// 격자에 스냅해서 돌려준다.
//
// ⚠️ ASIO에서 이 두 값은 프로세스가 끝나면 유지되지 않는다. CoreAudio는 NominalSampleRate가
// 장치에 남지만 ASIO는 드라이버 릴리스와 함께 되돌아간다. 그래서 응답에 persisted:false를
// 실어 보내고, 실제 적용 지점은 capture 모드다. (README "set의 한계" 참고)
bool setDevice(const std::string& deviceUid, double sampleRate, long bufferSize,
               DeviceState& out, std::string& error);

// 드라이버가 허용하는 버퍼 크기 격자로 스냅한다.
// granularity == -1  → 2의 거듭제곱만 허용
// granularity  >  0  → min + k*granularity
// 그 외              → preferred 고정
// CoreAudio처럼 단순 클램프하면 드라이버가 거부하므로 반드시 격자에 맞춰야 한다.
long snapBufferSize(long requested, long minSize, long maxSize, long preferred, long granularity);

// ── capture (상주 모드) ──────────────────────────────────────────────────────
//
// 일회성 명령들과 달리 드라이버를 열어둔 채 유지한다. 프로세스당 하나만 가능하다
// (ASIO는 전역 theAsioDriver 하나에 묶인다 — asio_backend.cpp 상단 주석).
//
// 역할 분담: 이 백엔드는 ASIO RT 스레드에서 링버퍼까지만 채우고, stdout으로 내보내는
// writer 스레드와 stdin 감시는 main.cpp가 돌린다. RT 스레드에서 fwrite하면 파이프가
// 찼을 때 블로킹되어 그대로 드롭아웃이기 때문이다.

struct CaptureConfig {
  std::string deviceUid;
  double sampleRate = 0;
  long bufferSize = 0;   // 드라이버 격자로 스냅된다 — 요청값 그대로 쓰이지 않는다
  long channels = 2;     // stdout 인터리브 채널 수 요청값

  // ── play-capture 전용 (refPath가 비어 있으면 순수 capture 모드) ──
  //
  // ASIO가 CoreAudio보다 유리한 유일한 지점이다. 콜백 하나가 입출력을 동시에 다루므로
  // 재생과 캡처가 같은 클록 위에 놓이는 게 구조적으로 보장된다 — IOProc 두 개를 맞출
  // 필요가 없다.
  std::string refPath;   // raw LE Float32, [-1,1], sampleRate로 미리 리샘플된 것
  long outputChannel = 0;
  long refChannels = 1;      // --ref 파일의 채널 수 — 2면 인터리브 스테레오([L0,R0,L1,R1,...])로 해석해 L/R 분리
  long outputChannelR = -1;  // R을 내보낼 출력 채널 — -1이면 스테레오 미요청(모노만 재생)
};

// 헤더 한 줄에 실을 실제 값. requested와 달라질 수 있고, 달라지는 게 정상이다.
struct CaptureInfo {
  std::string name;
  std::string uid;
  double sampleRate = 0;
  long bufferSize = 0;
  long channels = 0;     // 장치 입력 수로 클램프된 실제 인터리브 채널 수

  bool playCapture = false;
  long refFrames = 0;        // ref 총 프레임 수 — 렌더러가 재생 길이를 안다
  long playbackChannel = 0;  // 실제 사용된 L 출력 채널 (--out-ch echo)
  long playbackChannelR = -1; // 실제 사용된 R 출력 채널 — 범위 밖/L과 중복으로 모노 폴백되면 -1
};

// 드라이버를 열고 ASIOStart까지 마친다. 성공 시 콜백이 이미 링을 채우고 있다.
// 실패 시 열린 자원을 전부 되돌리므로 호출 측은 정리할 게 없다.
bool startCapture(const CaptureConfig& cfg, CaptureInfo& out, std::string& error);

// writer 스레드 전용. 링에 있는 만큼만 꺼내 실제 바이트 수를 돌려준다(0이면 빔).
// ⚠️ stopCapture()와 동시에 부르면 안 된다 — main.cpp는 writer를 join한 뒤에 stop한다.
size_t readCaptured(void* dst, size_t maxBytes);

// kAsioResetRequest(USB 분리 등)가 왔는지. RT 컨텍스트에서 정리하면 데드락이라
// 콜백은 플래그만 세우고, main 스레드가 이걸 폴링해 exit 3으로 빠진다.
bool captureResetRequested();

// ── play-capture 제어 (stdin 라인 명령이 호출) ───────────────────────────────

// pause 중에도 **캡처는 계속 흐른다** — 출력만 무음이 되고 재생 위치가 동결된다.
// WASM 온도 상태를 유지하려면 세션을 끊으면 안 되기 때문이다(macOS README와 동일 설계).
void setPlaybackPaused(bool paused);

// ref를 끝까지 재생하고 감쇠 테일까지 지났는지. main 스레드가 폴링해 exit 0으로 자기 종료한다.
bool playbackFinished();

// 링이 가득 차 **버려진** 누적 바이트. 종료 시 stderr에 남겨 드롭아웃을 진단한다.
uint64_t captureDroppedBytes();

// ASIOStop → ASIODisposeBuffers → ASIOExit → removeCurrentDriver. main 스레드 전용(COM).
void stopCapture();

}  // namespace audio
