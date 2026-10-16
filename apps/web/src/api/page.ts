// A page's JSON from desk (pages.ts, /api/page/...), fetched again whenever an issue changes (the sync socket's seq)
// and when an action registered with onReload asks. The last answer stays on screen while the next one comes, so a
// change redraws only what differs: no blank frame, no lost scroll or open fold.
//
// Moving to another page draws no blank frame either: each route's loader fetches the page's JSON first (prime), and
// the router keeps the old page on screen until it is in, as Linear never shows a page without its data. Every answer is
// kept by its address (seen), so going back to a page draws it at once, and fetches it again behind.
import { useCallback, useEffect, useRef, useState } from "react";
import { issues } from "../store/issues";
import { onReload } from "../store/ui";

interface Seen { data: unknown; at: number; seq: number }

const seen = new Map<string, Seen>();
const KEEP = 40; // pages kept; the oldest goes first
const FRESH = 2000; // ms a primed answer counts as the page's own first fetch, while no issue changed since
const WAIT = 3000; // ms a loader waits for a slow desk before the page draws without its data

function keep(url: string, data: unknown) {
  seen.delete(url);
  seen.set(url, { data, at: performance.now(), seq: issues.seq });
  while (seen.size > KEEP) seen.delete(seen.keys().next().value!);
}

async function fetchPage(url: string): Promise<Response | null> {
  try {
    return await fetch(url, { cache: "no-store" });
  } catch {
    return null; // desk restarting: the sync socket's snapshot on reconnect asks again
  }
}

// A route's loader: the page's JSON fetched before the router moves to it, unless the page was seen already, which it
// draws at once. It never holds a move longer than WAIT.
export async function prime(url: string): Promise<null> {
  if (seen.has(url)) return null;
  const load = (async () => {
    const res = await fetchPage(url);
    if (res?.ok) keep(url, await res.json());
  })();
  await Promise.race([load, new Promise((r) => setTimeout(r, WAIT))]);
  return null;
}

export function usePage<T>(url: string) {
  const [data, setData] = useState<T | null>(() => (seen.get(url)?.data as T) ?? null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);
  const seq = issues.seq; // read in render: the component is an observer, so a change draws it again

  const reload = useCallback(async () => {
    const mine = ++asked.current;
    const res = await fetchPage(url);
    if (!res || mine !== asked.current) return;
    if (!res.ok) {
      setError(res.status === 404 ? "That issue is gone." : `Failed (${res.status})`);
      return;
    }
    const json = (await res.json()) as T;
    if (mine !== asked.current) return;
    keep(url, json);
    setError(null);
    setData(json);
  }, [url]);

  // A new address: what was seen of it shows at once. Its loader's answer, just fetched with no issue changed since,
  // stands as the page's first; anything else, and every change to an issue, is fetched again.
  const shownUrl = useRef<string | null>(null);
  useEffect(() => {
    const moved = shownUrl.current !== url;
    shownUrl.current = url;
    const known = seen.get(url);
    if (moved && known) {
      setError(null);
      setData(known.data as T);
      if (known.seq === issues.seq && performance.now() - known.at < FRESH) return;
    }
    reload();
  }, [reload, seq]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onReload(reload), [reload]);
  return { data, error, reload };
}
