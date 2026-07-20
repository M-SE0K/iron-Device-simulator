// audio_backend.h — 오디오 백엔드 추상 경계.
//
// main.cpp는 CLI 계약(argv 파싱 / JSON 출력 / 종료 코드)만 담당하고, 실제 장치 접근은
// 전부 이 인터페이스 뒤에 둔다. 현재 구현체는 asio_backend.cpp 하나뿐이지만, ASIO
// 드라이버가 설치되지 않은 Windows PC를 위한 wasapi_backend.cpp를 나중에 파일 추가만으로
// 붙이려면 지금 경계를 그어두는 편이 싸다.
//
// macOS(mac.swift)와는 소스를 공유하지 않는다 — 공유되는 것은 CLI 계약뿐이다.
// (electron/native/macos/audio-device-helper/README.md 의 "명령어" 절이 단일 진실원)
#pragma once

#include <string>
#include <vector>

namespace audio {

// list 항목 하나. macOS의 AudioInputDevice(electron-bridge.d.ts)와 키가 일치해야 한다.
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

}  // namespace audio
