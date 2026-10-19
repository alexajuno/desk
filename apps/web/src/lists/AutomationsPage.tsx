// The automations (automations.ts on the server), as Linear's Projects list: each with its description, when it fires
// and with which agent, and when it fires next or last ran. New automation, at the top bar's end, opens a desk chat
// with the request begun, whose agent writes the automation: "a new desk chat for sure" (the user, 19 Oct).
import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { usePage } from "../api/page";
import { Go } from "../app/nav";
import { Bar } from "../frame/Bar";
import { newSession } from "../sessions/Dock";
import { frame } from "../store/frame";
import { ui } from "../store/ui";
import { GLYPH } from "../ui/icons";

export interface AutomationRow {
  slug: string;
  title: string;
  when: string;
  check: string;
  agent: string;
  state: "active" | "paused";
  description: string;
  next_text: string;
  last_text: string;
  note: string;
  trouble: string;
  last_run: { chat: string; session: string; at: string } | null;
}

export const NEW_AUTOMATION = "New automation: ";

// What a row says at its end: what keeps it from running, else when it fires next, else when it last ran.
export function whenNext(a: AutomationRow): string {
  if (a.trouble) return a.trouble;
  if (a.state === "paused") return "Paused";
  if (a.next_text) return `Next ${a.next_text}`;
  return a.when ? "" : "On a call";
}

export const AutomationsPage = observer(function AutomationsPage() {
  const { data } = usePage<AutomationRow[]>("/api/page/automations", frame.data?.automations);
  useEffect(() => { document.title = "Automations · desk"; }, []);
  return (
    <>
      <Bar crumb={<span>Automations</span>} tools={
        <button type="button" className="ghost new-project" title="New automation: a desk chat writes it" onClick={() => newSession(NEW_AUTOMATION)}>{GLYPH.plus}New automation</button>
      } />
      <div className="scroll">
        {data && (
          <div className="page">
            {data.map((a) => (
              <Go key={a.slug} className={`item automation-row${a.state === "paused" ? " paused" : ""}${ui.focused === `automation/${a.slug}` ? " focus" : ""}`}
                to={`/automation/${a.slug}`} data-key={`automation/${a.slug}`} onMouseMove={() => { if (ui.focused !== `automation/${a.slug}`) ui.focus(`automation/${a.slug}`, true); }}>
                <span className="icon">{GLYPH.clock}</span>
                <span className="title">{a.title}</span>
                <span className="snippet">{a.description}</span>
                {a.when && <span className="pill">{a.when}</span>}
                {a.agent && <span className="pill">{a.agent}</span>}
                <span className={`date next${a.trouble ? " trouble" : ""}`} title={a.last_text ? `Last ran ${a.last_text}` : "Not run yet"}>{whenNext(a)}</span>
              </Go>
            ))}
            {!data.length && (
              <p className="muted" style={{ padding: 16 }}>
                No automations yet. An automation runs an agent at a time, or when its check finds something, and its report reaches your Inbox.
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
});
