// The side of an issue's chat ("i feel like the plan should be on the sidebar i suppse? with all the artifacts
// generated?", the user, 27 Oct), under its top bar's "Plan": the plan as it stands, then what the chat made, its plan,
// its card, its steps' diagrams and its images, each a row that brings its message into view, or opens it where the
// side lies over the chat (openHere). An earlier send of the plan or the card is left out: desk keeps only the latest,
// so it is a line in the chat with nothing to see. It stays put beside the chat, and ] hides it (store/dock.ts). A
// design issue's steps, which desk keeps, come first (issues/Steps.tsx).
import { observer } from "mobx-react-lite";
import { Fragment, useMemo, useState } from "react";
import type { IssuePageData } from "../issues/IssueView";
import { dock } from "../store/dock";
import { GLYPH } from "../ui/icons";
import { openPicture } from "../ui/viewer";
import { artifactsOf, type Artifact } from "./Dock";
import { Steps } from "../issues/Steps";
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

// Where the side lies over its chat, on a phone or a narrow window, the message a row brings into view is under it
// (27 Oct: "how can i see the plan and artifacts in phone"), so the row opens what it names where you are: a picture
// in the viewer, the plan where the side draws it, a step's diagram opened under its row in the steps. False when there is nothing to open, and the card unfolds under its
// row instead (ChatSide).
function openHere(a: Artifact): boolean {
  if (a.kind === "image") {
    const img = document.querySelectorAll(`.dock [data-at="${CSS.escape(a.at)}"] img`)[a.img ?? 0];
    return Boolean(img) && openPicture(img);
  }
  if (a.kind === "step") { // its row in the steps above, opened
    const row = [...document.querySelectorAll<HTMLElement>(".chat-side button.plan-step")].find((b) => b.querySelector(".plan-step-title")?.textContent === a.name);
    if (!row) return false;
    if (!row.classList.contains("open")) row.click();
    row.scrollIntoView({ block: "start", behavior: "smooth" });
    return true;
  }
  const plan = a.kind === "plan" && document.querySelector(".chat-side .side-plan")?.closest(".side-part");
  if (!plan) return false;
  plan.scrollIntoView({ block: "start", behavior: "smooth" });
  return true;
}

export const ChatSide = observer(function ChatSide({ data }: { data: IssuePageData }) {
  const s = useLive(data.issue.session, false);
  const items = s?.items, sends = s?.results.size;
  const made = useMemo(() => (s ? artifactsOf(s, data.issue.slug, data.plan_steps ?? []).filter((a) => a.kind === "image" || a.latest) : []), [items, sends, data.issue.slug, data.plan_steps]); // eslint-disable-line react-hooks/exhaustive-deps
  const plan = data.plan_card;
  const card = data.card ?? (data.result ? [data.result_html, ""] : null); // as its chat draws it (Dock.tsx, Sent)
  const [cardOpen, setCardOpen] = useState(false);
  const tap = (a: Artifact) => {
    if (!dock.narrow) bring(a);
    else if (a.kind === "card" && card) setCardOpen(!cardOpen);
    else if (!openHere(a)) bring(a);
  };
  // With its diagrams on its steps, a plan holds only Done when and Decide alone, folded: the steps above are what you
  // read. A plan from before, its diagram in it, shows as it did.
  const folded = Boolean(data.plan_steps?.length) && plan !== null && !plan.join("").includes('class="d2"');
  return (
    <div className="chat-side">
      {data.plan_steps && data.plan_steps.length > 0 && (
        <section className="side-part">
          <div className="side-head">Steps</div>
          <Steps steps={data.plan_steps} />
        </section>
      )}
      <section className="side-part">
        {plan && folded ? (
          <details className="review-details side-plan-fold">
            <summary>Done when, Decide alone</summary>
            <div className="body side-plan" dangerouslySetInnerHTML={{ __html: plan.join("") }} />
          </details>
        ) : plan ? (
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
          <Fragment key={`${a.at}:${a.img ?? ""}:${n}`}>
            <button type="button" className={`side-row${a.latest ? " latest" : ""}`} title={dock.narrow ? "Open it" : "Show it in the chat"} onClick={() => tap(a)}
              {...(dock.narrow && a.kind === "card" ? { "aria-expanded": cardOpen } : {})}>
              {a.kind === "step" ? GLYPH.diagram : GLYPH.file}
              <span className="side-name">{a.name}</span>
              {a.kind === "step" ? <span className="side-what">step {a.place}</span> : a.kind !== "image" && <span className="side-what">latest</span>}
            </button>
            {a.kind === "card" && card && cardOpen && dock.narrow && (
              <div className="side-card">
                <div className="body side-plan" dangerouslySetInnerHTML={{ __html: card[0] }} />
                {card[1] && (
                  <details className="review-details">
                    <summary>Details</summary>
                    <div className="body side-plan" dangerouslySetInnerHTML={{ __html: card[1] }} />
                  </details>
                )}
              </div>
            )}
          </Fragment>
        )) : <p className="side-none">Nothing made in the chat yet.</p>}
      </section>
    </div>
  );
});
