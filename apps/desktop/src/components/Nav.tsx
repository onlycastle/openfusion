import type { ReactNode } from "react";
import type { Route } from "../router";
import { FusionMark } from "./Logo";

/* Small stroke icons, 15px, drawn on currentColor so they inherit each nav
 * link's resting/hover/active ink. Inline SVG (not an icon font or CDN
 * package) keeps the strict local-only CSP happy. */
function RouteIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="3.5" cy="12.5" r="1.75" />
      <circle cx="12.5" cy="3.5" r="1.75" />
      <path d="M5.25 12.5h4a3 3 0 0 0 3-3V5.25" />
    </svg>
  );
}

function GaugeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M2 12.5a6.5 6.5 0 1 1 12 0" />
      <path d="M8 12.5 11 7" strokeLinecap="round" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 1.75v1.9M8 12.35v1.9M1.75 8h1.9M12.35 8h1.9M3.58 3.58l1.35 1.35M11.07 11.07l1.35 1.35M12.42 3.58l-1.35 1.35M4.93 11.07l-1.35 1.35" strokeLinecap="round" />
    </svg>
  );
}

interface NavItem {
  route: Route;
  label: string;
  icon: ReactNode;
}

/* The workspace — where work happens. The project itself is chosen inside
 * the Studio (the composer's project chip), so there is no separate Project
 * destination anymore. ("Studio" is the user-facing name for the screen that
 * drives the engine's orchestrate loop — see router.ts on the vocabulary.) */
const WORKSPACE_ITEMS: NavItem[] = [{ route: "studio", label: "Studio", icon: <RouteIcon /> }];

/* Instruments — readouts you consult, not places you work. Evals measures
 * the harness's honesty; it never produces work of its own. */
const INSTRUMENT_ITEMS: NavItem[] = [{ route: "evals", label: "Evals", icon: <GaugeIcon /> }];

interface NavProps {
  current: Route;
  onNavigate: (route: Route) => void;
  onOpenSettings: () => void;
}

function NavList({
  items,
  current,
  onNavigate,
  label,
}: {
  items: NavItem[];
  current: Route;
  onNavigate: (route: Route) => void;
  label?: string;
}) {
  return (
    <ul aria-label={label}>
      {items.map(({ route, label: itemLabel, icon }) => (
        <li key={route}>
          <button
            type="button"
            className={route === current ? "nav-link nav-link-active" : "nav-link"}
            aria-current={route === current ? "page" : undefined}
            onClick={() => onNavigate(route)}
          >
            {icon}
            <span>{itemLabel}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Nav({ current, onNavigate, onOpenSettings }: NavProps) {
  return (
    /* data-tauri-drag-region: with titleBarStyle Overlay the webview covers
     * the entire window, so window-dragging must be granted back explicitly.
     * It only fires when the mousedown TARGET carries the attribute — nav
     * buttons keep their clicks; empty sidebar space moves the window, like
     * a native source list. (.sidenav-head children are pointer-events: none
     * in CSS so the head reads as one draggable surface.) */
    <nav className="sidenav" aria-label="Primary" data-tauri-drag-region>
      <div className="sidenav-head" data-tauri-drag-region>
        <FusionMark />
        <span className="sidenav-wordmark">OpenFusion</span>
      </div>
      <NavList items={WORKSPACE_ITEMS} current={current} onNavigate={onNavigate} />
      {/* The visible group label is decorative for AT — the list itself
        * carries the accessible name. */}
      <div className="sidenav-section-label" aria-hidden="true">
        Instruments
      </div>
      <NavList items={INSTRUMENT_ITEMS} current={current} onNavigate={onNavigate} label="Instruments" />
      <div className="sidenav-foot">
        <button type="button" className="nav-link" onClick={onOpenSettings}>
          <GearIcon />
          <span>Settings</span>
        </button>
      </div>
    </nav>
  );
}
