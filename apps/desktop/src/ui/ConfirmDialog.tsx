import { useRef } from "react";
import { Dialog } from "./Dialog";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  return (
    <Dialog
      open={open}
      title={title}
      description={description}
      onClose={onCancel}
      dismissOnBackdrop={false}
      initialFocusRef={cancelRef}
      size="small"
      footer={
        <>
          <button ref={cancelRef} type="button" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={destructive ? "ui-button-destructive" : "ui-button-primary"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? `${confirmLabel}…` : confirmLabel}
          </button>
        </>
      }
    >
      <span className="sr-only">Choose {cancelLabel} to keep the current state.</span>
    </Dialog>
  );
}
