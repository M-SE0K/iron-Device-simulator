"use client";

// 로그인 / 회원가입 페이지 (docs/01-authentication.md)
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type Mode = "login" | "signup";

export default function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";

  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ type: "error" | "ok"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/signup";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        setMsg({ type: "error", text: data.error ?? "요청 실패" });
        return;
      }

      if (mode === "login") {
        // 로그인 성공 → 역할에 따라 이동
        const role = data.user?.role;
        router.push(role === "ADMIN" ? "/admin/users" : next);
        router.refresh();
      } else {
        // 가입 성공 → 승인 대기 안내 후 로그인 모드로
        setMsg({ type: "ok", text: data.message ?? "가입 신청 완료" });
        setMode("login");
        setPassword("");
      }
    } catch {
      setMsg({ type: "error", text: "네트워크 오류" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-iron-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-iron-100 p-8">
        <h1 className="text-xl font-semibold text-iron-900 mb-1">
          {mode === "login" ? "로그인" : "회원가입"}
        </h1>
        <p className="text-sm text-iron-400 mb-6">Iron Device 분석 대시보드</p>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-iron-600 mb-1">이메일</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-iron-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/40"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-iron-600 mb-1">비밀번호</label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-iron-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/40"
              placeholder="8자 이상"
            />
          </div>

          {msg && (
            <div
              className={`text-sm rounded-lg px-3 py-2 ${
                msg.type === "error"
                  ? "bg-red-50 text-red-600"
                  : "bg-green-50 text-green-700"
              }`}
            >
              {msg.text}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full bg-brand-blue text-white rounded-lg py-2.5 text-sm font-medium hover:bg-brand-blue-dark transition disabled:opacity-50"
          >
            {busy ? "처리 중…" : mode === "login" ? "로그인" : "가입 신청"}
          </button>
        </form>

        <button
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setMsg(null);
          }}
          className="mt-4 w-full text-center text-sm text-brand-blue hover:underline"
        >
          {mode === "login" ? "계정이 없으신가요? 회원가입" : "이미 계정이 있으신가요? 로그인"}
        </button>
      </div>
    </div>
  );
}
