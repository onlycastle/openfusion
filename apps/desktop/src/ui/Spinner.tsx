interface SpinnerProps {
  label?: string;
  size?: "small" | "medium";
}

export function Spinner({ label = "Working", size = "small" }: SpinnerProps) {
  return <span className={`ui-spinner ui-spinner-${size}`} role="status" aria-label={label} />;
}
