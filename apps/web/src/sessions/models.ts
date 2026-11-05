// The composer's chip: the session's model and effort, and a menu to pick others, with the live profile's numbers and
// the context at its foot, as numbers only (the user, 17 Oct: "i kinda hate the warning stuff. just gimme the number").
// The server answers each from what it last heard from Claude Code, or seat, at once (models.ts and seat.ts there).
import { reason } from "../api/http";
import { meters, seats } from "../frame/seat";
import { openMenu, type MenuItem } from "../ui/menu";
import { toast } from "../ui/toast";

export interface Model {
  value: string;
  name: string;
  efforts: string[];
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

export interface Context {
  tokens: number;
  max: number;
  percent: number;
}

// How full the session's context is, as last counted; null before desk counted it.
async function loadContext(session: string): Promise<Context | null> {
  const res = await fetch(`/api/live/${session}/context`);
  return res.ok ? ((await res.json()) as Context | null) : null;
}

export const tokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

export interface Runs {
  model: string;
  name: string;
  effort: string;
}

// The menu under the chip: the models, the efforts the current one takes, and the usage: the live profile by name, as
// seat says, its own numbers, a plan's 5-hour and Week or api's credits, as the window's bar shows them, and how full
// the session's context is. A phone has no bar, so this is where it reads them.
export function runsMenu(anchor: Element, session: string, runs: Runs, pick: (set: { model?: string; effort?: string }, shown?: Partial<Runs>) => void) {
  openMenu({
    anchor, className: "runs-menu",
    items: async () => {
      const [list, , context] = await Promise.all([loadModels().catch((e) => (toast((e as Error).message), [] as Model[])), seats.load(),
        loadContext(session).catch(() => null)]);
      const now = list.find((m) => m.value === runs.model || m.name === runs.name);
      // Each model has its own prompt cache, so changing model reads the whole talk again uncached, where changing effort
      // costs nothing (https://code.claude.com/docs/en/prompt-caching.md): the number on the other models' rows.
      const rereads = context?.tokens ? `Re-reads ${tokens(context.tokens)}` : undefined;
      const items: MenuItem[] = list.map((m) => ({ label: m.name, hint: m === now ? undefined : rereads, group: 1, heading: "Model", current: m === now, run: () => pick({ model: m.value }, { name: m.name, ...(m.efforts.length ? {} : { effort: "" }) }) }));
      const efforts = now ? now.efforts : EFFORTS.map(([value]) => value);
      for (const [value, label] of EFFORTS)
        if (efforts.includes(value)) items.push({ label, group: 2, heading: "Effort", current: value === runs.effort, run: () => pick({ effort: value }) });
      const seat = seats.seat, live = seat?.profiles.find((p) => p.active);
      if (live) {
        items.push({ label: `Profile · ${live.name}`, hint: seat?.auto ? "Auto switch on" : undefined, group: 3, heading: "Usage", info: true });
        for (const m of meters(live)) items.push({ label: `${m.word} · ${m.text}`, hint: m.about, group: 3, heading: "Usage", info: true });
      }
      if (context) items.push({ label: `Context · ${Math.round(context.percent)}%`, hint: `${tokens(context.tokens)} of ${tokens(context.max)}`, group: 3, heading: "Usage", info: true });
      return items;
    },
  });
}

// Fetched ahead when the pointer nears the chip, so the menu opens at once.
export const warm = () => void Promise.all([loadModels().catch(() => {}), seats.load()]);
