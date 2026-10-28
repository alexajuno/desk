// The sheet's Plan, over an issue's chat ("plan and issue stuff should be showned in the central of the screen with
// certain shortcut", the user, 28 Oct): a design issue's steps down the left, which desk keeps (issues/Steps.tsx), and
// the picked one's diagram and decisions beside them, J and K walking the drawn ones; under the steps, the Plan's Done
// when and Decide alone, folded, and what the chat made, each a row that puts the sheet away and brings its message
// into view in the chat, or picks its step. An issue with no steps, a quick or brief one, has its plan in one column,
// and so does a phone, whose steps open their diagram under their row ("go", the user, 28 Oct, on its mockup).
// An earlier send of the plan or the card is left out: desk keeps only the latest, so it is a line in the chat with
// nothing to see.
import { observer } from "mobx-react-lite";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { dock } from "../store/dock";
import type { IssuePageData } from "../issues/IssueView";
import { GLYPH, StateIcon } from "../ui/icons";
import { artifactsOf, toggleIssue, type Artifact } from "./Dock";
import { isDrawn, isHere, placed, Steps, type PlanStep } from "../issues/Steps";
import { anyCommit, useChanges } from "./Changes";
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

// A phone's width, where the sheet fills the screen (phone.css) and has no room for the steps and a diagram side by side.
const phoneQuery = matchMedia("(max-width: 640px)");
const onPhone = (change: () => void) => { phoneQuery.addEventListener("change", change); return () => phoneQuery.removeEventListener("change", change); };
const usePhone = () => useSyncExternalStore(onPhone, () => phoneQuery.matches);

// The steps with how much each one changed, from its chat's Changes (Changes.tsx).
type StepsProps = Parameters<typeof Steps>[0];
const ChangedSteps = observer(function ChangedSteps({ slug, ...props }: { slug: string } & Omit<StepsProps, "changes">) {
  const diffs = useChanges(slug);
  const changes = useMemo(() => ({ slug, diffs: new Map((diffs ?? []).map((d) => [d.place, d])) }), [slug, diffs]);
  return <Steps {...props} changes={changes} />;
});

// The step the sheet opens on: the one being worked on when it is drawn, else the last drawn.
function firstPick(steps: PlanStep[]): string | null {
  const all = placed(steps).filter(({ step }) => isDrawn(step));
  return (all.find(({ step }) => isHere(step)) ?? all[all.length - 1])?.place ?? null;
}

export const SheetPlan = observer(function SheetPlan({ data }: { data: IssuePageData }) {
  const s = useLive(data.issue.session, false);
  const phone = usePhone();
  const items = s?.items, sends = s?.results.size;
  const steps = data.plan_steps ?? [];
  const made = useMemo(() => (s ? artifactsOf(s, data.issue.slug, steps).filter((a) => a.kind === "image" || a.latest) : []), [items, sends, data.issue.slug, data.plan_steps]); // eslint-disable-line react-hooks/exhaustive-deps
  const plan = data.plan_card;
  // Each time the sheet comes, it opens on the step asked for (the chat's head, HeadStep), else on firstPick; a step
  // drawn while none was, the first one, is picked as it comes in.
  const [pick, setPick] = useState<string | null>(() => dock.pick ?? firstPick(steps));
  useEffect(() => { if (dock.sheet) setPick(dock.pick ?? firstPick(steps)); }, [dock.sheet]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (pick === null) setPick(firstPick(steps)); }, [data.plan_steps]); // eslint-disable-line react-hooks/exhaustive-deps
  const picked = pick ? placed(steps).find((p) => p.place === pick) : undefined;
  const tap = (a: Artifact) => {
    const step = a.kind === "step" && (placed(steps).find(({ step }) => step.title === a.name)?.place ?? a.place);
    if (step) return setPick(step);
    if (dock.sheetShown) toggleIssue();
    dock.setView("chat");
    requestAnimationFrame(() => bring(a));
  };
  // With its diagrams on its steps, a plan holds only Done when and Decide alone, folded: the steps are what you read.
  // A plan from before, its diagram in it, shows as it did.
  const folded = steps.length > 0 && plan !== null && !plan.join("").includes('class="d2"');
  const list = (
    <>
      {steps.length > 0 && (
        <section className="side-part">
          <div className="side-head">Steps</div>
          {(() => {
            const props: Omit<StepsProps, "changes"> = phone ? { steps, opened: dock.pick } : { steps, pick: { place: pick, to: setPick } };
            const key = phone ? String(dock.sheet) : "list"; // on a phone, each opening starts its rows afresh
            return anyCommit(steps) ? <ChangedSteps key={key} slug={data.issue.slug} {...props} /> : <Steps key={key} {...props} />;
          })()}
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
          <button key={`${a.at}:${a.img ?? ""}:${n}`} type="button" className={`side-row${a.latest ? " latest" : ""}`}
            title={a.kind === "step" ? "Its diagram and decisions" : "Show it in the chat"} onClick={() => tap(a)}>
            {a.kind === "step" ? GLYPH.diagram : GLYPH.file}
            <span className="side-name">{a.name}</span>
            {a.kind === "step" ? <span className="side-what">step {a.place}</span> : a.kind !== "image" && <span className="side-what">latest</span>}
          </button>
        )) : <p className="side-none">Nothing made in the chat yet.</p>}
      </section>
    </>
  );
  if (!steps.length || phone) return <div className="chat-side">{list}</div>;
  return (
    <div className="chat-side sheet-plan">
      <div className="sheet-list">{list}</div>
      {/* keyed by the step, so a step picked opens at its top, wherever the last one was scrolled to */}
      <div className="sheet-step" key={pick ?? ""}>
        {picked ? (
          <>
            <h3 className="sheet-step-title">
              <StateIcon state={picked.step.state} />
              <span>{picked.step.title}</span>
              <span className="side-what">step {picked.place}</span>
            </h3>
            {picked.step.diagram_html && <div className="body" dangerouslySetInnerHTML={{ __html: picked.step.diagram_html }} />}
            {picked.step.said_html && <div className="body plan-step-said" dangerouslySetInnerHTML={{ __html: picked.step.said_html }} />}
            {!isDrawn(picked.step) && <p className="side-none">Nothing drawn on this step yet.</p>}
          </>
        ) : <p className="side-none">No step is drawn yet.</p>}
      </div>
    </div>
  );
});
