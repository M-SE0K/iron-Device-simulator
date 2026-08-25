/* debug/temp_fault_sweep.c — 온도 가드(Speaker Open / Speaker Short) 발화 조건 관측용
 * 디버그 알고리즘.
 *
 * 목적: 앱의 온도 가드가 "언제 뜨고 언제 사라지는지"를 오디오 내용과 무관하게 재현
 * 가능하게 만든다. 실제 열모델(protection.c / passthrough.c)은 입력 신호와 실측 V/I에
 * 좌우돼서 임계 근처를 원하는 대로 지나가게 만들 수 없고, 특히 음수 온도는 이 리포의
 * 어떤 알고리즘에서도 나오지 않는다(전부 `if (t_out < 0) t_out = 0;` 로 잘라낸다).
 * 그래서 Speaker Short(≤ -500°C) 경로는 실행해 볼 방법 자체가 없었다.
 *
 * 이 파일은 온도를 **시간의 결정론적 함수**로 직접 합성해 두 가드를 모두 지나간다.
 * 오디오는 건드리지 않는다(buf 무수정 패스스루) — 아무 파일이나 재생하면 된다.
 *
 * 빌드:
 *   FF_PROT_SRCS=custom/debug/temp_fault_sweep.c npm run build:wasm -- --dev
 *   npm run build:tauri -- --mac --dev
 *
 * ── 30초 1주기 시나리오 (끝나면 처음부터 반복) ─────────────────────────────
 *   #  phase          t[s]      온도                        관측 포인트
 *   0  WARMUP        0.0– 2.0   amb                         정상 표기
 *   1  EDGE_OPEN     2.0– 5.0   499 → 500 → 501 (1s 씩)     경계가 >= 인지 (500에서 떠야 함)
 *   2  RAMP_OPEN     5.0– 8.0   amb → 520 선형              교차 시점의 정확도
 *   3  HOLD_OPEN     8.0–10.0   520                         지속 중 표기 유지
 *   4  FLAP_OPEN    10.0–14.0   495 ↔ 505, 정상구간 계단     해제 디바운스 임계 실측(아래 표)
 *   5  RECOVER      14.0–16.0   → amb 선형                  경고 해제 + 온도 표기 복귀
 *   6  EDGE_SHORT   16.0–19.0   -499 → -500 → -501 (1s 씩)  경계가 <= 인지
 *   7  RAMP_SHORT   19.0–22.0   amb → -520 선형             short 교차
 *   8  HOLD_SHORT   22.0–24.0   -520
 *   9  FLAP_SHORT   24.0–28.0   -495 ↔ -505, 같은 계단
 *  10  RECOVER      28.0–30.0   → amb
 *
 * 교차 시각은 닫힌 형태로 미리 알 수 있다(선형 램프라서):
 *   t_open_cross  = 5.0 + 3.0 · (500 - amb) / (520 - amb)
 *   t_short_cross = 19.0 + 3.0 · (-500 - amb) / (-520 - amb)
 * amb = 25°C 기준 각각 t ≈ 6.92 s, t ≈ 20.86 s. 관측된 배지 등장 시각과 이 값을 비교하면
 * 렌더 경로(출력 큐 100 ms 스케줄러 포함)가 얹는 지연까지 같이 잰다.
 *
 * ── flap 구간의 계단 (phase 4 / 9) ────────────────────────────────────────
 * 4초를 8등분(각 0.5 s)해 "임계 밖 → 정상"을 반복하되 반주기를 단계마다 늘린다:
 *
 *   단계  0     1     2     3     4      5      6      7
 *   반주기 20ms  40ms  60ms  80ms  100ms  150ms  250ms  400ms
 *   FLAP_OPEN  t = 10.0  10.5  11.0  11.5  12.0   12.5   13.0   13.5
 *   FLAP_SHORT t = 24.0  24.5  25.0  25.5  26.0   26.5   27.0   27.5
 *
 * 정상 구간이 디바운스(기본 10프레임 = 100 ms)보다 짧은 0–3 단계에서는 배지가 계속 떠
 * 있어야 하고, 4단계(100 ms)부터 깜빡이기 시작해야 한다. 깜빡임이 시작되는 단계가 곧
 * FAULT_CLEAR_FRAMES 의 실측값이다 — 앱 상수를 바꿨을 때 이 지점이 따라 움직인다.
 *
 * ── 지금 어느 phase 인지 읽는 법 ───────────────────────────────────────────
 * 변위(excursion) 출력에 phase 번호를 실어 보낸다: exc = phase × 500 µm. Excursion 차트가
 * 0 → 500 → 1000 … 계단으로 올라가므로 별도 로그 없이 진행 상황을 눈으로 읽을 수 있다.
 * 단, 가드에 걸린 프레임은 앱이 온도·변위를 함께 0 으로 깔므로(wasm-client.ts) fault 구간
 * 에서는 계단이 0 으로 내려앉는다 — 그 자체가 "blanking 이 걸렸다"는 확인이 된다.
 *
 * ── 주의 ───────────────────────────────────────────────────────────────────
 * · OPEN_LIMIT_C / SHORT_LIMIT_C 는 앱의 TEMP_OVERFLOW_LIMIT_C / TEMP_SHORT_LIMIT_C
 *   (src/features/audio/lib/engine/core.ts)와 **같은 값이어야** 경계 실험이 성립한다.
 *   앱 쪽 임계를 바꾸면 여기도 같이 바꿀 것.
 * · 시간 기준은 다른 디버그 알고리즘과 같은 한계를 그대로 갖는다 — ff_prot_start_exec 에
 *   sample_rate_hz 인자가 없어서 DEFAULT_SAMPLE_RATE_HZ 로 근사한다. Calibration 에서
 *   48 kHz 가 아닌 SR 로 돌리면 위 표의 t[s] 가 (실제SR / 48000) 배로 늘어난다.
 * · 진단 전용이다. 온도가 물리와 무관한 합성값이므로 절대 배포 빌드에 넣지 말 것.
 */
