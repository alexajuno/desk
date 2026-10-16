import { makeAutoObservable, observable } from "mobx";

// The fields /api/sync sends for each issue: what GET /api/issues lists (desk/api.py, as_json).
export type State = "triage" | "backlog" | "running" | "waiting" | "review" | "landing" | "done" | "dropped";
export type Priority = "urgent" | "high" | "medium" | "low" | "none";

export interface Issue {
  slug: string;
  title: string;
  state: State;
  priority: Priority;
  parent: string | null;
  project: string | null;
  folder: string | null;
  protocol: "quick" | "brief" | "design";
  session: string | null;
  created: string;
  url: string;
  waiting_on?: string | null;
  waiting_since?: string | null;
}

// desk's order and names (desk/issues.py, STATES and STATE_NAMES).
export const STATES: State[] = ["triage", "backlog", "running", "waiting", "review", "landing", "done", "dropped"];
export const STATE_NAMES: Record<State, string> = {
  triage: "Triage", backlog: "Backlog", running: "In progress", waiting: "Waiting",
  review: "In review", landing: "Landing", done: "Done", dropped: "Dropped",
};
const PRIORITY_ORDER: Priority[] = ["urgent", "high", "medium", "low", "none"];

export interface Project {
  slug: string;
  title: string;
  state: "active" | "archived";
}

export type SyncMessage =
  | { type: "snapshot"; seq: number; issues: Issue[]; projects: Project[] }
  | { type: "changes"; seq: number; upsert: Issue[]; delete: string[]; projects?: Project[] };

// Every issue, in memory. The screen draws from here, and MobX redraws only what read a field that changed.
export class IssueStore {
  bySlug = observable.map<string, Issue>();
  projects: Project[] = [];
  connected = false;
  seq = -1;

  constructor() {
    makeAutoObservable(this);
  }

  apply(message: SyncMessage) {
    if (message.type === "snapshot") {
      this.bySlug.replace(message.issues.map((i) => [i.slug, i]));
    } else {
      for (const issue of message.upsert) this.bySlug.set(issue.slug, issue);
      for (const slug of message.delete) this.bySlug.delete(slug);
    }
    if (message.projects) this.projects = message.projects;
    this.seq = message.seq;
  }

  setConnected(connected: boolean) {
    this.connected = connected;
  }

  // Each state with its issues, most urgent first, then newest: desk's default list.
  get byState(): [State, Issue[]][] {
    const groups = new Map<State, Issue[]>(STATES.map((s) => [s, []]));
    for (const issue of this.bySlug.values()) groups.get(issue.state)?.push(issue);
    for (const list of groups.values()) {
      list.sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) || b.created.localeCompare(a.created));
    }
    return [...groups].filter(([, list]) => list.length > 0);
  }
}

export const issues = new IssueStore();
