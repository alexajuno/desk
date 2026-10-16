import { useEffect, useRef } from "react";
import { frame } from "../store/frame";
import type { IssuePageData } from "./IssueView";

// A session that starts or stops working changes no issue, so the sync socket's changes miss it, yet the strip says
// it: an open issue, on its page or in the Inbox's right pane, draws again when the frame desk sends says its session
// moved. The caller is an observer, so a new frame draws it again.
export function useLive(shown: IssuePageData | null | undefined, reload: () => void) {
  const now = shown ? frame.data?.live[shown.issue.slug] : undefined;
  const drawn = useRef(shown?.live);
  drawn.current = shown?.live;
  useEffect(() => {
    if (now !== undefined && now !== drawn.current) reload();
  }, [now, reload]);
}
