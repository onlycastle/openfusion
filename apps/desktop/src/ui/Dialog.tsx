import { useEffect, useRef, type MouseEvent, type ReactNode, type RefObject } from "react";
import { Icon } from "./Icon";

interface DialogProps {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  dismissOnBackdrop?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  size?: "small" | "medium" | "large";
}

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function Dialog({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  closeLabel = "Close",
  dismissOnBackdrop = true,
  initialFocusRef,
  size = "medium",
}: DialogProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = `dialog-title-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const descriptionId = `${titleId}-description`;

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const target = initialFocusRef?.current ?? surfaceRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? surfaceRef.current;
    target?.focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" || (event.key === "." && event.metaKey)) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !surfaceRef.current) return;
      const controls = Array.from(surfaceRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (controls.length === 0) {
        event.preventDefault();
        surfaceRef.current.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      openerRef.current?.focus();
    };
  }, [initialFocusRef, onClose, open]);

  if (!open) return null;

  const handleBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (dismissOnBackdrop && event.currentTarget === event.target) onClose();
  };

  return (
    <div className="ui-dialog-backdrop" onMouseDown={handleBackdrop}>
      <div
        ref={surfaceRef}
        className={`ui-dialog ui-dialog-${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="ui-dialog-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <button type="button" className="ui-icon-button" onClick={onClose} aria-label={closeLabel}>
            <Icon name="close" />
          </button>
        </header>
        <div className="ui-dialog-body">{children}</div>
        {footer && <footer className="ui-dialog-footer">{footer}</footer>}
      </div>
    </div>
  );
}
