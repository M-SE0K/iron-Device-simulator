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

#include <atomic>
#include <cstring>
#include <cstdlib>
#include <memory>

#include "asiosys.h"
#include "asio.h"
#include "asiodrivers.h"

#include "ring_buffer.h"
#include "sample_convert.h"

// asiodrivers.cpp가 정의하는 전역. asio.cpp의 ASIOxxx()가 이걸 통해 드라이버에 닿는다.
extern AsioDrivers* asioDrivers;
bool loadAsioDriver(char* name);

// sample_convert.h는 WSL에서 단위 테스트를 돌리려고 asio.h를 include하지 않고 타입 번호를
// 복제해 둔다. 그 복제본이 실제 SDK 값과 어긋나면 조용히 잘못된 포맷으로 변환되어
// "가끔 잡음이 섞인다"는 형태로만 드러난다 — 여기서 컴파일 타임에 못박는다.
// (sample_convert.h 상단 주석이 약속하는 검증이 바로 이것이다.)
static_assert(convert::kInt16LSB   == static_cast<long>(ASIOSTInt16LSB),   "ASIOSampleType 복제본 불일치: Int16LSB");
static_assert(convert::kInt24LSB   == static_cast<long>(ASIOSTInt24LSB),   "ASIOSampleType 복제본 불일치: Int24LSB");
static_assert(convert::kInt32LSB   == static_cast<long>(ASIOSTInt32LSB),   "ASIOSampleType 복제본 불일치: Int32LSB");
static_assert(convert::kFloat32LSB == static_cast<long>(ASIOSTFloat32LSB), "ASIOSampleType 복제본 불일치: Float32LSB");
static_assert(convert::kFloat64LSB == static_cast<long>(ASIOSTFloat64LSB), "ASIOSampleType 복제본 불일치: Float64LSB");
static_assert(convert::kInt32LSB16 == static_cast<long>(ASIOSTInt32LSB16), "ASIOSampleType 복제본 불일치: Int32LSB16");
static_assert(convert::kInt32LSB18 == static_cast<long>(ASIOSTInt32LSB18), "ASIOSampleType 복제본 불일치: Int32LSB18");
static_assert(convert::kInt32LSB20 == static_cast<long>(ASIOSTInt32LSB20), "ASIOSampleType 복제본 불일치: Int32LSB20");
static_assert(convert::kInt32LSB24 == static_cast<long>(ASIOSTInt32LSB24), "ASIOSampleType 복제본 불일치: Int32LSB24");

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

// ── capture 상주 스트림 ─────────────────────────────────────────────────────
//
// ASIO 콜백은 컨텍스트 인자(user data)를 받지 않는다. 상태를 넘길 방법이 없으므로
// 파일 스코프 싱글톤이 유일한 선택지다. 프로세스당 드라이버가 하나뿐이라 제약도 아니다.
struct CaptureStream {
  // ⚠️ session이 **첫 멤버**여야 한다. 멤버는 선언 역순으로 소멸하므로, 이래야
  // ~CaptureStream 본문(ASIODisposeBuffers)이 끝난 뒤에 ~DriverSession(ASIOExit)이 돈다.
  // 순서가 뒤집히면 이미 닫힌 드라이버에 DisposeBuffers를 부르게 된다.
  DriverSession session;

  // ⚠️ 드라이버는 ASIOCreateBuffers에 넘긴 ASIOCallbacks를 **복사하지 않고 포인터로 보관**한다.
  // 지역 변수로 두면 startCapture()가 반환하는 순간 스택이 죽어 다음 콜백에서 드라이버가
  // 죽은 함수 포인터를 읽는다(첫 콜백은 ASIOStart가 startCapture 안에 있어 우연히 성공하므로
  // "한 번만 돌고 크래시"라는 형태로 나타난다). 수명을 스트림에 묶어야 한다.
  ASIOCallbacks callbacks;

