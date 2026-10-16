// A page's JSON from desk (app.py, /api/page/...), fetched again whenever an issue changes (the sync socket's seq)
// and when an action registered with onReload asks. The last answer stays on screen while the next one comes, so a
// change redraws only what differs: no blank frame, no lost scroll or open fold.
import { useCallback, useEffect, useRef, useState } from "react";
import { issues } from "../store/issues";
import { onReload } from "../store/ui";

export function usePage<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);
  const seq = issues.seq; // read in render: the component is an observer, so a change draws it again

  const reload = useCallback(async () => {
    const mine = ++asked.current;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (mine !== asked.current) return;
      if (!res.ok) {
        setError(res.status === 404 ? "That issue is gone." : `Failed (${res.status})`);
        return;
      }
      const json = (await res.json()) as T;
      if (mine !== asked.current) return;
      setError(null);
      setData(json);
    } catch {
      // desk restarting: the sync socket's snapshot on reconnect asks again
    }
  }, [url]);

  useEffect(() => { reload(); }, [reload, seq]);
  useEffect(() => onReload(reload), [reload]);
  return { data, error, reload };
}
