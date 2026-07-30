export type PopupVariant = "error" | "success";

export interface ErrorPopupModalProps {
  message: string;
  variant: PopupVariant;
  /** 이 팝업 뒤에 아직 대기 중인 메시지 개수 — 0이면 배지를 표시하지 않는다. */
  queuedCount: number;
  onClose: () => void;
}