  // infos는 [입력 srcChannels개] + [출력 outputCount개] 순서로 이어 붙인다.
  // ASIOCreateBuffers가 배열 하나만 받으므로 출력을 따로 둘 수 없다.
  std::vector<ASIOBufferInfo> infos;
  std::vector<long> types;             // 입력 채널별 ASIOSampleType — 채널마다 다를 수 있다
  std::vector<long> outputTypes;       // 출력 채널별 ASIOSampleType
  std::vector<int16_t> scratch;        // 인터리브 staging (RT 스레드 전용, 사전 할당)
  std::unique_ptr<RingBuffer> ring;

  long srcChannels = 0;    // 드라이버에서 실제로 받는 채널 수
  long outChannels = 0;    // stdout 인터리브 채널 수 (모노 장치 복제 시 srcChannels보다 크다)
  long bufferSize = 0;     // 스냅된 실제 프레임 수

  // ── play-capture ──
  bool playCapture = false;
  std::vector<float> ref;          // 재생 신호 전체 (RT 스레드에서 파일 I/O 금지 → 미리 메모리로)
  long outputCount = 0;            // 등록한 출력 채널 수 (= 장치의 전체 출력 채널)
  long playbackChannel = 0;
  size_t refPos = 0;               // RT 스레드 전용 — 다른 스레드가 건드리지 않는다
  size_t tailFrames = 0;           // 재생 종료 후 흘려보낸 프레임 (감쇠 테일)
  size_t tailTarget = 0;
  std::atomic<bool> paused{false};
  std::atomic<bool> playbackDone{false};

  std::atomic<bool> resetRequested{false};
  bool started = false;
  bool buffersCreated = false;

  ~CaptureStream() {
    if (started) ASIOStop();
    if (buffersCreated) ASIODisposeBuffers();
    // ASIOExit / removeCurrentDriver는 session 소멸자가 이어서 처리한다
  }
};

// 콜백과 main 스레드가 함께 본다. 콜백이 도는 동안 delete되면 안 되므로
// stopCapture()가 ASIOStop으로 콜백을 멈춘 뒤에만 이 포인터를 비운다.
std::atomic<CaptureStream*> g_stream{nullptr};

