// Settings, as Linear's (linear.app/<workspace>/settings, measured 17 Oct): its own sidebar in place of the app's, with
// Back to app and a list of pages, and each page a 640px column of cards, one row per setting. desk keeps what it
// has a setting for: Preferences (the theme, which the Help menu also offers) and Workflows & automations (the two
// auto-close toggles, settings.ts on the server). Linear keeps the second under each team; desk has no teams.
import { observer } from "mobx-react-lite";
import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation, useParams } from "react-router";
import { usePage } from "../api/page";
import { reason } from "../api/http";
import { deskPath, Go } from "../app/nav";
import { Bar } from "../frame/Bar";
import { applyTheme } from "../frame/theme";
import { GLYPH } from "../ui/icons";
import { openMenu, toggled } from "../ui/menu";
import { toast } from "../ui/toast";

interface Settings {
  sub_issue_auto_close: boolean;
  parent_auto_close: boolean;
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
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 6.5L8 10l3.5-3.5" /></svg>
        </button>
      </Row>
    </Section>
  );
}

function Workflow() {
  const { data } = usePage<Settings>("/api/settings");
  const [shown, setShown] = useState<Settings | null>(null);
  useEffect(() => { if (data) setShown(data); }, [data]);
  if (!shown) return null;
  const change = async (name: keyof Settings, on: boolean) => {
    setShown({ ...shown, [name]: on });
    const res = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [name]: on }) });
    if (!res.ok) {
      toast(await reason(res));
      setShown(shown);
    } else setShown(await res.json());
  };
  return (
    <Section title="Auto-close automations" about="Automate closing issues based on status changes to related issues.">
      <Row id="parent_auto_close" title="Auto-close parent issues"
        about="Automatically close an open parent issue when its last sub-issue is closed, as Done if any of them is">
        <Switch id="parent_auto_close" on={shown.parent_auto_close} change={(on) => change("parent_auto_close", on)} />
      </Row>
      <Row id="sub_issue_auto_close" title="Auto-close sub-issues"
        about="Automatically close all sub-issues when their parent issue is closed, as Done or Dropped like the parent">
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
          {section === "preferences" ? <Preferences /> : <Workflow />}
        </div>
      </div>
    </>
  );
}
