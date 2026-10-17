// The composer's chip: the session's model and effort, and a menu to pick others, with the plan's 5-hour and weekly
// usage at its foot, as numbers only (the user, 17 Oct: "i kinda hate the warning stuff. just gimme the number").
// The server asks Claude Code for both lists (models.ts there).
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
  resets: string;
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

// When a window resets: the time today, or the day and time when it is further off.
function resets(iso: string): string {
  const at = new Date(iso), time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return at.getTime() - Date.now() < 20 * 3600_000 ? time : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

export interface Runs {
  model: string;
  name: string;
  effort: string;
}

// The menu under the chip: the models, the efforts the current one takes, and the usage.
export function runsMenu(anchor: Element, runs: Runs, pick: (set: { model?: string; effort?: string }, shown?: Partial<Runs>) => void) {
  openMenu({
    anchor, className: "runs-menu",
    items: async () => {
      const [list, usage] = await Promise.all([loadModels().catch((e) => (toast((e as Error).message), [] as Model[])), loadUsage().catch(() => null)]);
      const now = list.find((m) => m.value === runs.model || m.name === runs.name);
      const items: MenuItem[] = list.map((m) => ({ label: m.name, group: 1, heading: "Model", current: m === now, run: () => pick({ model: m.value }, { name: m.name, ...(m.efforts.length ? {} : { effort: "" }) }) }));
      const efforts = now ? now.efforts : EFFORTS.map(([value]) => value);
      for (const [value, label] of EFFORTS)
        if (efforts.includes(value)) items.push({ label, group: 2, heading: "Effort", current: value === runs.effort, run: () => pick({ effort: value }) });
      const windows: [string, Window | null | undefined][] = [["5-hour", usage?.five_hour], ["Week", usage?.seven_day]];
      for (const [label, w] of windows)
        if (w) items.push({ label: `${label} · ${w.percent}%`, hint: `resets ${resets(w.resets)}`, group: 3, heading: "Usage", info: true });
      return items;
    },
  });
}

// Fetched ahead when the pointer nears the chip, so the menu opens at once.
export const warm = () => void Promise.all([loadModels().catch(() => {}), loadUsage().catch(() => {})]);
