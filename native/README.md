# native/ — ff_prot 참조 구현 (검증용 `libirontune.so` 스텁)

> ⚠️ **정품 아님.** Iron Device 정품 `libirontune.so` 의 원본 소스를 아직 받지 못해
> 임의로 구성한 **물리 근사 모델**입니다. 실제로는 이 `.c` 소스를 Emscripten으로
> 브라우저 타깃 WASM(`public/wasm/ff_prot.{js,wasm}`, `build-wasm.sh`)으로 컴파일해
> `src/features/audio/lib/engine/adapters/wasm-client.ts`가 브라우저 안에서 직접
> 호출한다 — `.so`/koffi FFI 로딩 경로는 쓰이지 않는다. 정품 소스를 받으면 이
> 디렉터리는 폐기합니다.

## 함수 시그니처 (adapters/wasm-client.ts 와 1:1)

| 함수 | 시그니처 |
|---|---|
| `ff_prot_init` | `int (void)` |
| `ff_prot_set_param` | `int (void)` — 현재 사실상 NOP |
| `ff_prot_start_exec` | `int (void* buf, uint32 samples_per_ch, uint32 bytes_per_sample, uint32 channels, int32 amb_te
