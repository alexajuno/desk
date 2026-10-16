import { useEffect } from "react";
import type { IssuePageData } from "./IssueView";

// A session that starts or stops working changes no file, so the sync socket misses it, yet the strip says it: an
// open issue with a session, on its page or in the Inbox's right pane, asks for its state every 3 s and draws again
// when it changed (desk.js did the same).
export function useLive(shown: IssuePageData | null | undefined, reload: () => void) {
  const slug = shown?.issue.slug;
  const live = shown?.issue.session && !["done", "dropped"].includes(shown.issue.state) ? shown.live : null;
  useEffect(() => {
    if (!slug || live === null) return;
    const timer = setInterval(async () => {
      try {
        const now = await (await fetch(`/issue/${encodeURIComponent(slug)}/live`, { cache: "no-store" })).text();
        if (now !== live) reload();
      } catch {
        // desk restarting
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [slug, live, reload]);
}
