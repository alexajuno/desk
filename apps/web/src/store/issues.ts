import { makeAutoObservable, observable } from "mobx";
import type { Priority, Protocol, State } from "../lib/desk";

// The rows desk syncs (the server's sync.ts and db.ts): every issue and project, each as its table holds it, less what
// the app is not sent. The app works out what it shows from these, as a list and its count from the same rows, so the
// two cannot disagree.

// An issue: every field of its issue.md but the description.
export interface Issue {
  slug: string;
  title: string;
  priority: Priority;
  state: State;
  parent: string | null;
  project: string | null;
  folder: string | null;
  protocol: Protocol | null; // none runs design
  link: string | null;
  landing: string | null;
  session: string | null;
  waiting_on: string | null;
  waiting_since: string | null;
  review_of: string | null;
  review_since: string | null;
  created: string;
}

export interface Project {
  slug: string;
  title: string;
  state: "active" | "archived";
  created: string;
}

// One change from desk's log: the row as it is now, or null once deleted. kind is its table.
interface Change { seq: number; kind: string; key: string; row: Record<string, unknown> | null }

export type SyncMessage =
  | { type: "snapshot"; log: string; seq: number; rows: { issues: Issue[]; projects: Project[] } }
  | { type: "changes"; after: number; changes: Change[] }
  | { type: "files"; slugs: string[] };

const newestFirst = (a: { created: string }, b: { created: string }) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0);

// Every issue and project, in memory. The screen draws from here, and MobX redraws only what read a field that changed.
export class IssueStore {
  bySlug = observable.map<string, Issue>();
  projects = observable.map<string, Project>();
  files = observable.map<string, number>(); // slug: how many times its other files changed (a plan, a result)
  connected = false;
  log = ""; // the name of desk's log these rows follow
  seq = -1; // the last change of it applied

  constructor() {
    makeAutoObservable(this);
  }

  // Apply what desk sent; false when it does not follow on from the last change applied, so one was missed and the
  // socket must ask again.
  apply(message: SyncMessage): boolean {
    if (message.type === "files") {
      for (const slug of message.slugs) this.files.set(slug, (this.files.get(slug) ?? 0) + 1);
      return true;
    }
    if (message.type === "snapshot") {
      this.bySlug.replace(message.rows.issues.map((i) => [i.slug, i]));
      this.projects.replace(message.rows.projects.map((p) => [p.slug, p]));
      this.log = message.log;
      this.seq = message.seq;
      return true;
    }
    if (message.after !== this.seq) return false;
    const tables: Record<string, Map<string, unknown>> = { issues: this.bySlug, projects: this.projects };
    for (const c of message.changes) {
      const table = tables[c.kind]; // a table this app does not hold yet is a newer desk's
      if (table && c.row) table.set(c.key, c.row);
      else table?.delete(c.key);
      this.seq = c.seq;
    }
    return true;
  }

  setConnected(connected: boolean) {
    this.connected = connected;
  }

  // Triage: the issues whose chat has not settled them yet, the newest first, as chats come in.
  get triage(): Issue[] {
    return [...this.bySlug.values()].filter((i) => i.state === "triage").sort(newestFirst);
  }

  // The active projects, the oldest first, as the sidebar lists them.
  get activeProjects(): Project[] {
    return [...this.projects.values()].filter((p) => p.state === "active").sort((a, b) => newestFirst(b, a));
  }
}

export const issues = new IssueStore();
