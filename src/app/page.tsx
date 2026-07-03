// Next.js는 이 값을 리터럴 문자열로만 정적 분석한다(삼항식 등 계산식 불가).
// 모바일(정적 export) 빌드는 scripts/build-mobile.sh 가 빌드 동안만 이 줄을
// "force-static"으로 임시 치환한다 — force-dynamic은 런타임 서버가 있는 일반/Docker
// 배포에서 USE_QUEUE를 재빌드 없이 재정의하기 위한 것으로, 정적 export와 호환되지 않는다.
export const dynamic = "force-dynamic";

import DashboardPage from "@/features/audio/components/DashboardClient";

export default function Page() {
  const useQueue = process.env.USE_QUEUE !== "false";
  return <DashboardPage useQueue={useQueue} />;
}