#include "../ff_prot.h"
#include <string.h>

#define DEFAULT_SAMPLE_RATE_HZ 48000.0

/* 앱의 가드 임계와 반드시 일치시킬 것 (engine/core.ts) */
#define OPEN_LIMIT_C     500.0
#define SHORT_LIMIT_C  (-500.0)

/* 임계를 확실히 넘기기 위한 오버슈트, 그리고 flap 구간의 진폭 */
#define OVERSHOOT_C       20.0
#define FLAP_MARGIN_C      5.0

/* flap 구간은 "임계를 넘었다가 되돌아오는 정상 구간의 길이"를 단계적으로 늘린다.
 * 앱의 경고 해제 디바운스(useCaptureSession.ts FAULT_CLEAR_FRAMES = 정상 프레임 10개)가
 * 어느 길이부터 버티지 못하는지를 눈으로 읽기 위한 계단이다. 기본 프레임(480 smp/48 kHz
 * = 10 ms) 기준으로 10프레임 = 100 ms 이므로, 100 ms 미만 단계에서는 배지가 계속 떠 있고
 * 100 ms 이상 단계부터 깜빡이기 시작해야 한다 — 그 전환 지점이 곧 디바운스 실측값이다. */
#define FLAP_STEPS 8
static const double g_flap_half_ms[FLAP_STEPS] = { 20, 40, 60, 80, 100, 150, 250, 400 };

/* 기준 온도(amb)를 이 범위로 가둔다 — Calibration 에 이상한 값이 들어와도 시나리오의
 * 교차 시점이 예측 가능하게 유지되도록. */
#define AMB_MIN_C          0.0
#define AMB_MAX_C        100.0

/* phase 번호를 변위로 실어 보낼 때의 눈금 [µm] */
#define PHASE_EXC_STEP_UM 500.0

enum {
    PH_HOLD_AMB = 0,
    PH_EDGE_OPEN,
    PH_RAMP_OPEN,
    PH_HOLD_OPEN,
    PH_FLAP_OPEN,
    PH_RECOVER,
    PH_EDGE_SHORT,
    PH_RAMP_SHORT,
    PH_HOLD_SHORT,
    PH_FLAP_SHORT
};

typedef struct {
    int    kind;
    double seconds;
} sweep_phase;

/* 위 헤더 주석의 표와 1:1 대응. 합계 = SWEEP_PERIOD_S */
static const sweep_phase g_phases[] = {
    { PH_HOLD_AMB,    2.0 },
    { PH_EDGE_OPEN,   3.0 },
    { PH_RAMP_OPEN,   3.0 },
    { PH_HOLD_OPEN,   2.0 },
    { PH_FLAP_OPEN,   4.0 },
    { PH_RECOVER,     2.0 },
    { PH_EDGE_SHORT,  3.0 },
    { PH_RAMP_SHORT,  3.0 },
    { PH_HOLD_SHORT,  2.0 },
    { PH_FLAP_SHORT,  4.0 },
    { PH_RECOVER,     2.0 },
};
#define PHASE_COUNT ((int)(sizeof(g_phases) / sizeof(g_phases[0])))

