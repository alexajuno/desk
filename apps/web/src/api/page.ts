// A page's JSON from desk (pages.ts, /api/page/...), fetched again whenever an issue changes (the sync socket's seq),
// whenever what the page also follows changes (also: an issue's files, say), and when an action registered with
// onReload asks. The last answer stays on screen while the next one comes, so a
// change redraws only what differs: no blank frame, no lost scroll or open fold.
//
// Moving to another page draws no blank frame either: each route's loader fetches the page's JSON first (prime), and
// the router keeps the old page on screen until it is in, as Linear never shows a page without its data. The first page
// waits the same way under the splash, which a page still without its data, after a slow loader, holds up
// (app/splash.ts). Every answer is kept by its address (seen), so going back to a page draws it at once, and fetches it
// again behind.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigation } from "react-router";
import { useSplash } from "../app/splash";
import { issues } from "../store/issues";
import { onReload } from "../store/ui";

interface Seen { data: unknown; at: number; seq: number }

const seen = new Map<string, Seen>();
const KEEP = 40; // pages kept; the oldest goes first
const FRESH = 2000; // ms a primed answer counts as the page's own first fetch, while no issue changed since
const WAIT = 3000; // ms a loader waits for a slow desk before the page draws without its data
const GONE = 600; // ms the page stays on an address that answered 404 before it takes the copy on screen down

function keep(url: string, data: unknown) {
  seen.delete(url);
  seen.set(url, { data, at: performance.now(), seq: issues.seq });
  while (seen.size > KEEP) seen.delete(seen.keys().next().value!);
}

// A page's JSON as last fetched, by its address, or null when it was never seen.
export const seenPage = <T>(url: string) => (seen.get(url)?.data as T | undefined) ?? null;

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

export function usePage<T>(url: string, also: string | number = "") {
  const [data, setData] = useState<T | null>(() => (seen.get(url)?.data as T) ?? null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);
  const seq = issues.seq; // read in render: the component is an observer, so a change draws it again
  const moving = useRef(false);
  moving.current = useNavigation().state !== "idle";
  useEffect(() => () => { ++asked.current; }, []); // gone from the screen: nothing it asked for lands

  // A 404 takes the copy on screen down, so a page whose issue is gone says so rather than freeze (31 Oct). Not at
  // once: a new title answers 404 at the old address while the page moves to the new one (issues/actions.ts, follow;
  // frame/Frame.tsx), so the 404 stands only once the page has stayed on the address a moment, moving nowhere.
  const takeDown = useCallback((mine: number) => {
    setTimeout(() => {
      if (mine !== asked.current) return;
      if (moving.current) return takeDown(mine);
      seen.delete(url);
      setData(null);
    }, GONE);
  }, [url]);

  const reload = useCallback(async () => {
    const mine = ++asked.current;
    const res = await fetchPage(url);
    if (!res || mine !== asked.current) return;
    if (!res.ok) {
      setError(res.status === 404 ? "That issue is gone." : `Failed (${res.status})`);
      if (res.status === 404) takeDown(mine);
      return;
    }
    const json = (await res.json()) as T;
    if (mine !== asked.current) return;
    keep(url, json);
    setError(null);
    setData(json);
  }, [url, takeDown]);

  // A new address: what was seen of it shows at once. Its loader's answer, just fetched with no issue changed since,
  // stands as the page's first; anything else, and every change to an issue, is fetched again. The old address's
  // answers still coming are dropped: opening an Inbox row writes that you read it, a change that has the page left
  // fetch itself again as the router moves on, and its late answer drew the Inbox with nothing open (19 Oct).
  const shownUrl = useRef<string | null>(null);
  useEffect(() => {
    const moved = shownUrl.current !== url;
    shownUrl.current = url;
    if (moved) ++asked.current;
    const known = seen.get(url);
    if (moved && known) {
      setError(null);
      setData(known.data as T);
      if (known.seq === issues.seq && performance.now() - known.at < FRESH) return;
    }
    reload();
  }, [reload, seq, also]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onReload(reload), [reload]);
  useSplash(!data && !error);
  return { data, error, reload };
}
