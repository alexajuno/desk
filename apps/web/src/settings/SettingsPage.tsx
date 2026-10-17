// Settings, as Linear's (linear.app/<workspace>/settings, measured 17 Oct): its own sidebar in place of the app's, with
// Back to app and a list of pages, and each page a 640px column of cards, one row per setting. desk keeps what it
// has a setting for: Preferences (the theme, and the model and effort a new chat starts with) and Workflows &
// automations (the two auto-close toggles). Both pages' server settings are settings.ts. Linear keeps the second
// under each team; desk has no teams.
import { observer } from "mobx-react-lite";
import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation, useParams } from "react-router";
import { usePage } from "../api/page";
import { reason } from "../api/http";
import { deskPath, Go } from "../app/nav";
import { Bar } from "../frame/Bar";
import { applyTheme } from "../frame/theme";
import { EFFORTS, effortName, loadModels, type Model } from "../sessions/models";
import { GLYPH } from "../ui/icons";
import { openMenu, toggled } from "../ui/menu";
import { toast } from "../ui/toast";

interface Settings {
  sub_issue_auto_close: boolean;
  parent_auto_close: boolean;
  chat_model: string;
  chat_effort: string;
}

const PAGES: { group: string; pages: { slug: string; title: string; icon: ReactNode }[] }[] = [
  { group: "Personal", pages: [{ slug: "preferences", title: "Preferences", icon: GLYPH.sliders }] },
  { group: "Issues", pages: [{ slug: "workflow", title: "Workflows & automations", icon: GLYPH.parent }] },
];
const TITLES = Object.fromEntries(PAGES.flatMap((g) => g.pages).map((p) => [p.slug, p.title]));

// Back to app returns to the last page outside Settings.
let lastApp = "/backlog";
export function noteAppPath(path: string) {
  if (!path.startsWith("/settings")) lastApp = path;
}

export const SettingsNav = observer(function SettingsNav() {
  const here = deskPath(useLocation().pathname);
  return (
    <aside className="side settings-side">
      <Go className="nav-item settings-back" to={lastApp}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 3.5L5.5 8l4.5 4.5" /></svg>
        Back to app
      </Go>
      {PAGES.map((g) => (
        <div key={g.group}>
          <div className="nav-label">{g.group}</div>
          {g.pages.map((p) => (
            <Go key={p.slug} className={`nav-item${here === `/settings/${p.slug}` ? " here" : ""}`} to={`/settings/${p.slug}`}>
              {p.icon}<span className="nav-title">{p.title}</span>
            </Go>
          ))}
        </div>
      ))}
    </aside>
  );
});

// A card of settings rows under a section's heading, as Linear's.
function Section({ title, about, children }: { title: string; about?: string; children: ReactNode }) {
  return (
    <section className="set-section">
      <h3>{title}</h3>
      {about && <p className="set-about">{about}</p>}
      <ul className="set-card">{children}</ul>
    </section>
  );
}

function Row({ id, title, about, children }: { id: string; title: string; about: string; children: ReactNode }) {
  return (
    <li className="set-row">
      <div className="set-text"><label htmlFor={id}>{title}</label><span>{about}</span></div>
      {children}
    </li>
  );
}

// Linear's switch: a 30x20 checkbox drawn as a pill, its knob a 14px circle.
function Switch({ id, on, change }: { id: string; on: boolean; change: (on: boolean) => void }) {
  return <input id={id} className="switch" type="checkbox" role="switch" checked={on} onChange={(e) => change(e.target.checked)} />;
}

const THEMES: [string, string][] = [["system", "System preference"], ["light", "Light"], ["dark", "Dark"]];

const CHEVRON_DOWN = <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 6.5L8 10l3.5-3.5" /></svg>;

// The settings, as the server has them, and a change that shows at once and goes back if the server refuses it.
function useSettings(): [Settings | null, (changes: Partial<Settings>) => Promise<void>] {
  const { data } = usePage<Settings>("/api/settings");
  const [shown, setShown] = useState<Settings | null>(null);
  useEffect(() => { if (data) setShown(data); }, [data]);
  const change = async (changes: Partial<Settings>) => {
    if (!shown) return;
    setShown({ ...shown, ...changes });
    const res = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) });
    if (!res.ok) {
      toast(await reason(res));
      setShown(shown);
    } else setShown(await res.json());
  };
  return [shown, change];
}

