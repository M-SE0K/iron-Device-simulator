export const dynamic = "force-dynamic";

import DashboardPage from "./dashboard-client";

export default function Page() {
  const useQueue = process.env.USE_QUEUE !== "false";
  return <DashboardPage useQueue={useQueue} />;
}
