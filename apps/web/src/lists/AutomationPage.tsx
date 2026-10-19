// One automation's page, as a project's Overview: its name and what it does, both edited where they are, and its
// Properties as chips: when it fires, the check that runs first, and the agent its run is with. Run now and Pause are
// in the top bar; under the description, its last run, which opens its chat.
import { observer } from "mobx-react-lite";
import { useEffect, useState, type ReactNode } from "react";
import { useParams } from "react-router";
import { postJson, reason } from "../api/http";
import { usePage } from "../api/page";
import { Go } from "../app/nav";
import { Description } from "../editor/Description";
import { Bar } from "../frame/Bar";
import { Title } from "../issues/IssueView";
import { frame } from "../store/frame";
import { reloadPages } from "../store/ui";
import { GLYPH } from "../ui/icons";
import { openMenu, toggled } from "../ui/menu";
import { toast } from "../ui/toast";
import { whenNext, type AutomationRow } from "./AutomationsPage";

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

interface AutomationData {
  automation: AutomationRow & { body: string; body_html: string; fired_text: string };
  agents: { name: string; description: string }[];
}

async function setAutomation(slug: string, fields: Record<string, string>) {
  const res = await fetch(`/api/automations/${slug}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) });
  if (!res.ok) toast(await reason(res));
  await reloadPages();
}

// When and Check are typed, in any language; Enter saves, and an empty one clears it.
function typedMenu(slug: string, field: "when" | "check", current: string, anchor: Element) {
  openMenu({
    anchor, filter: "input", className: "folders", query: current,
    placeholder: field === "when" ? "every day 08:00" : "~/projects/muse/bin/…",
    empty: field === "when" ? "Enter saves it, such as every 15 min, every weekday 08:00 or every sunday 20:00. Empty: it runs on calls only"
      : "Enter saves it: a command whose output goes into the run, and an empty output skips the run. Empty: no check",
    items: () => [],
    onEnter: (typed) => void setAutomation(slug, { [field]: typed.trim() }),
  });
}

function agentMenu(slug: string, current: string, agents: AutomationData["agents"], anchor: Element) {
  const all = [{ name: "", description: "A plain Claude chat, from the home folder" }, ...agents];
  openMenu({
    anchor, filter: "keys", placeholder: "Change agent…",
    items: (q) => all.filter((a) => (a.name || "none").includes(q.toLowerCase())).map((a) => ({
      icon: GLYPH.chat, label: a.name || "None", sub: a.description, current: a.name === current,
      run: () => a.name !== current && setAutomation(slug, { agent: a.name }),
    })),
  });
}

export const AutomationPage = observer(function AutomationPage() {
  const { slug = "" } = useParams();
  const { data, error } = usePage<AutomationData>(`/api/page/automation/${slug}`, frame.data?.automations);
  const [running, setRunning] = useState(false);
  const a = data?.automation;
  useEffect(() => { if (a) document.title = `${a.title} · Automations · desk`; }, [a?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runNow() {
    setRunning(true);
    try {
      const res = await postJson(`/api/automations/${slug}/run`);
      toast(res.ok ? (await res.json()).said : await reason(res));
    } finally {
      setRunning(false);
      await reloadPages();
    }
  }

  const chip = (icon: ReactNode, label: string, title: string, open: (anchor: Element) => void) => (
    <button className="prop-chip" type="button" title={title} onClick={(e) => { if (!toggled(e.currentTarget)) open(e.currentTarget); }}>{icon}<span>{label}</span></button>
  );

  return (
    <>
      <Bar crumb={<><Go to="/automations">Automations</Go>{a && <><span className="sep">›</span><span>{a.title}</span></>}</>} tools={a && (
        <>
          <button type="button" className="ghost" title={a.state === "active" ? "Stop it firing on its clock" : "Let it fire on its clock again"}
            onClick={() => setAutomation(slug, { state: a.state === "active" ? "paused" : "active" })}>{a.state === "active" ? "Pause" : "Resume"}</button>
          <button type="button" disabled={running} title="Fire it now: its check, then a run with its agent" onClick={runNow}>{running ? "Running…" : "Run now"}</button>
        </>
      )} />
      <div className="scroll">
        {error && !data && <p className="muted" style={{ padding: 24 }}>{error}</p>}
        {a && data && (
          <div className="project-overview automation-overview">
            <div className="project-icon">{GLYPH.clock}</div>
            <Title title={a.title} save={(t) => setAutomation(slug, { title: t })} />
            <div className="project-props">
              <h3>Properties</h3>
              {chip(GLYPH.clock, a.when || "On calls only", "When it fires", (el) => typedMenu(slug, "when", a.when, el))}
              {chip(GLYPH.terminal, a.check || "No check", "A command run first: what it prints goes into the run, and an empty output skips it", (el) => typedMenu(slug, "check", a.check, el))}
              {chip(GLYPH.chat, a.agent || "No agent", "The agent its run is with", (el) => agentMenu(slug, a.agent, data.agents, el))}
            </div>
            {(a.trouble || a.state === "paused") && <p className={`automation-says${a.trouble ? " trouble" : ""}`}>{whenNext(a)}</p>}
            <h3>Description</h3>
            <Description body={a.body} html={a.body_html} save={(t) => setAutomation(slug, { body: t })} />
            <h3>Last run</h3>
            <p className="automation-last">{a.last_run ? <>Started {a.last_text}. <Go to={`/sessions/${a.last_run.session}`}>Open its chat</Go></> : "Not run yet."}</p>
            {a.note && <p className="automation-last muted">{sentence(`${a.fired_text}: ${a.note.charAt(0).toLowerCase()}${a.note.slice(1)}`)}</p>}
            {a.next_text && <p className="automation-last muted">{sentence(`next ${a.next_text}.`)}</p>}
          </div>
        )}
      </div>
    </>
  );
});
