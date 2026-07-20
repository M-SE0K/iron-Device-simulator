// asio_backend.cpp — audio_backend.h의 ASIO(Steinberg SDK 2.3) 구현.
//
// ASIO 특유의 제약이 이 파일 전체 구조를 규정한다:
//
//  1. 프로세스당 드라이버 하나, 배타적. SDK의 ASIOxxx()는 전역 theAsioDriver 하나에
//     묶인 자유 함수라 동시에 두 드라이버를 열 수 없다. → DriverSession(RAII)으로
//     "열고-읽고-즉시 닫기"를 강제한다.
//  2. 능력(채널 수·샘플레이트)은 드라이버를 열어야만 알 수 있다. 레지스트리에는 이름과
//     CLSID뿐이다. → list의 probe는 실패를 허용한다(다른 앱이 점유 중일 수 있음).
//  3. COM. 드라이버는 CoCreateInstance로 만들어지고, 만든 스레드에서 해제해야 한다.
//     → 이 파일의 모든 호출은 main 스레드 전용이다.
#include "audio_backend.h"

#include <windows.h>

#include <cstring>
#include <cstdlib>

#include "asiosys.h"
#include "asio.h"
#include "asiodrivers.h"

// asiodrivers.cpp가 정의하는 전역. asio.cpp의 ASIOxxx()가 이걸 통해 드라이버에 닿는다.
extern AsioDrivers* asioDrivers;
bool loadAsioDriver(char* name);

namespace audio {
namespace {

// ASIOCanSampleRate로 하나씩 두드려볼 후보. ASIO엔 "지원 목록 조회" API가 없어서
// 프로브 외에 방법이 없다. macOS 헬퍼가 돌려주는 목록과 같은 범위를 덮는다.
const double kProbeRates[] = {
    8000, 11025, 16000, 22050, 32000, 44100, 48000,
    64000, 88200, 96000, 176400, 192000, 352800, 384000,
};

std::string clsidToString(const CLSID& clsid) {
  wchar_t wide[64] = {0};
  if (StringFromGUID2(clsid, wide, 64) == 0) return std::string();
  char narrow[64] = {0};
  WideCharToMultiByte(CP_UTF8, 0, wide, -1, narrow, sizeof(narrow), nullptr, nullptr);
  return std::string(narrow);
}

// 드라이버 목록은 전역 asioDrivers 하나를 재사용한다 — AsioDriverList 생성자가
// CoInitialize와 레지스트리 스캔을 하므로 매번 새로 만들 이유가 없다.
AsioDrivers* drivers() {
  if (!asioDrivers) asioDrivers = new AsioDrivers();
  return asioDrivers;
}

// uid(CLSID 문자열)로 드라이버 인덱스를 찾는다. uid가 비어 있으면 0번(= "기본 장치").
// ASIO엔 OS 기본 입력 개념이 없어서 레지스트리 첫 항목을 기본으로 삼는 정책이다.
bool resolveIndex(const std::string& uid, int& outIndex, std::string& error) {
  AsioDrivers* d = drivers();
  const long count = d->asioGetNumDev();
  if (count <= 0) {
    error = "no-asio-driver";
    return false;
  }
  if (uid.empty()) {
    outIndex = 0;
    return true;
  }
  for (int i = 0; i < count; ++i) {
    CLSID clsid;
    if (d->asioGetDriverCLSID(i, &clsid) != 0) continue;
    if (_stricmp(clsidToString(clsid).c_str(), uid.c_str()) == 0) {
      outIndex = i;
      return true;
    }
  }
  error = "device-not-found(" + uid + ")";
  return false;
}

// 열린 드라이버 하나의 수명. 소멸자에서 반드시 ASIOExit + removeCurrentDriver를 부른다 —
// 빠뜨리면 드라이버가 프로세스 종료까지 장치를 점유해 다음 실행이 통째로 실패한다.
class DriverSession {
 public:
  // ⚠️ ASIOExit()와 removeCurrentDriver()를 둘 다 부르는 건 중복이 아니다. 지우지 말 것.
  //
  //   - ASIOInit 성공 후: ASIOExit()가 내부에서 removeCurrentDriver()를 부른다.
  //     이어지는 우리의 호출은 curIndex == -1 가드에 걸려 무해한 no-op이다.
  //   - ASIOInit 실패 후: asio.cpp가 theAsioDriver를 0으로만 밀고 드라이버는 열어둔 채
  //     반환한다. 그러면 ASIOExit()는 `if(theAsioDriver)`에 막혀 아무것도 하지 않으므로,
  //     COM 인스턴스를 실제로 닫는 건 **우리의 removeCurrentDriver()뿐이다.**
  //
  // 이걸 빠뜨리면 init에 실패한 드라이버가 프로세스 종료까지 장치를 점유해, 뒤이은
  // list의 프로브가 줄줄이 실패한다.
  ~DriverSession() {
    if (!open_) return;
    ASIOExit();
    drivers()->removeCurrentDriver();
  }

