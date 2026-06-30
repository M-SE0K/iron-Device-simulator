export const dynamic = "force-dynamic";

import DashboardPage from "@/features/audio/components/DashboardClient";

export default function Page() {
  const useQueue = process.env.USE_QUEUE !== "false";
  return <DashboardPage useQueue={useQueue} />;
}
