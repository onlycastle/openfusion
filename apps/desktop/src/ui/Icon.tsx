export type IconName =
  | "add"
  | "chevronDown"
  | "close"
  | "evaluations"
  | "folder"
  | "harness"
  | "menu"
  | "more"
  | "settings"
  | "studio"
  | "trash";

interface IconProps {
  name: IconName;
  size?: number;
}

const PATHS: Record<IconName, ReactNode> = {
  add: <path d="M8 3v10M3 8h10" />,
  chevronDown: <path d="m4 6 4 4 4-4" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  evaluations: <><path d="M3 13V8M8 13V3M13 13V6" /><path d="M2 13.5h12" /></>,
  folder: <path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h2.9c.4 0 .78.16 1.06.44l.86.86h4.68c.83 0 1.5.67 1.5 1.5v5.7c0 .83-.67 1.5-1.5 1.5H3.25c-.83 0-1.5-.67-1.5-1.5v-7Z" />,
  harness: <><circle cx="8" cy="3.25" r="1.5" /><circle cx="3.25" cy="12.5" r="1.5" /><circle cx="12.75" cy="12.5" r="1.5" /><path d="M8 4.75v3M8 7.75 3.9 11M8 7.75l4.1 3.25" /></>,
  menu: <><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" /></>,
  more: <><circle cx="3.5" cy="8" r=".7" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r=".7" fill="currentColor" stroke="none" /><circle cx="12.5" cy="8" r=".7" fill="currentColor" stroke="none" /></>,
  settings: <><circle cx="8" cy="8" r="2.15" /><path d="M8 1.75v1.3M8 12.95v1.3M1.75 8h1.3M12.95 8h1.3M3.58 3.58l.92.92M11.5 11.5l.92.92M12.42 3.58l-.92.92M4.5 11.5l-.92.92" /></>,
  studio: <><path d="M3 11.75V4.25A1.25 1.25 0 0 1 4.25 3h7.5A1.25 1.25 0 0 1 13 4.25v7.5A1.25 1.25 0 0 1 11.75 13h-7.5A1.25 1.25 0 0 1 3 11.75Z" /><path d="m6 10 4-4M6 6h4v4" /></>,
  trash: <><path d="M3.25 4.5h9.5M6 2.75h4M4.5 4.5l.6 8.25h5.8l.6-8.25" /><path d="M6.5 6.75v3.75M9.5 6.75v3.75" /></>,
};

export function Icon({ name, size = 16 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name]}
    </svg>
  );
}
import type { ReactNode } from "react";
