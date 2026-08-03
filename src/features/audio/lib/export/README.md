# export

## 1. 도메인 설명

캡처된 분석 프레임(시간·온도·변위)을 CSV 문자열로 바꾸는 도메인입니다. Workspace에 저장한 세션을 엑셀이나 데이터 분석 도구에서 표로 열어볼 때, JSON 대신 이 형식을 고르면 됩니다.

## 2. 프로젝트 전반에서의 역할

Workspace의 내보내기(export) 기능 중 CSV 포맷만 담당하는 leaf 유틸입니다. JSON 내보내기는 `workspace/hooks/useWorkspaceItems.ts`가 그 자리에서 직접 조립하지만 CSV 변환 로직만은 이 도메인에 따로 두었습니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `csv.ts` | `AnalysisFrame[]`을 `time,temperature,excursion` 헤더의 CSV 문자열로 직렬화 |

## 4. 의존성 및 흐름

- **가져오는 것**: `features/audio/types`의 `AnalysisFrame` 타입 하나만 참조합니다. 다른 의존성은 없습니다.
- **호출하는 쪽**: `workspace/hooks/useWorkspaceItems.ts`의 `exportCsv`입니다. 저장된 세션의 프레임 배열을 `framesToCsv()`로 변환한 뒤 `text/csv` Blob으로 감싸 `downloadBlob()`(`shared/lib/utils.ts`)으로 저장합니다.

```
useWorkspaceItems.exportCsv → export/csv.ts:framesToCsv() → Blob → downloadBlob()
```

## 5. 주요 인터페이스 / 진입점

- **`framesToCsv(frames: AnalysisFrame[]): string`** — 프레임 배열을 CSV 문자열로 변환합니다. 첫 줄은 항상 `time,temperature,excursion` 헤더이고, 이후 각 줄이 프레임 하나에 대응합니다. 값 이스케이핑이나 구분자 커스터마이징은 하지 않습니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
