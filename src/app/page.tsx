// Next.js는 이 값을 리터럴 문자열로만 정적 분석한다(삼항식 등 계산식 불가).
// 정적 빌드(desktop/tauri)는 scripts/build/build-static-local.sh가 빌드 중 force-static으로 치환한다; force-dynamic은 next start에서 USE_QUEUE를 런타임 반영하기 위한 값이다.
export const dynamic = "force-dynamic";

import DashboardPage from "@/features/audio/components/dashboard/DashboardClient";

export default function Page() {
  const useQueue = process.env.USE_QUEUE !== "false";
  return <DashboardPage useQueue={useQueue} />;
}
