// The side of an issue's chat ("i feel like the plan should be on the sidebar i suppse? with all the artifacts
// generated?", the user, 27 Oct), under its top bar's "Plan": the plan as it stands, then what the chat made, its plan,
// its card and its images, each a row that brings its message into view. An earlier send of the plan or the card is
// left out: desk keeps only the latest, so it is a line in the chat with nothing to see. It stays put beside the chat,
// and ] hides it (store/dock.ts). The work as a tree comes once desk keeps the steps.
import { observer } from "mobx-react-lite";
import { useMemo } from "react";
import type { IssuePageData } from "../issues/IssueView";
import { GLYPH } from "../ui/icons";
import { artifactsOf, type Artifact } from "./Dock";
import { useLive } from "./live";

// A row's message, in the middle of the chat, and a moment's ring round it so the eye finds it.
function bring(a: Artifact) {
  const at = document.querySelector(`.dock [data-at="${CSS.escape(a.at)}"]`);
  const target = (a.img !== undefined && at?.querySelectorAll("img")[a.img]) || at;
  if (!target) return;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  target.classList.remove("brought");
  void (target as HTMLElement).offsetWidth; // a second click rings it again
  target.classList.add("brought");
}

export const ChatSide = observer(function ChatSide({ data }: { data: IssuePageData }) {
  const s = useLive(data.issue.session, false);
  const items = s?.items, sends = s?.results.size;
  const made = useMemo(() => (s ? artifactsOf(s, data.issue.slug).filter((a) => a.kind === "image" || a.latest) : []), [items, sends, data.issue.slug]); // eslint-disable-line react-hooks/exhaustive-deps
  const plan = data.plan_card;
  return (
    <div className="chat-side">
      <section className="side-part">
        {plan ? (
          <>
            <div className="body side-plan" dangerouslySetInnerHTML={{ __html: plan[0] }} />
            {plan[1] && (
              <details className="review-details">
                <summary>Details</summary>
                <div className="body side-plan" dangerouslySetInnerHTML={{ __html: plan[1] }} />
              </details>
            )}
          </>
        ) : <p className="side-none">No plan yet.</p>}
      </section>
      <section className="side-part">
        <div className="side-head">Artifacts{made.length > 0 && <span className="side-count">{made.length}</span>}</div>
        {made.length ? made.map((a, n) => (
          <button key={`${a.at}:${a.img ?? ""}:${n}`} type="button" className={`side-row${a.latest ? " latest" : ""}`} title="Show it in the chat" onClick={() => bring(a)}>
            {GLYPH.file}
            <span className="side-name">{a.name}</span>
            {a.kind !== "image" && <span className="side-what">latest</span>}
          </button>
        )) : <p className="side-none">Nothing made in the chat yet.</p>}
      </section>
    </div>
  );
});
