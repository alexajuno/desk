import { makeAutoObservable, observable } from "mobx";
import type { Priority, Protocol, State } from "../lib/desk";

// The rows desk syncs (the server's sync.ts and db.ts): every issue, team, project, chat and Inbox row, each as its table
// holds it, less what the app is not sent. The app works out what it shows from these, as a list and its count from the same rows, so the
// two cannot disagree.

// An issue: every field of its issue.md but the description.
export interface Issue {
  slug: string;
  title: string;
  priority: Priority;
  state: State;
  parent: string | null;
  team: string | null;
  project: string | null;
  milestone: string | null;
  folder: string | null;
  protocol: Protocol | null; // none runs design
  link: string | null;
  landing: string | null;
  landed: string | null; // in done, where its session said the work landed
  session: string | null;
  waiting_on: string | null;
  waiting_since: string | null;
  review_of: string | null;
  review_since: string | null;
  created: string;
}

// A project, Linear's, which finishes (the server's projects.ts): its dates are periods (lib/periods.ts).
export interface Project {
  slug: string;
  title: string;
  team: string | null;
  status: string; // backlog, planned, started, completed, canceled
  start: string | null;
  target: string | null;
  created: string;
}

// A project's milestone (the server's projects.ts), in its project's order of sort.
export interface Milestone {
  id: string;
  project: string;
  title: string;
  body: string;
  target: string | null;
  sort: number;
  created: string;
}

export interface Team {
  slug: string;
  title: string;
  state: "active" | "archived";
  created: string;
}

// A chat (the server's chats.ts): a session desk keeps, desk's own, an agent's or a bare one, with the issue it works.
export interface Chat {
  id: string;
  kind: string | null; // "panel", or "window" for one from before the panel
  title: string;
  created: string;
  updated: string | null;
  session: string;
  issue: string | null;
  agent: string | null; // the agent it is with
  bare: boolean; // no agent and no desk prompt
  named: string | null; // the title the user gave it
  from: string | null; // the script whose message started it
  automation: string | null; // the automation whose run it is
}

// A row of the Inbox (the server's inbox.ts): what a session last did for you, or an issue in Triage with no chat to
// settle, and whether you read it. The sidebar's count, the Inbox's list and each dot all read these.
export interface InboxRow {
  id: string; // the session's id, or the slug of an issue in Triage with no session
  slug: string; // what the row opens: the issue's slug, or the id of a chat with no issue
  issue: boolean; // whether slug names an issue
  session: string | null;
  title: string; // as it was when written: an issue's row shows its issue's own
  agent: string | null; // the agent of a chat with no issue
  why: string;
  says: string; // the second line, after who
  kind: "needs" | "review"; // review: Go or Approve decides it
  waits: boolean; // listed, read or not, until answered
  at: number; // when it happened, in seconds
  read: number | null; // when you read it, in seconds; null while unread
  gone?: number | null; // when you deleted it: out of the Inbox until something newer comes
  marked?: number | null; // when you marked it unread
}

// One change from desk's log: the row as it is now, or null once deleted. kind is its table.
interface Change { seq: number; kind: string; key: string; row: Record<string, unknown> | null }

export type SyncMessage =
  | { type: "snapshot"; log: string; seq: number; rows: { issues: Issue[]; teams?: Team[]; projects?: Project[]; milestones?: Milestone[]; chats?: Chat[]; inbox?: InboxRow[] } }
  | { type: "changes"; after: number; changes: Change[] }
  | { type: "files"; slugs: string[] };

const newestFirst = (a: { created: string }, b: { created: string }) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0);

// Every issue, team, project, chat and Inbox row, in memory. The screen draws from here, and MobX redraws only what read a field that changed.
export class IssueStore {
  bySlug = observable.map<string, Issue>();
  teams = observable.map<string, Team>();
  projects = observable.map<string, Project>();
  milestones = observable.map<string, Milestone>();
  chats = observable.map<string, Chat>(); // by id
  inbox = observable.map<string, InboxRow>(); // by id
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
      this.teams.replace((message.rows.teams ?? []).map((t) => [t.slug, t])); // none from a desk before teams
      this.projects.replace((message.rows.projects ?? []).map((p) => [p.slug, p]));
      this.milestones.replace((message.rows.milestones ?? []).map((m) => [m.id, m]));
      this.chats.replace((message.rows.chats ?? []).map((c) => [c.id, c])); // none from a desk before the table
      this.inbox.replace((message.rows.inbox ?? []).map((r) => [r.id, r]));
      this.log = message.log;
      this.seq = message.seq;
      return true;
    }
    if (message.after !== this.seq) return false;
    const tables: Record<string, Map<string, unknown>> = { issues: this.bySlug, teams: this.teams, projects: this.projects, milestones: this.milestones, chats: this.chats, inbox: this.inbox };
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

  // The Inbox's unread rows, which the sidebar counts and the Inbox marks with a dot.
  get unread(): InboxRow[] {
    return [...this.inbox.values()].filter((r) => r.read === null);
  }


  // The active teams, the oldest first, as the sidebar lists them.
  get activeTeams(): Team[] {
    return [...this.teams.values()].filter((t) => t.state === "active").sort((a, b) => newestFirst(b, a));
  }
}

export const issues = new IssueStore();
