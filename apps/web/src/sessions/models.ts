// The composer's chip: the session's model and effort, and a menu to pick others, with the plan's 5-hour and weekly
// usage at its foot, as numbers only (the user, 17 Oct: "i kinda hate the warning stuff. just gimme the number").
// The server answers each from what it last heard from Claude Code, at once (models.ts there).
import { reason } from "../api/http";
import { openMenu, type MenuItem } from "../ui/menu";
import { toast } from "../ui/toast";

export interface Model {
  value: string;
  name: string;
  efforts: string[];
}

interface Window {
  percent: number;
  resets: string | null; // null once it reset, until desk hears when it next does
}

interface Usage {
  five_hour: Window | null;
  seven_day: Window | null;
}

export const EFFORTS: [string, string][] = [["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Max"]];
export const effortName = (effort: string) => EFFORTS.find(([value]) => value === effort)?.[1] ?? effort;

let models: Promise<Model[]> | null = null; // Claude Code's list changes only with Claude Code: asked once a page

export function loadModels(): Promise<Model[]> {
  models ??= fetch("/api/models").then(async (res) => {
    if (!res.ok) throw new Error(await reason(res));
    return (await res.json()) as Model[];
  }).catch((error) => {
    models = null;
    throw error;
  });
  return models;
}

async function loadUsage(): Promise<Usage | null> {
  const res = await fetch("/api/usage");
  return res.ok ? ((await res.json()) as Usage) : null;
}

interface Context {
  tokens: number;
  max: number;
  percent: number;
}

// How full the session's context is, as last counted; null before desk counted it.
async function loadContext(session: string): Promise<Context | null> {
  const res = await fetch(`/api/live/${session}/context`);
  return res.ok ? ((await res.json()) as Context | null) : null;
}

const tokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

// When a window resets, to the nearest minute (it says 05:59:59.9 for 06:00): the time today, or the day and time when
// it is further off.
function resets(iso: string): string {
  const at = new Date(Math.round(new Date(iso).getTime() / 60_000) * 60_000), time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return at.getTime() - Date.now() < 20 * 3600_000 ? time : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

export interface Runs {
  model: string;
  name: string;
  effort: string;
}

// The menu under the chip: the models, the efforts the current one takes, and the usage, with how full the session's
// context is.
export function runsMenu(anchor: Element, session: string, runs: Runs, pick: (set: { model?: string; effort?: string }, shown?: Partial<Runs>) => void) {
  openMenu({
    anchor, className: "runs-menu",
    items: async () => {
      const [list, usage, context] = await Promise.all([loadModels().catch((e) => (toast((e as Error).message), [] as Model[])), loadUsage().catch(() => null),
        loadContext(session).catch(() => null)]);
      const now = list.find((m) => m.value === runs.model || m.name === runs.name);
      const items: MenuItem[] = list.map((m) => ({ label: m.name, group: 1, heading: "Model", current: m === now, run: () => pick({ model: m.value }, { name: m.name, ...(m.efforts.length ? {} : { effort: "" }) }) }));
      const efforts = now ? now.efforts : EFFORTS.map(([value]) => value);
      for (const [value, label] of EFFORTS)
        if (efforts.includes(value)) items.push({ label, group: 2, heading: "Effort", current: value === runs.effort, run: () => pick({ effort: value }) });
      const windows: [string, Window | null | undefined][] = [["5-hour", usage?.five_hour], ["Week", usage?.seven_day]];
      for (const [label, w] of windows)
        if (w) items.push({ label: `${label} · ${w.percent}%`, hint: w.resets ? `resets ${resets(w.resets)}` : undefined, group: 3, heading: "Usage", info: true });
      if (context) items.push({ label: `Context · ${Math.round(context.percent)}%`, hint: `${tokens(context.tokens)} of ${tokens(context.max)}`, group: 3, heading: "Usage", info: true });
      return items;
    },
  });
}

// Fetched ahead when the pointer nears the chip, so the menu opens at once.
export const warm = () => void Promise.all([loadModels().catch(() => {}), loadUsage().catch(() => {})]);
