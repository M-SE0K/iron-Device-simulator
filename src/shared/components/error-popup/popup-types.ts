export type PopupVariant = "error" | "success";

export interface ErrorPopupModalProps {
  message: string;
  variant: PopupVariant;
  queuedCount: number;
  onClose: () => void;
}
