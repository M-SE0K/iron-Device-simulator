// json_out.h — 의존성 없는 최소 JSON 직렬화기.
//
// 헬퍼의 stdout 계약은 "한 줄 JSON"이라 문자열을 손으로 이어붙여도 되지만, 키를 빠뜨리거나
// 콤마를 잘못 넣으면 부모(Tauri helper::run_audio_helper)가 invalid-helper-output으로 바꿔
// 디버깅이 어렵다. 구조를 강제하는 최소 빌더를 둔다.
//
// 숫자는 정수값이면 정수로 출력한다 — 48000.0이 아니라 48000. 렌더러가 그대로 표시하기 때문.
#pragma once

#include <cstdio>
#include <sstream>
#include <string>

namespace json {

class Writer {
 public:
  std::string str() const { return out_.str(); }

  Writer& beginObj() { sep(); out_ << '{'; first_ = true; return *this; }
  Writer& endObj()   { out_ << '}'; first_ = false; return *this; }
  Writer& beginArr() { sep(); out_ << '['; first_ = true; return *this; }
  Writer& endArr()   { out_ << ']'; first_ = false; return *this; }

  // 객체 키. 다음 값 호출이 이 키에 붙는다.
  Writer& key(const char* k) {
    sep();
    out_ << '"' << k << "\":";
    first_ = true;  // 값 앞에는 콤마가 붙지 않도록
    return *this;
  }

  Writer& val(const std::string& s) { sep(); out_ << '"' << escape(s) << '"'; first_ = false; return *this; }
  Writer& val(const char* s)        { return val(std::string(s)); }
  Writer& val(bool b)               { sep(); out_ << (b ? "true" : "false"); first_ = false; return *this; }
  Writer& val(long n)               { sep(); out_ << n; first_ = false; return *this; }
  Writer& val(int n)                { return val(static_cast<long>(n)); }
  Writer& null()                    { sep(); out_ << "null"; first_ = false; return *this; }

  // double은 정수값이면 정수로. 0 이하는 "알 수 없음"으로 보고 null을 쓴다
  // (macOS 쪽 sampleRate: number | null 과 맞춘다).
  Writer& val(double d) {
    sep();
    if (d == static_cast<long long>(d)) out_ << static_cast<long long>(d);
    else                                out_ << d;
    first_ = false;
    return *this;
  }
  Writer& valOrNull(double d) { return d > 0 ? val(d) : null(); }

  // 흔한 조합 단축형
  template <typename T>
  Writer& kv(const char* k, T v) { key(k); val(v); return *this; }
  Writer& kvOrNull(const char* k, double v) { key(k); valOrNull(v); return *this; }

 private:
  // 값/키 사이 콤마. beginObj/key 직후에는 붙이지 않는다.
  void sep() {
    if (!first_) out_ << ',';
    first_ = false;
  }

  static std::string escape(const std::string& s) {
    std::string r;
    r.reserve(s.size() + 8);
    for (char c : s) {
      switch (c) {
        case '"':  r += "\\\""; break;
        case '\\': r += "\\\\"; break;
        case '\n': r += "\\n";  break;
        case '\r': r += "\\r";  break;
        case '\t': r += "\\t";  break;
        default:
          // 드라이버 이름에 제어문자가 섞여 오는 경우가 있어 방어한다
          if (static_cast<unsigned char>(c) < 0x20) {
            char buf[8];
            snprintf(buf, sizeof(buf), "\\u%04x", c);
            r += buf;
          } else {
            r += c;
          }
      }
    }
    return r;
  }

  std::ostringstream out_;
  bool first_ = true;
};

// 실패 응답 한 줄. 모든 명령이 같은 모양을 쓴다.
inline std::string error(const std::string& message) {
  Writer w;
  w.beginObj().kv("success", false).kv("error", message).endObj();
  return w.str();
}

}  // namespace json
