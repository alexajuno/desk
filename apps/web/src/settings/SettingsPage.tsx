// Settings, as Linear's (linear.app/<workspace>/settings, measured 17 Oct): its own sidebar in place of the app's, with
// Back to app and a list of pages, and each page a 640px column of cards, one row per setting. desk keeps what it
// has a setting for: Preferences (the theme, how an issue's steps card starts, whether the stash comes back on the next
// message, the model and effort a new chat starts with, and how many test desks sessions may run at once) and Workflows & automations (the two auto-close toggles). The server's settings are settings.ts. Linear keeps the auto-close toggles under each team; desk's
// teams have no settings of their own, so they are desk's.
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, useLocation, useParams } from "react-router";
import { usePage } from "../api/page";
import { reason } from "../api/http";
import { deskPath, Go } from "../app/nav";
import { Bar } from "../frame/Bar";
import { applyTheme } from "../frame/theme";
import { useEditorKeys } from "../issues/IssueView";
import { EFFORTS, effortName, loadModels, type Model } from "../sessions/models";
import { ui } from "../store/ui";
import { GLYPH } from "../ui/icons";
import { openMenu, toggled } from "../ui/menu";
import { toast } from "../ui/toast";

interface Settings {
  sub_issue_auto_close: boolean;
  parent_auto_close: boolean;
  chat_model: string;
  chat_effort: string;
  chat_pick: boolean;
  stash_back_on_send: boolean;
  test_slots: number;
  compact_over: number;
  command_details: boolean;
}

const PAGES: { group: string; pages: { slug: string; title: string; icon: ReactNode }[] }[] = [
  { group: "Personal", pages: [{ slug: "preferences", title: "Preferences", icon: GLYPH.sliders }] },
  { group: "Issues", pages: [{ slug: "workflow", title: "Workflows & automations", icon: GLYPH.parent }] },
];
export const TITLES: Record<string, string> = Object.fromEntries(PAGES.flatMap((g) => g.pages).map((p) => [p.slug, p.title]));

// Every setting, by its page and its card's heading, as its row names it: each Row draws its own from here, and search
// finds them by it (search/settings.ts).
export const SETTINGS = [
  { page: "preferences", section: "Interface and theme", id: "theme", title: "Interface theme", about: "Follow the system, or keep desk light or dark" },
  { page: "preferences", section: "Composer", id: "stash_back_on_send", title: "Bring the stash back on send",
    about: "What Ctrl S put away comes back into the box as soon as you send the next message, as in Claude Code. Off, it waits for Ctrl S" },
  { page: "preferences", section: "Sessions", id: "chat_pick", title: "Haiku picks the model",
    about: "Haiku reads a new chat's first message and picks its model and effort, unless you moved its chip first. Model and Effort below are what it falls back on" },
  { page: "preferences", section: "Sessions", id: "chat_model", title: "Model", about: "The model a new chat or issue session starts with" },
  { page: "preferences", section: "Sessions", id: "chat_effort", title: "Effort", about: "How hard a new chat or issue session thinks before it answers" },
  { page: "preferences", section: "Sessions", id: "test_slots", title: "Test desks at once",
    about: "How many sessions may test a branch at once, each on its own copy of your data, while more than 4 GB of memory is free" },
  { page: "preferences", section: "Sessions", id: "compact_over", title: "Compact a chat over",
    about: "A chat this long compacts as a turn ends on a step done, or when it marks a break itself" },
  { page: "preferences", section: "Sessions", id: "command_details", title: "Show command details",
    about: "A chat opens the steps its agent took, with each command and what it printed. Off, they fold to one line, such as “Ran 2 commands”, until you click it" },
  { page: "workflow", section: "Auto-close automations", id: "parent_auto_close", title: "Auto-close parent issues",
    about: "Automatically close an open parent issue when its last sub-issue is closed" },
  { page: "workflow", section: "Auto-close automations", id: "sub_issue_auto_close", title: "Auto-close sub-issues",
    about: "Automatically close all sub-issues when their parent issue is closed" },
];
const SETTING = new Map(SETTINGS.map((s) => [s.id, s]));

// Back to app returns to the last page outside Settings.
let lastApp = "/issues";
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

// A card of settings rows under a section's heading, as Linear's; the first card of a page may have none.
export function Section({ title, about, children }: { title?: string; about?: string; children: ReactNode }) {
  return (
    <section className="set-section">
      {title && <h3>{title}</h3>}
      {about && <p className="set-about">{about}</p>}
      <ul className="set-card">{children}</ul>
    </section>
  );
}

// A setting's row, named as SETTINGS names it, or as it says itself: a team's settings are not in SETTINGS. A setting
// opened from search comes in at #<its id>, and its row comes into view with a moment's ring, as a chat's message does
// (.brought); the row knows, since a page's rows may come only once its settings are in.
export function Row({ id, title = SETTING.get(id)?.title ?? id, about = SETTING.get(id)?.about, children }: {
  id: string; title?: string; about?: string; children: ReactNode;
}) {
  const { hash } = useLocation(), row = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const at = row.current;
    if (!at || decodeURIComponent(hash.slice(1)) !== id) return;
    at.scrollIntoView({ block: "center" });
    at.classList.remove("brought");
    void at.offsetWidth; // the same setting opened again rings again
    at.classList.add("brought");
  }, [hash, id]);
  return (
    <li ref={row} className="set-row">
      <div className="set-text"><label htmlFor={id}>{title}</label>{about && <span>{about}</span>}</div>
      {children}
    </li>
  );
}

// Linear's switch: a 30x20 checkbox drawn as a pill, its knob a 14px circle.
export function Switch({ id, on, change }: { id: string; on: boolean; change: (on: boolean) => void }) {
  return <input id={id} className="switch" type="checkbox" role="switch" checked={on} onChange={(e) => change(e.target.checked)} />;
}