// ⚠️ 여기는 드라이버의 실시간 스레드다. 할당·락·I/O·로그 전부 금지.
void bufferSwitch(long index, ASIOBool /*directProcess*/) {
  CaptureStream* s = g_stream.load(std::memory_order_acquire);
  if (!s) return;

  const size_t frames = static_cast<size_t>(s->bufferSize);
  const size_t stride = static_cast<size_t>(s->outChannels);
  int16_t* dst = s->scratch.data();

  // ASIO 입력 버퍼는 채널당 분리(non-interleaved)다 — 인터리브는 우리 몫.
  // index가 어느 하프버퍼인지 알려주므로 반드시 그걸 읽어야 한다.
  for (long c = 0; c < s->srcChannels; ++c) {
    convert::toInt16(s->types[c], s->infos[c].buffers[index], dst + c, frames, stride);
  }

  // 모노 장치에서 2채널을 요청받았으면 ch0을 ch1에 복제한다 (macOS 헬퍼와 동일).
  if (s->srcChannels == 1 && s->outChannels == 2) {
    for (size_t i = 0; i < frames; ++i) dst[i * 2 + 1] = dst[i * 2];
  }

  // 가득 차면 이 콜백 분을 통째로 버린다. 부분 쓰기를 허용하면 채널이 영구히
  // 어긋나므로 RingBuffer가 전부-아니면-전무를 보장한다 (ring_buffer.h).
  s->ring->write(dst, frames * stride * sizeof(int16_t));

  if (!s->playCapture) return;

  // ── 출력(재생) ────────────────────────────────────────────────────────────
  //
  // ⚠️ 등록한 출력 채널을 **매 콜백 전부 0으로 지운다.** ASIO 출력 버퍼는 재사용되므로
  // 안 지우면 직전 버퍼 내용이 그대로 다시 울린다. playbackChannel도 일단 지운 뒤
  // 덮어쓰므로, ref가 끝난 뒤나 pause 중에는 자연히 무음이 된다.
  const size_t outBase = static_cast<size_t>(s->srcChannels);
  for (long c = 0; c < s->outputCount; ++c) {
    void* buf = s->infos[outBase + static_cast<size_t>(c)].buffers[index];
    memset(buf, 0, frames * convert::bytesPerSample(s->outputTypes[static_cast<size_t>(c)]));
  }

  // pause는 출력만 죽이고 재생 위치를 동결한다 — 캡처는 위에서 이미 흘려보냈다.
  // (버퍼는 이미 0으로 지웠으므로 아래를 건너뛰면 그대로 무음이 나간다.)
  const bool paused = s->paused.load(std::memory_order_acquire);

  const size_t refLen = s->ref.size();
  if (paused) {
    // 아무것도 하지 않는다 — 위치도 테일도 진행시키지 않는다
  } else if (s->refPos < refLen) {
    const size_t avail = refLen - s->refPos;
    const size_t n = avail < frames ? avail : frames;
    convert::fromFloat(s->outputTypes[static_cast<size_t>(s->playbackChannel)],
                       s->ref.data() + s->refPos,
                       s->infos[outBase + static_cast<size_t>(s->playbackChannel)].buffers[index],
                       n);
    s->refPos += n;
    // 마지막 조각이 buffer보다 짧으면 나머지는 위 memset이 남긴 0이라 그대로 무음이다.
  } else {
    // 재생은 끝났지만 바로 죽이지 않는다 — 앰프/스피커의 잔향과 렌더러가 아직 처리 중인
    // 캡처 프레임을 위해 감쇠 테일만큼 더 흘려보낸 뒤 종료를 알린다.
    s->tailFrames += frames;
    if (s->tailFrames >= s->tailTarget) {
      s->playbackDone.store(true, std::memory_order_release);
    }
  }

  // 드라이버가 지원하면 출력 준비 완료를 알려 레이턴시를 줄인다. 미지원 드라이버는
  // ASE_NotPresent를 돌려줄 뿐이라 무조건 불러도 안전하다.
  ASIOOutputReady();
}

// bufferSwitchTimeInfo를 쓰지 않지만 콜백 구조체에 null을 남기면 일부 드라이버가
// 무조건 호출해 크래시한다. 타임스탬프는 안 쓰므로 bufferSwitch로 넘기기만 한다.
ASIOTime* bufferSwitchTimeInfo(ASIOTime* params, long index, ASIOBool directProcess) {
  bufferSwitch(index, directProcess);
  return params;
}

// 드라이버가 스스로 레이트를 바꾼 경우. 헤더는 이미 나갔고 스트림 포맷(int16/채널 수)은
// 그대로라 중단할 이유가 없다 — 렌더러가 헤더의 sampleRate로 해석하므로 피치가 어긋날
// 뿐이다. 실기에서 관측된 적이 없어 Phase 3 전까지는 무시한다.
void sampleRateDidChange(ASIOSampleRate /*rate*/) {}

