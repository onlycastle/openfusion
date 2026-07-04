// A tiny hash-based router. Four routes total (two real, two M7c stubs)
// don't warrant pulling in react-router — this is ~30 lines instead of a
// dependency.
import { useCallback, useEffect, useState } from "react";

export const ROUTES = ["project", "keys", "orchestrate", "evals"] as const;
export type Route = (typeof ROUTES)[number];

export const DEFAULT_ROUTE: Route = "project";

function isRoute(value: string): value is Route {
  return (ROUTES as readonly string[]).includes(value);
}

function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  return isRoute(raw) ? raw : DEFAULT_ROUTE;
}

/** React state is the source of truth — `navigate` takes effect
 * synchronously, independent of the browser's (or jsdom's) `hashchange`
 * event timing — while `window.location.hash` is kept in sync alongside it
 * for deep-linking and back/forward support. A `hashchange` listener covers
 * the reverse direction (the URL changing out from under the app). */
export function useHashRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    setRoute(next);
    const nextHash = `#/${next}`;
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
  }, []);

  return [route, navigate];
}