static int    g_initialized = 0;
static double g_elapsed_s   = 0.0;   /* 세션 시작 이후 누적 시간 [s] */

/* 정수 나눗셈 없이 주기를 접기 위한 헬퍼 — 주기 길이는 컴파일 타임에 모르므로 런타임 합산 */
static double sweep_period_s(void)
{
    double sum = 0.0;
    for (int i = 0; i < PHASE_COUNT; ++i) sum += g_phases[i].seconds;
    return sum;
}

static double lerp(double a, double b, double u)
{
    return a + (b - a) * u;
}

/* 구형파 — phase 를 FLAP_STEPS 등분해 단계마다 반주기를 g_flap_half_ms 로 바꾼다.
 * 각 단계는 항상 "임계를 넘은 쪽(high)"으로 시작해서, 뒤따르는 정상 구간이 배지를
 * 내리는지 보는 구조다. 반환값 1 = 임계 밖(fault), 0 = 정상. */
static int flap_high(double u, double phase_seconds)
{
    int step = (int)(u * (double)FLAP_STEPS);
    if (step < 0)           step = 0;
    if (step >= FLAP_STEPS) step = FLAP_STEPS - 1;

    const double step_seconds = phase_seconds / (double)FLAP_STEPS;
    const double t_in_step    = u * phase_seconds - (double)step * step_seconds;
    const double half_s       = g_flap_half_ms[step] / 1000.0;
    if (half_s <= 0.0) return 1;

    long n = (long)(t_in_step / half_s);
    return (n % 2 == 0) ? 1 : 0;
}

/* RECOVER 가 어디서 출발해야 하는지 — 직전 phase 가 short 계열이면 음수 쪽에서,
 * 아니면 양수 쪽에서 amb 로 복귀한다. 방향을 안 맞추면 복귀 시작 순간 온도가 부호를
 * 건너뛰며 튀어서, 정작 보려는 "해제 시점"이 그 점프에 가려진다. */
static double recover_from(int prev_kind)
{
    switch (prev_kind) {
        case PH_EDGE_SHORT:
        case PH_RAMP_SHORT:
        case PH_HOLD_SHORT:
        case PH_FLAP_SHORT:
            return SHORT_LIMIT_C + FLAP_MARGIN_C;
        default:
            return OPEN_LIMIT_C - FLAP_MARGIN_C;
    }
}

/* phase 안의 진행률 u ∈ [0,1) 에서의 합성 온도 [°C] */
static double phase_temp(int kind, double u, double phase_seconds, double amb, double recover_start)
{
    switch (kind) {
        case PH_EDGE_OPEN:
            /* 경계가 >= 인지 확인 — 임계 바로 아래 / 임계 정확히 / 임계 바로 위 */
            if (u < 1.0 / 3.0) return OPEN_LIMIT_C - 1.0;
            if (u < 2.0 / 3.0) return OPEN_LIMIT_C;
            return OPEN_LIMIT_C + 1.0;

        case PH_EDGE_SHORT:
            /* 경계가 <= 인지 확인 */
            if (u < 1.0 / 3.0) return SHORT_LIMIT_C + 1.0;
            if (u < 2.0 / 3.0) return SHORT_LIMIT_C;
            return SHORT_LIMIT_C - 1.0;

        case PH_RAMP_OPEN:
            return lerp(amb, OPEN_LIMIT_C + OVERSHOOT_C, u);

        case PH_RAMP_SHORT:
            return lerp(amb, SHORT_LIMIT_C - OVERSHOOT_C, u);

        case PH_HOLD_OPEN:
            return OPEN_LIMIT_C + OVERSHOOT_C;

        case PH_HOLD_SHORT:
            return SHORT_LIMIT_C - OVERSHOOT_C;

        case PH_FLAP_OPEN:
            /* 임계를 프레임 단위로 들락거리게 만들어 해제 디바운스를 시험한다 */
            return flap_high(u, phase_seconds)
                   ? OPEN_LIMIT_C + FLAP_MARGIN_C
                   : OPEN_LIMIT_C - FLAP_MARGIN_C;

        case PH_FLAP_SHORT:
            return flap_high(u, phase_seconds)
                   ? SHORT_LIMIT_C - FLAP_MARGIN_C
                   : SHORT_LIMIT_C + FLAP_MARGIN_C;

        case PH_RECOVER:
            /* 직전 fault 구간 근방 값에서 amb 로 선형 복귀 (방향은 recover_from 이 정함) */
            return lerp(recover_start, amb, u);

        case PH_HOLD_AMB:
        default:
            return amb;
    }
}

