/*
 * dummy_algo.c — 검증 전용 더미 보호 알고리즘.
 *
 * 실제 벤더 알고리즘(그리고 리포에 커밋되지 않는 참조 스텁 ff_prot.c)을 대신해,
 * "알고리즘팀이 자기 .c 를 custom/ 에 넣었을 때 빌드 파이프라인이 끝까지 도는가"만
 * 검증하기 위한 최소 구현이다. 물리 모델로서의 의미는 없다.
 *
 * ⚠️ 헤더를 include 하지 않는 것은 의도적이다.
 *    native/wasm-engine/.gitignore 가 ff_prot.h 를 제외하므로 **신규 클론에는 그 헤더가
 *    존재하지 않는다**. custom/README.md 의 래퍼 예시는 #include "ff_prot.h" 를 쓰지만,
 *    갓 클론한 사람이 그대로 따라 하면 컴파일이 깨진다. 이 fixture 는 알고리즘팀이
 *    실제로 놓이는 상황(헤더 없음)을 재현해야 하므로 시그니처를 직접 선언한다.
 *    (이 불일치 자체는 L0 시나리오가 별도 항목으로 보고한다.)
 *
 * ABI — src/features/audio/lib/engine/adapters/wasm-client.ts 가 실제로 쓰는 모양:
 *   buf        : int16 planar 2ch [ch0=V, ch1=I], samples_per_ch 개씩. in/out 겸용.
 *   spk_temp   : int32[2] — 채널별 온도. 앱은 ch0 만 대표값으로 읽는다.
 *   spk_exc    : int32[2] — 채널별 변위.
 *   v_sensing  : int16 mono [samples_per_ch] — ch0 를 deinterleave 한 것.
 *   i_sensing  : int16 mono [samples_per_ch] — ch1 를 deinterleave 한 것.
 */

#include <stdint.h>
#include <stddef.h>

/* 앰비언트 대비 상승분이 실제로 차트에 흐르는지 보려고 프레임 간 상태를 유지한다.
 * (드롭인 알고리즘이 대개 stateful 이라는 점도 함께 흉내 낸다) */
static double g_temp_c = 0.0;
static int    g_started = 0;

int ff_prot_init(void)
{
    g_temp_c = 0.0;
    g_started = 1;
    return 0;
}

int ff_prot_set_param(void)
{
    return 0;
}

int ff_prot_start_exec(void *buf,
                       uint32_t samples_per_ch,
                       uint32_t bytes_per_sample,
                       uint32_t channels,
                       int32_t amb_temp,
                       void *spk_temp,
                       void *spk_exc,
                       const void *v_sensing,
                       const void *i_sensing)
{
    const int16_t *v = (const int16_t *)v_sensing;
    const int16_t *i = (const int16_t *)i_sensing;
    int32_t *temp_out = (int32_t *)spk_temp;
    int32_t *exc_out  = (int32_t *)spk_exc;

    if (!g_started || buf == NULL || temp_out == NULL || exc_out == NULL) {
        return -1;
    }
    if (bytes_per_sample != 2u || channels != 2u || samples_per_ch == 0u) {
        return -2;   /* 이 클라이언트는 항상 int16 스테레오 프레임을 보낸다 */
    }

    /* P = mean(v * i) — 실측 V/I 가 있을 때 참조 스텁이 쓰는 것과 같은 형태.
     * 없으면(NULL) 0 전력으로 두고 앰비언트로 수렴시킨다. */
    double power = 0.0;
    if (v != NULL && i != NULL) {
        double acc = 0.0;
        for (uint32_t n = 0; n < samples_per_ch; ++n) {
            acc += ((double)v[n] / 32768.0) * ((double)i[n] / 32768.0);
        }
        power = acc / (double)samples_per_ch;
        if (power < 0.0) power = -power;
    }

    /* 1차 RC 열모델 근사 — 값 자체는 무의미하고, 프레임마다 변해서 차트가 살아 있는지
     * 눈으로 확인할 수 있으면 충분하다. */
    g_temp_c += (power * 400.0 - g_temp_c) * 0.02;

    const int32_t temp = amb_temp + (int32_t)g_temp_c;
    const int32_t exc  = (int32_t)(power * 1000.0);

    temp_out[0] = temp; temp_out[1] = temp;
    exc_out[0]  = exc;  exc_out[1]  = exc;

    /* buf 는 in/out 겸용 — 더미는 감쇠 없이 그대로 통과시킨다(pass-through). */
    (void)buf;
    return 0;
}

int ff_prot_stop_exec(void)
{
    g_started = 0;
    g_temp_c = 0.0;
    return 0;
}
