// src-tauri/src/win_mitigations.rs — Windows 전용 프로세스 하드닝 (CIG + ACG).
//
// macOS는 ad-hoc 서명 + hardened runtime(tauri.macos.conf.json의 signingIdentity)이
// 라이브러리 검증·W^X를 서명 단계에서 강제하지만, Windows의 Authenticode 서명에는
// 런타임 보호가 결합되어 있지 않다. 그 대응물로 프로세스가 부팅 직후 스스로
// SetProcessMitigationPolicy를 호출해 두 정책을 켠다:
//
//   - CIG (ProcessSignaturePolicy, MicrosoftSignedOnly): Microsoft 체인 서명 DLL만
//     로드 허용 — 비서명 훅킹 DLL을 주입해 wasm_asset.rs의 복호화 경로(파생 키·평문
//     WASM)를 가로채는 벡터를 차단한다. hardened runtime의 library validation 대응.
//     WHQL/카탈로그 서명된 GPU 유저모드 드라이버는 Microsoft 체인이라 허용된다
//     (Chromium 렌더러가 같은 정책을 쓴다). 부수효과로 백신·오버레이·구형 IME류의
//     주입 DLL도 로드가 막힌다 — 의도된 동작.
//   - ACG (ProcessDynamicCodePolicy, ProhibitDynamicCode): 실행 가능 메모리 신규
//     생성/변경 금지(W^X 강제). WASM JIT은 WebView2의 별도 렌더러 프로세스에서 돌고
//     이 메인 프로세스는 정적 Rust 코드뿐이라 동적 코드가 필요 없다.
//
// 두 정책 모두 한 번 켜면 프로세스 종료까지 해제할 수 없고, 호출 이후의 로드/할당에만
// 적용되므로 main()의 다른 어떤 초기화보다 먼저 불러야 한다.
//
// ⚠️ 사이드카 ASIO 헬퍼(audio-device-helper.exe)에는 CIG를 걸 수 없다 — 헬퍼의 존재
// 이유가 서드파티(벤더 서명) ASIO 드라이버 DLL을 COM으로 로드하는 것이라
// MicrosoftSignedOnly와 양립 불가. 보호 대상은 전부 이 메인 프로세스에 있고 헬퍼는
// PCM 데이터만 다루므로 헬퍼는 의도적으로 제외한다.
//
// 실패 시 앱은 그대로 계속 뜬다(가용성 우선) — 정책 미지원 환경에서 데모가 안 켜지는
// 것보다 하드닝 한 겹이 빠지는 쪽이 낫다. 배포 빌드는 windows_subsystem="windows"라
// 콘솔이 없으므로 eprintln은 dev 실행에서만 보인다.

use std::ffi::c_void;

#[link(name = "kernel32")]
extern "system" {
    // PROCESS_MITIGATION_POLICY(winnt.h C enum)는 i32, BOOL은 i32.
    fn SetProcessMitigationPolicy(
        mitigation_policy: i32,
        buffer: *const c_void,
        length: usize,
    ) -> i32;
    fn GetLastError() -> u32;
}

// PROCESS_MITIGATION_POLICY enum 값 (winnt.h)
const PROCESS_DYNAMIC_CODE_POLICY: i32 = 2;
const PROCESS_SIGNATURE_POLICY: i32 = 8;

// 두 정책 구조체 모두 C에서는 { union { DWORD Flags; <비트필드> } } — 4바이트 u32 하나다.
// ProhibitDynamicCode / MicrosoftSignedOnly 가 각각 비트 0.
const ACG_PROHIBIT_DYNAMIC_CODE: u32 = 1 << 0;
const CIG_MICROSOFT_SIGNED_ONLY: u32 = 1 << 0;

fn set_policy(policy: i32, flags: u32, label: &str) {
    let ok = unsafe {
        SetProcessMitigationPolicy(
            policy,
            &flags as *const u32 as *const c_void,
            std::mem::size_of::<u32>(),
        )
    };
    if ok == 0 {
        eprintln!(
            "[win-mitigations] {label} 적용 실패 (GetLastError={}) — 하드닝 없이 계속 실행",
            unsafe { GetLastError() }
        );
    }
}

/// CIG + ACG를 현재 프로세스에 적용한다. main() 최상단에서 1회 호출.
pub fn apply() {
    set_policy(
        PROCESS_SIGNATURE_POLICY,
        CIG_MICROSOFT_SIGNED_ONLY,
        "CIG(MicrosoftSignedOnly)",
    );
    set_policy(
        PROCESS_DYNAMIC_CODE_POLICY,
        ACG_PROHIBIT_DYNAMIC_CODE,
        "ACG(ProhibitDynamicCode)",
    );
}