  bool open(int index, std::string& error) {
    AsioDrivers* d = drivers();

    char name[128] = {0};
    if (d->asioGetDriverName(index, name, sizeof(name)) != 0) {
      error = "driver-name-failed(index " + std::to_string(index) + ")";
      return false;
    }
    name_ = name;

    CLSID clsid;
    if (d->asioGetDriverCLSID(index, &clsid) == 0) uid_ = clsidToString(clsid);

    // loadAsioDriver가 non-const char*를 받으므로 가변 버퍼가 필요하다.
    if (!loadAsioDriver(name)) {
      error = "driver-load-failed(" + name_ + ")";
      return false;
    }
    open_ = true;  // 여기서부터 removeCurrentDriver 책임이 생긴다

    ASIODriverInfo info;
    memset(&info, 0, sizeof(info));
    info.asioVersion = 2;
    info.sysRef = GetDesktopWindow();  // 콘솔 앱엔 창이 없다. 다수 드라이버가 유효한 HWND를 요구한다
    const ASIOError rc = ASIOInit(&info);
    if (rc != ASE_OK) {
      // info.errorMessage에 드라이버가 남긴 실제 사유가 들어있다 — 삼키면 진단이 불가능해진다
      error = "driver-init-failed(" + name_ + ": " +
              (info.errorMessage[0] ? info.errorMessage : "unknown") + ")";
      return false;
    }
    return true;
  }

  const std::string& name() const { return name_; }
  const std::string& uid() const { return uid_; }