// What a new chat starts on; the chip by a chat's Send changes it for that chat alone.
function Chats() {
  const [shown, change] = useSettings();
  const [list, setList] = useState<Model[]>([]);
  useEffect(() => { loadModels().then(setList, (e) => toast((e as Error).message)); }, []);
  if (!shown) return null;
  const model = list.find((m) => m.value === shown.chat_model);
  const efforts = model ? EFFORTS.filter(([value]) => model.efforts.includes(value)) : EFFORTS;
  return (
    <Section title="Chats">
      <Row id="chat_model" title="Model" about="The model a new chat starts with">
        <button id="chat_model" type="button" className="set-pick" onClick={(e) => {
          if (toggled(e.currentTarget)) return;
          openMenu({ anchor: e.currentTarget, items: () => list.map((m) => ({ label: m.name, current: m.value === shown.chat_model, run: () => change({ chat_model: m.value }) })) });
        }}>
          {model?.name ?? shown.chat_model}
          {CHEVRON_DOWN}
        </button>
      </Row>
      <Row id="chat_effort" title="Effort" about="How hard a new chat thinks before it answers">
        <button id="chat_effort" type="button" className="set-pick" onClick={(e) => {
          if (toggled(e.currentTarget)) return;
          openMenu({ anchor: e.currentTarget, items: () => efforts.map(([value, label]) => ({ label, current: value === shown.chat_effort, run: () => change({ chat_effort: value }) })) });
        }}>
          {effortName(shown.chat_effort)}
          {CHEVRON_DOWN}
        </button>
      </Row>
    </Section>
  );
}

function Preferences() {
  const [theme, setTheme] = useState(() => (["light", "dark"].includes(localStorage.theme) ? localStorage.theme : "system"));
  const pick = (to: string) => {
    if (to === "system") delete localStorage.theme;
    else localStorage.theme = to;
    applyTheme();
    setTheme(to);
  };
  return (
    <Section title="Interface and theme">
      <Row id="theme" title="Interface theme" about="Follow the system, or keep desk light or dark">
        <button id="theme" type="button" className="set-pick" onClick={(e) => {
          if (toggled(e.currentTarget)) return;
          openMenu({ anchor: e.currentTarget, items: () => THEMES.map(([value, label]) => ({
            icon: GLYPH[value as keyof typeof GLYPH], label, current: value === theme, run: () => pick(value) })) });
        }}>
          {THEMES.find(([value]) => value === theme)?.[1]}
          {CHEVRON_DOWN}
        </button>
      </Row>
    </Section>
  );
}

function Workflow() {
  const [shown, set] = useSettings();
  if (!shown) return null;
  const change = (name: "parent_auto_close" | "sub_issue_auto_close", on: boolean) => set({ [name]: on });
  return (
    <Section title="Auto-close automations" about="Automate closing issues based on status changes to related issues.">
      <Row id="parent_auto_close" title="Auto-close parent issues"
        about="Automatically close an open parent issue when its last sub-issue is closed">
        <Switch id="parent_auto_close" on={shown.parent_auto_close} change={(on) => change("parent_auto_close", on)} />
      </Row>
      <Row id="sub_issue_auto_close" title="Auto-close sub-issues"
        about="Automatically close all sub-issues when their parent issue is closed">
        <Switch id="sub_issue_auto_close" on={shown.sub_issue_auto_close} change={(on) => change("sub_issue_auto_close", on)} />
      </Row>
    </Section>
  );
}

export function SettingsPage() {
  const { section = "" } = useParams();
  useEffect(() => { document.title = `${TITLES[section] ?? "Settings"} · desk`; }, [section]);
  if (!TITLES[section]) return <Navigate to="/settings/preferences" replace />;
  return (
    <>
      <Bar crumb={<span>Settings</span>} />
      <div className="scroll">
        <div className="settings">
          <h1>{TITLES[section]}</h1>
          {section === "workflow" && <p className="set-lead">Manage issue automations and other workflows.</p>}
          {section === "preferences" ? <><Preferences /><Chats /></> : <Workflow />}
        </div>
      </div>
    </>
  );
}
