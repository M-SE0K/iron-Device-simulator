"use client";

// admin 사용자 승인 탭 (docs/01-authentication.md §5.3, 명세 §로그인/회원가입)
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface AdminUser {
  id: string;
  email: string;
  role: "ADMIN" | "USER";
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
}

const STATUS_STYLE: Record<AdminUser["status"], string> = {
  PENDING: "bg-amber-50 text-amber-700",
  APPROVED: "bg-green-50 text-green-700",
  REJECTED: "bg-red-50 text-red-600",
};

export default function AdminUsersPage() {
  const router = useRouter();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [filter, setFilter] = useState<"ALL" | AdminUser["status"]>("PENDING");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setCurrentUserId(data?.user?.id ?? null));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const qs = filter === "ALL" ? "" : `?status=${filter}`;
    const res = await fetch(`/api/admin/users${qs}`);
    if (!res.ok) {
      setError("목록을 불러오지 못했습니다.");
      setLoading(false);
      return;
    }
    const data = await res.json();
    setUsers(data.users);
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  async function setStatus(id: string, status: AdminUser["status"]) {
    const res = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (res.ok) load();
    else {
      const data = await res.json();
      alert(data.error ?? "변경 실패");
    }
  }

  async function setRole(id: string, role: AdminUser["role"]) {
    const res = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (res.ok) load();
    else {
      const data = await res.json();
      alert(data.error ?? "변경 실패");
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  return (
    <div className="min-h-screen bg-iron-50 px-6 py-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-iron-900">사용자 승인 관리</h1>
            <p className="text-sm text-iron-400">신규 가입 요청을 승인하거나 거부합니다.</p>
          </div>
          <button onClick={logout} className="text-sm text-iron-500 hover:text-iron-900">
            로그아웃
          </button>
        </div>

        {/* 필터 */}
        <div className="flex gap-2 mb-4">
          {(["PENDING", "APPROVED", "REJECTED", "ALL"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                filter === f
                  ? "bg-brand-blue text-white"
                  : "bg-white text-iron-500 border border-iron-200 hover:bg-iron-100"
              }`}
            >
              {f === "ALL" ? "전체" : f}
            </button>
          ))}
        </div>

        <div className="bg-white rounded-xl border border-iron-100 overflow-hidden">
          {loading ? (
            <div className="p-8 text-center text-sm text-iron-400">불러오는 중…</div>
          ) : error ? (
            <div className="p-8 text-center text-sm text-red-500">{error}</div>
          ) : users.length === 0 ? (
            <div className="p-8 text-center text-sm text-iron-400">해당 상태의 사용자가 없습니다.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-iron-400 border-b border-iron-100">
                  <th className="px-4 py-3 font-medium">이메일</th>
                  <th className="px-4 py-3 font-medium">역할</th>
                  <th className="px-4 py-3 font-medium">상태</th>
                  <th className="px-4 py-3 font-medium text-right">동작</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-iron-50 last:border-0">
                    <td className="px-4 py-3 text-iron-900">{u.email}</td>
                    <td className="px-4 py-3">
                      <select
                        value={u.role}
                        disabled={u.id === currentUserId}
                        onChange={(e) => setRole(u.id, e.target.value as AdminUser["role"])}
                        className="px-2 py-1 rounded-md border border-iron-200 text-xs text-iron-700 bg-white disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <option value="USER">USER</option>
                        <option value="ADMIN">ADMIN</option>
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[u.status]}`}>
                        {u.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right space-x-2">
                      {u.status !== "APPROVED" && (
                        <button
                          onClick={() => setStatus(u.id, "APPROVED")}
                          className="px-2.5 py-1 rounded-md bg-green-600 text-white text-xs hover:bg-green-700"
                        >
                          승인
                        </button>
                      )}
                      {u.status !== "REJECTED" && (
                        <button
                          onClick={() => setStatus(u.id, "REJECTED")}
                          className="px-2.5 py-1 rounded-md bg-red-500 text-white text-xs hover:bg-red-600"
                        >
                          거부
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
