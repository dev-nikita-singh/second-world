/** Small data hooks: load-on-mount with loading / error state, and the current hash route. */
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiFailure } from "./api.js";
import { parseRoute, type Route } from "./lib/route.js";

export interface Async<T> {
  data: T | null;
  error: ApiFailure | null;
  loading: boolean;
  reload(): void;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): Async<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    setLoading(true);
    fn().then(
      (d) => {
        if (n !== seq.current) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (n !== seq.current) return;
        setError(
          e instanceof ApiFailure ? e : new ApiFailure(0, "ERROR", String((e as Error)?.message ?? e)),
        );
        setLoading(false);
      },
    );
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseRoute(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function navigate(hash: string): void {
  if (location.hash !== hash) location.hash = hash;
}

/** Re-runs `fn` every `ms` while the tab is visible. */
export function useInterval(fn: () => void, ms: number): void {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") saved.current();
    }, ms);
    return () => clearInterval(t);
  }, [ms]);
}
