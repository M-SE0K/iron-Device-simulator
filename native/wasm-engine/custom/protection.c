/* debug/half_gain.c — 원음을 게인 0.5(50% 감소)로 고정 감쇠해 내보내는 디버그 알고리즘.
 * 빌드: FF_PROT_SRCS=custom/debug/half_gain.c */
#include "protection.h"
#include <stdio.h>
#define HALF_GAIN 0.5

static int g_initialized = 0;

int ff_prot_init(void)
{
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
    (void)v_sensing;
    (void)i_sensing;

    if (!g_initialized)                 return FF_PROT_ERR_NOT_INIT;
    if (!buf || !spk_temp || !spk_exc)  return FF_PROT_ERR_NULL_ARG;
    if (bytes_per_sample != 2)          return FF_PROT_ERR_BAD_FORMAT;
    if (channels > FF_PROT_MAX_CH)      return FF_PROT_ERR_TOO_MANY_CH;
    if (samples_per_ch == 0)            return FF_PROT_ERR_BAD_FORMAT;

    int16_t *pcm = (int16_t *)buf;
    for (uint32_t ch = 0; ch < channels; ++ch) {
        int16_t *x = pcm + (size_t)ch * samples_per_ch;
        for (uint32_t i = 0; i < samples_per_ch; ++i) {
            x[i] = (int16_t)(x[i] * HALF_GAIN);
        }
    }

    int32_t *outT = (int32_t *)spk_temp;
    int32_t *outE = (int32_t *)spk_exc;
    for (uint32_t ch = 0; ch < channels; ++ch) {
        outT[ch] = amb_temp;
        outE[ch] = 0;
    }

    return FF_PROT_OK;
}

int ff_prot_stop_exec(void)
{
    g_initialized = 0;
    return FF_PROT_OK;
}
