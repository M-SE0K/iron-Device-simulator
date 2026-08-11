import { saveFileViaTauri } from "./tauri-bridge/file-export";

/** Blob을 즉시 파일로 다운로드 (임시 <a> 클릭 방식) */
export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  // Tauri 네이티브 웹뷰(특히 macOS WKWebView)는 blob: URL + `<a download>` 클릭으로
  // 저장 다이얼로그를 띄우지 못하는 것으로 알려져 있다 — Tauri 런타임에서는 네이티브
  // 저장 다이얼로그를 여는 Rust 커맨드로 우회한다(일반 브라우저는 기존 앵커 다운로드 유지).
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    await saveFileViaTauri(blob, filename);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // revoke를 동기로 하면 일부 브라우저에서 다운로드가 취소된다 — 다음 tick으로 미룬다.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
