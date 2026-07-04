import type { Route } from "../router";

const NAV_ITEMS: Array<{ route: Route; label: string }> = [
  { route: "project", label: "Project" },
  { route: "keys", label: "Keys" },
  { route: "orchestrate", label: "Orchestrate" },
  { route: "evals", label: "Evals" },
];

interface NavProps {
  current: Route;
  onNavigate: (route: Route) => void;
}

export function Nav({ current, onNavigate }: NavProps) {
  return (
    <nav className="sidenav" aria-label="Primary">
      <div className="sidenav-brand">OpenFusion</div>
      <ul>
        {NAV_ITEMS.map(({ route, label }) => (
          <li key={route}>
            <button
              type="button"
              className={route === current ? "nav-link nav-link-active" : "nav-link"}
              aria-current={route === current ? "page" : undefined}
              onClick={() => onNavigate(route)}
            >
              {label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