long asioMessage(long selector, long value, void* /*message*/, double* /*opt*/) {
  switch (selector) {
    case kAsioSelectorSupported:
      // value에 "이 셀렉터 지원하냐"고 되묻는 구조다. 아래에서 실제로 처리하는 것만 신고한다.
      switch (value) {
        case kAsioResetRequest:
        case kAsioResyncRequest:
        case kAsioLatenciesChanged:
        case kAsioEngineVersion:
        case kAsioSupportsTimeInfo:
          return 1;
        default:
          return 0;
      }
    case kAsioEngineVersion:
      return 2;
    case kAsioResetRequest: {
      // USB 분리 등. ⚠️ RT 컨텍스트에서 올 수 있어 여기서 ASIOExit을 부르면 데드락이다.
      // 플래그만 세우고 main 스레드가 정리 후 exit 3으로 나간다. (CAPTURE-PLAN.md §4)
      CaptureStream* s = g_stream.load(std::memory_order_acquire);
      if (s) s->resetRequested.store(true, std::memory_order_release);
      return 1;
    }
    case kAsioResyncRequest:
      // 동기가 깨졌다는 신호일 뿐 종료 사유가 아니다 — reset과 혼동하면 멀쩡한 세션이 끊긴다.
      return 1;
    case kAsioLatenciesChanged:
      return 1;
    case kAsioSupportsTimeInfo:
      return 1;
    default:
      return 0;
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

bool startCapture(const CaptureConfig& cfg, CaptureInfo& out, std::string& error) {
  if (g_stream.load(std::memory_order_acquire)) {
    error = "capture-already-running";
    return false;
  }

  int index = 0;
  if (!resolveIndex(cfg.deviceUid, index, error)) return false;

  // 이 시점부터 실패하면 unique_ptr 소멸자가 ASIODisposeBuffers/ASIOExit까지 되돌린다.
  std::unique_ptr<CaptureStream> s(new CaptureStream());
  if (!s->session.open(index, error)) return false;

  // set과 달리 여기서 건 SampleRate는 스트림이 사는 동안 실제로 유지된다 —
  // 드라이버를 놓지 않기 때문이다. 앱의 "적용"이 최종적으로 기대는 지점이다.
  if (cfg.sampleRate > 0) {
    const std::string rateStr = std::to_string(static_cast<long long>(cfg.sampleRate));
    if (ASIOCanSampleRate(cfg.sampleRate) != ASE_OK) {
      error = "unsupported-sample-rate(" + rateStr + ")";
      return false;
    }
    if (ASIOSetSampleRate(cfg.sampleRate) != ASE_OK) {
      error = "set-sample-rate-failed(" + rateStr + ")";
      return false;
    }
  }

  long deviceIn = 0, deviceOut = 0;
  if (ASIOGetChannels(&deviceIn, &deviceOut) != ASE_OK || deviceIn <= 0) {
    error = "no-input-channels";
    return false;
  }

  // 요청 채널이 장치 입력 수보다 많으면 거절하지 않고 클램프한다(macOS와 동일).
  // 예외는 모노 장치뿐 — ch0을 복제해 2채널로 내보낸다. 렌더러의 분석 파이프라인이
  // 항상 2ch 고정이라, 여기서 1ch를 내보내면 프레임 재구성이 어긋난다.
  const long requested = cfg.channels > 0 ? cfg.channels : 2;
  s->srcChannels = requested < deviceIn ? requested : deviceIn;
  s->outChannels = (deviceIn == 1 && requested >= 2) ? 2 : s->srcChannels;

  // ── play-capture: ref 로딩 + 출력 채널 검증 ──
  s->playCapture = !cfg.refPath.empty();
  if (s->playCapture) {
    if (deviceOut <= 0) {
      error = "device-has-no-output(" + s->session.name() + ")";
      return false;
    }
    if (cfg.outputChannel < 0 || cfg.outputChannel >= deviceOut) {
      error = "invalid-out-ch(" + std::to_string(cfg.outputChannel) +
              " not in 0..<" + std::to_string(deviceOut) + ")";
      return false;
    }
    s->outputCount = deviceOut;
    s->playbackChannel = cfg.outputChannel;

    // 전체를 미리 메모리에 올린다 — RT 스레드에서 파일을 읽으면 그대로 드롭아웃이다.
    FILE* f = fopen(cfg.refPath.c_str(), "rb");
    if (!f) {
      error = "ref-open-failed(" + cfg.refPath + ")";
      return false;
    }
    fseek(f, 0, SEEK_END);
    const long bytes = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (bytes < 0 || bytes % static_cast<long>(sizeof(float)) != 0) {
      fclose(f);
      error = "ref-bad-size(" + std::to_string(bytes) + ")";
      return false;
    }
    s->ref.resize(static_cast<size_t>(bytes) / sizeof(float));
    if (!s->ref.empty() && fread(s->ref.data(), 1, static_cast<size_t>(bytes), f) != static_cast<size_t>(bytes)) {
      fclose(f);
      error = "ref-read-failed(" + cfg.refPath + ")";
      return false;
    }
    fclose(f);
  }

  long minSize = 0, maxSize = 0, preferred = 0, granularity = 0;
  if (ASIOGetBufferSize(&minSize, &maxSize, &preferred, &granularity) != ASE_OK) {
    error = "buffer-size-query-failed";
    return false;
  }
  long size = snapBufferSize(cfg.bufferSize, minSize, maxSize, preferred, granularity);

  // [입력 srcChannels개] + [출력 outputCount개]. play-capture가 아니면 출력은 0개다.
  s->infos.resize(static_cast<size_t>(s->srcChannels + s->outputCount));
  for (long c = 0; c < s->srcChannels; ++c) {
    ASIOBufferInfo& bi = s->infos[static_cast<size_t>(c)];
    bi.isInput = ASIOTrue;
    bi.channelNum = c;
    bi.buffers[0] = bi.buffers[1] = nullptr;  // 드라이버가 채운다
  }
  // 재생은 한 채널만 쓰지만 출력 **전체**를 등록한다. 등록하지 않은 채널은 우리가 지울
  // 수단이 없어 드라이버가 이전 내용을 계속 내보낼 수 있기 때문이다.
  for (long c = 0; c < s->outputCount; ++c) {
    ASIOBufferInfo& bi = s->infos[static_cast<size_t>(s->srcChannels + c)];
    bi.isInput = ASIOFalse;
    bi.channelNum = c;
    bi.buffers[0] = bi.buffers[1] = nullptr;
  }

  // s->callbacks에 채운다 — 지역 변수로 두면 안 되는 이유는 CaptureStream 멤버 주석 참고.
  s->callbacks.bufferSwitch = &bufferSwitch;
  s->callbacks.sampleRateDidChange = &sampleRateDidChange;
  s->callbacks.asioMessage = &asioMessage;
  s->callbacks.bufferSwitchTimeInfo = &bufferSwitchTimeInfo;

  const long totalChannels = s->srcChannels + s->outputCount;
  ASIOError rc = ASIOCreateBuffers(s->infos.data(), totalChannels, size, &s->callbacks);
  if (rc != ASE_OK && size != preferred) {
    // 격자 위 값인데도 거절하고 preferred만 받는 드라이버가 있다 (CAPTURE-PLAN.md §0).
    size = preferred;
    rc = ASIOCreateBuffers(s->infos.data(), totalChannels, size, &s->callbacks);
  }
  if (rc != ASE_OK) {
    error = "create-buffers-failed(" + std::to_string(size) + ")";
    return false;
  }
  s->buffersCreated = true;
  s->bufferSize = size;

  // 샘플 타입은 채널마다 다를 수 있으므로 등록한 채널을 전부 검사한다.
  s->types.resize(static_cast<size_t>(s->srcChannels));
  for (long c = 0; c < s->srcChannels; ++c) {
    ASIOChannelInfo ci;
    memset(&ci, 0, sizeof(ci));
    ci.channel = c;
    ci.isInput = ASIOTrue;
    if (ASIOGetChannelInfo(&ci) != ASE_OK) {
      error = "channel-info-failed(ch " + std::to_string(c) + ")";
      return false;
    }
    if (!convert::supported(ci.type)) {
      // 변환할 수 없는 포맷을 잡음으로 흘려보내느니 헤더에서 정직하게 거절한다.
      error = "unsupported-sample-type(" + std::to_string(ci.type) + ")";
      return false;
    }
    s->types[static_cast<size_t>(c)] = ci.type;
  }

  // 출력도 채널마다 타입이 다를 수 있다. 재생에 쓰는 건 한 채널이지만 나머지도 매 콜백
  // memset으로 지워야 하므로 바이트 크기를 알아야 한다 — 전부 조회한다.
  s->outputTypes.resize(static_cast<size_t>(s->outputCount));
  for (long c = 0; c < s->outputCount; ++c) {
    ASIOChannelInfo ci;
    memset(&ci, 0, sizeof(ci));
    ci.channel = c;
    ci.isInput = ASIOFalse;
    if (ASIOGetChannelInfo(&ci) != ASE_OK) {
      error = "channel-info-failed(out ch " + std::to_string(c) + ")";
      return false;
    }
    if (!convert::supported(ci.type)) {
      error = "unsupported-sample-type(" + std::to_string(ci.type) + ")";
      return false;
    }
    s->outputTypes[static_cast<size_t>(c)] = ci.type;
  }

  ASIOSampleRate actualRate = 0;
  if (ASIOGetSampleRate(&actualRate) != ASE_OK) actualRate = cfg.sampleRate;

  s->scratch.resize(static_cast<size_t>(size) * static_cast<size_t>(s->outChannels));

  // 링은 1초분. 측정 레이턴시(88/168 프레임)의 1000배 이상이라 stdout이 잠깐 막혀도
  // 흡수된다. RingBuffer가 2의 거듭제곱으로 올림한다.
  const size_t bytesPerSecond =
      static_cast<size_t>(actualRate > 0 ? actualRate : 48000) *
      static_cast<size_t>(s->outChannels) * sizeof(int16_t);
  s->ring.reset(new RingBuffer(bytesPerSecond));

  // 재생 종료 후 감쇠 테일 0.25초 (macOS 헬퍼와 동일).
  s->tailTarget = static_cast<size_t>((actualRate > 0 ? actualRate : 48000) * 0.25);

  out.name = s->session.name();
  out.uid = s->session.uid();
  out.sampleRate = actualRate;
  out.bufferSize = size;
  out.channels = s->outChannels;
  out.playCapture = s->playCapture;
  out.refFrames = static_cast<long>(s->ref.size());
  out.playbackChannel = s->playbackChannel;

  // ASIOStart 직후 콜백이 돌기 시작하므로 포인터를 **먼저** 공개해야 한다.
  g_stream.store(s.get(), std::memory_order_release);
  if (ASIOStart() != ASE_OK) {
    g_stream.store(nullptr, std::memory_order_release);
    error = "asio-start-failed";
    return false;
  }
  s->started = true;
  s.release();  // 이후 수명은 stopCapture()가 진다
  return true;
}

size_t readCaptured(void* dst, size_t maxBytes) {
  CaptureStream* s = g_stream.load(std::memory_order_acquire);
  if (!s) return 0;
  return s->ring->read(dst, maxBytes);
}

bool captureResetRequested() {
  CaptureStream* s = g_stream.load(std::memory_order_acquire);
  return s && s->resetRequested.load(std::memory_order_acquire);
}

void setPlaybackPaused(bool paused) {
  CaptureStream* s = g_stream.load(std::memory_order_acquire);
  if (s) s->paused.store(paused, std::memory_order_release);
}

bool playbackFinished() {
  CaptureStream* s = g_stream.load(std::memory_order_acquire);
  return s && s->playbackDone.load(std::memory_order_acquire);
}

uint64_t captureDroppedBytes() {
  CaptureStream* s = g_stream.load(std::memory_order_acquire);
  return s ? s->ring->dropped() : 0;
}

void stopCapture() {
  CaptureStream* s = g_stream.load(std::memory_order_acquire);
  if (!s) return;

  // ⚠️ 순서가 중요하다. ASIOStop이 콜백을 멈춘 **뒤에야** 포인터를 비울 수 있다.
  // 먼저 비우면 이미 포인터를 읽어간 콜백이 실행 중인 채로 delete될 수 있다.
  if (s->started) {
    ASIOStop();
    s->started = false;
  }
  g_stream.store(nullptr, std::memory_order_release);
  delete s;  // ~CaptureStream → ASIODisposeBuffers → ~DriverSession → ASIOExit
}

}  // namespace audio
