import { useEffect, useState } from "react";

const listeners = new Set<() => void>();

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (path === window.location.pathname + window.location.search) return;
  window.history[options.replace ? "replaceState" : "pushState"](null, "", path);
  for (const listener of listeners) listener();
}

/** Current pathname; re-renders on navigate() and back/forward. */
export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return path;
}