 private:
  std::string name_;
  std::string uid_;
  bool open_ = false;  // loadAsioDriver 성공 = removeCurrentDriver 책임 발생
};

// 열린 드라이버에서 능력 일체를 읽는다. supportedRates가 null이면 레이트 프로브를 건너뛴다
// (프로브는 후보당 드라이버 왕복이라 list에서는 비용이 아깝다).
void readCaps(const DriverSession& s, DeviceCaps& out, bool probeRates) {
  out.name = s.name();
  out.uid = s.uid();

  long in = 0, outCh = 0;
  if (ASIOGetChannels(&in, &outCh) == ASE_OK) {
    out.inputChannels = in;
    out.outputChannels = outCh;
  }

  ASIOSampleRate rate = 0;
  if (ASIOGetSampleRate(&rate) == ASE_OK) out.sampleRate = rate;

  long minS = 0, maxS = 0, pref = 0, gran = 0;
  if (ASIOGetBufferSize(&minS, &maxS, &pref, &gran) == ASE_OK) {
    out.bufferMin = minS;
    out.bufferMax = maxS;
    out.bufferPreferred = pref;
    out.bufferGranularity = gran;
    // ASIO에는 "현재 버퍼 크기"가 없다 — 버퍼는 ASIOCreateBuffers 시점에 정해진다.
    // 드라이버 preferred가 CoreAudio의 current.bufferSize에 가장 가까운 대응물이다.
    out.bufferSize = pref;
  }

  long latIn = 0, latOut = 0;
  if (ASIOGetLatencies(&latIn, &latOut) == ASE_OK) {
    out.inputLatency = latIn;
    out.outputLatency = latOut;
  }

  if (probeRates) {
    for (double r : kProbeRates) {
      if (ASIOCanSampleRate(r) == ASE_OK) out.supportedSampleRates.push_back(r);
    }
  }
}

}  // namespace

long snapBufferSize(long requested, long minSize, long maxSize, long preferred, long granularity) {
  if (requested <= 0) return preferred;
  if (minSize > 0 && maxSize > 0 && minSize == maxSize) return minSize;

  if (granularity == -1) {
    // 2의 거듭제곱만 허용. min 이상인 첫 거듭제곱부터 max까지 훑어 요청값에 가장 가까운 것.
    long p = 1;
    while (p < (minSize > 0 ? minSize : 1)) p <<= 1;
    long best = p;
    for (long v = p; v <= maxSize && v > 0; v <<= 1) {
      if (labs(v - requested) < labs(best - requested)) best = v;
    }
    return best;
  }

  if (granularity > 0) {
    const long steps = (requested - minSize + granularity / 2) / granularity;
    long v = minSize + (steps > 0 ? steps : 0) * granularity;
    if (v < minSize) v = minSize;
    if (v > maxSize) v = maxSize;
    return v;
  }

  // granularity 0 등 그 외: 드라이버가 preferred 하나만 받는다는 뜻으로 해석한다.
  return preferred;
}

bool listDevices(std::vector<DeviceInfo>& out, bool probe, std::string& error) {
  AsioDrivers* d = drivers();
  const long count = d->asioGetNumDev();
  if (count <= 0) {
    error = "no-asio-driver";
    return false;
  }

  for (int i = 0; i < count; ++i) {
    DeviceInfo info;

    char name[128] = {0};
    if (d->asioGetDriverName(i, name, sizeof(name)) == 0) info.name = name;

    CLSID clsid;
    if (d->asioGetDriverCLSID(i, &clsid) == 0) info.uid = clsidToString(clsid);
    if (info.uid.empty()) continue;  // uid 없이는 --device로 다시 지목할 수 없다

    info.isDefault = (i == 0);  // ASIO엔 OS 기본 장치가 없다 — 첫 항목을 기본으로 본다

    // 채널 수/샘플레이트는 드라이버를 열어야 나온다. 열기는 배타적이라 실패할 수 있고
    // (특히 우리 자신의 capture 프로세스가 그 장치를 쥐고 있을 때) 그건 정상이다.
    // 실패해도 장치를 목록에서 빼지 않는다 — 드롭다운에서 사라지면 선택 자체가 불가능해진다.
    if (probe) {
      DriverSession session;
      std::string ignored;
      if (session.open(i, ignored)) {
        DeviceCaps caps;
        readCaps(session, caps, /*probeRates=*/false);
        info.inputChannels = caps.inputChannels;
        info.sampleRate = caps.sampleRate;
        info.probed = true;
      }
    }

    out.push_back(info);
  }

  if (out.empty()) {
    error = "no-asio-driver";
    return false;
  }
  return true;
}

bool queryDevice(const std::string& deviceUid, DeviceCaps& out, std::string& error) {
  int index = 0;
  if (!resolveIndex(deviceUid, index, error)) return false;

  DriverSession session;
  if (!session.open(index, error)) return false;

  readCaps(session, out, /*probeRates=*/true);
  return true;
}

bool getDevice(const std::string& deviceUid, DeviceState& out, std::string& error) {
  int index = 0;
  if (!resolveIndex(deviceUid, index, error)) return false;

  DriverSession session;
  if (!session.open(index, error)) return false;

  DeviceCaps caps;
  readCaps(session, caps, /*probeRates=*/false);
  out.name = caps.name;
  out.uid = caps.uid;
  out.sampleRate = caps.sampleRate;
  out.bufferSize = caps.bufferSize;
  return true;
}

bool setDevice(const std::string& deviceUid, double sampleRate, long bufferSize,
               DeviceState& out, std::string& error) {
  int index = 0;
  if (!resolveIndex(deviceUid, index, error)) return false;

  DriverSession session;
  if (!session.open(index, error)) return false;

  if (sampleRate > 0) {
    if (ASIOCanSampleRate(sampleRate) != ASE_OK) {
      error = "unsupported-sample-rate(" + std::to_string(static_cast<long long>(sampleRate)) + ")";
      return false;
    }
    if (ASIOSetSampleRate(sampleRate) != ASE_OK) {
      error = "set-sample-rate-failed(" + std::to_string(static_cast<long long>(sampleRate)) + ")";
      return false;
    }
  }

  DeviceCaps caps;
  readCaps(session, caps, /*probeRates=*/false);

  out.name = caps.name;
  out.uid = caps.uid;
  out.sampleRate = caps.sampleRate;
  // 버퍼는 여기서 "적용"되지 않는다 — ASIO는 ASIOCreateBuffers 시점에만 크기가 정해진다.
  // 드라이버가 실제로 받아줄 값이 무엇인지만 계산해 돌려준다(capture가 쓸 값과 동일).
  out.bufferSize = snapBufferSize(bufferSize, caps.bufferMin, caps.bufferMax,
                                  caps.bufferPreferred, caps.bufferGranularity);
  return true;
}

}  // namespace audio