int ff_prot_init(void)
{
    g_elapsed_s   = 0.0;
    g_initialized = 1;
    return FF_PROT_OK;
}

int ff_prot_set_param(void)
{
    return FF_PROT_OK;
}

int ff_prot_start_exec(void       *buf,
                       uint32_t    samples_per_ch,
                       uint32_t    bytes_per_sample,
                       uint32_t    channels,
                       int32_t     amb_temp,
                       void       *spk_temp,
                       void       *spk_exc,
                       const void *v_sensing,
                       const void *i_sensing)
{
    /* 벤더 ABI와 같은 입력 검증 — 진단용이어도 계약은 그대로 지킨다 */
    if (!g_initialized)                 return FF_PROT_ERR_NOT_INIT;
    if (!buf || !spk_temp || !spk_exc)  return FF_PROT_ERR_NULL_ARG;
    if (bytes_per_sample != 2)          return FF_PROT_ERR_BAD_FORMAT;
    if (channels > FF_PROT_MAX_CH)      return FF_PROT_ERR_TOO_MANY_CH;
    if (samples_per_ch == 0)            return FF_PROT_ERR_BAD_FORMAT;

    /* 오디오와 실측 V/I 는 의도적으로 무시한다 — 온도를 시간의 함수로만 합성해야
     * 시나리오가 재현 가능해진다. buf 는 단 한 바이트도 쓰지 않는다(패스스루). */
    (void)v_sensing;
    (void)i_sensing;

    int32_t *outT = (int32_t *)spk_temp;
    int32_t *outE = (int32_t *)spk_exc;

    double amb = (double)amb_temp;
    if (amb < AMB_MIN_C) amb = AMB_MIN_C;
    if (amb > AMB_MAX_C) amb = AMB_MAX_C;

    /* 이번 블록의 대표 시각 — 블록 시작 시점을 쓴다(프레임 단위 계단이 곧 관측 해상도) */
    const double t_now  = g_elapsed_s;
    const double period = sweep_period_s();
    double t = t_now;
    if (period > 0.0) {
        while (t >= period) t -= period;   /* fmod 없이 주기 접기 (math.h 불필요) */
    }

    int    phase_index    = PHASE_COUNT - 1;
    double phase_start    = 0.0;
    double phase_seconds  = g_phases[PHASE_COUNT - 1].seconds;
    double acc = 0.0;
    for (int i = 0; i < PHASE_COUNT; ++i) {
        if (t < acc + g_phases[i].seconds) {
            phase_index   = i;
            phase_start   = acc;
            phase_seconds = g_phases[i].seconds;
            break;
        }
        acc += g_phases[i].seconds;
    }

    const int prev_kind = g_phases[(phase_index + PHASE_COUNT - 1) % PHASE_COUNT].kind;
    const double u = phase_seconds > 0.0 ? (t - phase_start) / phase_seconds : 0.0;
    const double temp_c = phase_temp(g_phases[phase_index].kind, u, phase_seconds, amb,
                                     recover_from(prev_kind));

    /* 변위에는 phase 번호를 실어 보낸다 — Excursion 차트가 진행 상황 표시등이 된다 */
    const double exc_um = (double)phase_index * PHASE_EXC_STEP_UM;

    /* 온도는 앱이 ch0 만 읽지만(wasm-client.ts), 계약상 모든 채널을 채운다.
     * ⚠ 여기서는 음수를 자르지 않는다 — Speaker Short 경로를 실행해 보는 것이 목적이다. */
    const int32_t t_out = (int32_t)(temp_c >= 0.0 ? temp_c + 0.5 : temp_c - 0.5);
    const int32_t e_out = (int32_t)(exc_um + 0.5);
    for (uint32_t ch = 0; ch < channels; ++ch) {
        outT[ch] = t_out;
        outE[ch] = e_out;
    }

    /* 블록 하나가 지난 만큼 시간을 전진시킨다(채널 루프 밖 — 블록당 1회) */
    g_elapsed_s += (double)samples_per_ch / DEFAULT_SAMPLE_RATE_HZ;

    return FF_PROT_OK;
}

int ff_prot_stop_exec(void)
{
    g_initialized = 0;
    g_elapsed_s   = 0.0;
    return FF_PROT_OK;
}