// Linear's text field in a row, which saves what was typed when it loses focus or on Enter, and puts back what it held on
// Escape, or when the save says false. clean shapes the text as it is typed, such as an identifier's lowercase.
export function TextField({ id, value, save, clean = (typed) => typed }: {
  id: string; value: string; save: (value: string) => Promise<boolean>; clean?: (typed: string) => string;
}) {
  const [shown, setShown] = useState(value);
  const box = useRef<HTMLInputElement>(null);
  const done = useRef(true);
  useEffect(() => { if (done.current) setShown(value); }, [value]);
  function finish(keep: boolean) {
    if (done.current) return;
    done.current = true;
    ui.setEditing(false);
    const next = shown.trim();
    if (keep && next && next !== value) void save(next).then((ok) => { if (!ok) setShown(value); });
    else setShown(value);
    box.current?.blur();
  }
  const keys = useEditorKeys((_e, k) => k === "Enter", finish);
  return (
    <input ref={box} id={id} className="set-input" value={shown} spellCheck={false} autoComplete="off" {...keys}
      onChange={(e) => setShown(clean(e.target.value))} onFocus={() => { done.current = false; ui.setEditing(true); }} onBlur={() => finish(true)} />
  );
}

const THEMES: [string, string][] = [["system", "System preference"], ["light", "Light"], ["dark", "Dark"]];
const SLOTS = [1, 2, 3, 4]; // settings.ts, MAX_SLOTS
const COMPACTS = [100_000, 150_000, 200_000, 300_000, 400_000, 500_000];
const thousands = (tokens: number) => `${Math.round(tokens / 1000)}k`;

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

// What a new chat or issue session starts on; the chip by a chat's Send changes it for that chat alone.
function Sessions() {
  const [shown, change] = useSettings();
  const [list, setList] = useState<Model[]>([]);
  useEffect(() => { loadModels().then(setList, (e) => toast((e as Error).message)); }, []);
  if (!shown) return null;
  const model = list.find((m) => m.value === shown.chat_model);
  const efforts = model ? EFFORTS.filter(([value]) => model.efforts.includes(value)) : EFFORTS;
  return (
    <Section title="Sessions">
      <Row id="chat_pick">
        <Switch id="chat_pick" on={shown.chat_pick} change={(on) => change({ chat_pick: on })} />
      </Row>
      <Row id="chat_model">
        <button id="chat_model" type="button" className="set-pick" onClick={(e) => {
          if (toggled(e.currentTarget)) return;
          openMenu({ anchor: e.currentTarget, items: () => list.map((m) => ({ label: m.name, current: m.value === shown.chat_model, run: () => change({ chat_model: m.value }) })) });
        }}>
          {model?.name ?? shown.chat_model}
          {CHEVRON_DOWN}
        </button>
      </Row>
      <Row id="chat_effort">
        <button id="chat_effort" type="button" className="set-pick" onClick={(e) => {
          if (toggled(e.currentTarget)) return;
          openMenu({ anchor: e.currentTarget, items: () => efforts.map(([value, label]) => ({ label, current: value === shown.chat_effort, run: () => change({ chat_effort: value }) })) });
        }}>
          {effortName(shown.chat_effort)}
          {CHEVRON_DOWN}
        </button>
      </Row>
      <Row id="test_slots">
        <button id="test_slots" type="button" className="set-pick" onClick={(e) => {
          if (toggled(e.currentTarget)) return;
          openMenu({ anchor: e.currentTarget, items: () => SLOTS.map((n) => ({ label: String(n), current: n === shown.test_slots, run: () => change({ test_slots: n }) })) });
        }}>
          {shown.test_slots}
          {CHEVRON_DOWN}
        </button>
      </Row>
      <Row id="compact_over">
        <button id="compact_over" type="button" className="set-pick" onClick={(e) => {
          if (toggled(e.currentTarget)) return;
          openMenu({ anchor: e.currentTarget, items: () => COMPACTS.map((n) => ({ label: thousands(n), current: n === shown.compact_over, run: () => change({ compact_over: n }) })) });
        }}>
          {thousands(shown.compact_over)}
          {CHEVRON_DOWN}
        </button>
      </Row>
      <Row id="command_details">
        <Switch id="command_details" on={shown.command_details} change={(on) => change({ command_details: on })} />
      </Row>
    </Section>
  );
}

function Preferences() {
  const [shown, change] = useSettings();
  const [theme, setTheme] = useState(() => (["light", "dark"].includes(localStorage.theme) ? localStorage.theme : "system"));
  const pick = (to: string) => {
    if (to === "system") delete localStorage.theme;
    else localStorage.theme = to;
    applyTheme();
    setTheme(to);
  };
  return (
    <Section title="Interface and theme">
      <Row id="theme">
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

// The composer's stash (sessions/Dock.tsx, Composer): whether it comes back as the next message is entered.
function ComposerPrefs() {
  const [shown, change] = useSettings();
  if (!shown) return null;
  return (
    <Section title="Composer">
      <Row id="stash_back_on_send">
        <Switch id="stash_back_on_send" on={shown.stash_back_on_send} change={(on) => change({ stash_back_on_send: on })} />
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
      <Row id="parent_auto_close">
        <Switch id="parent_auto_close" on={shown.parent_auto_close} change={(on) => change("parent_auto_close", on)} />
      </Row>
      <Row id="sub_issue_auto_close">
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
          {section === "preferences" ? <><Preferences /><ComposerPrefs /><Sessions /></> : <Workflow />}
        </div>
      </div>
    </>
  );
}
