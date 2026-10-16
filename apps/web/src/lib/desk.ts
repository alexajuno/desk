// desk's vocabulary, as the server's issues.ts defines it.
export type State = "triage" | "backlog" | "running" | "waiting" | "review" | "landing" | "done" | "dropped";
export type Priority = "urgent" | "high" | "medium" | "low" | "none";
export type Protocol = "quick" | "brief" | "design";

export const STATES: State[] = ["triage", "backlog", "running", "waiting", "review", "landing", "done", "dropped"];
export const PRIORITIES: Priority[] = ["urgent", "high", "medium", "low", "none"];
export const PROTOCOLS: Protocol[] = ["quick", "brief", "design"];
export const CLOSED: State[] = ["done", "dropped"];

export const STATE_NAMES: Record<State, string> = {
  triage: "Triage", backlog: "Backlog", running: "In progress", waiting: "Waiting",
  review: "In review", landing: "Landing", done: "Done", dropped: "Dropped",
};
export const PRIORITY_NAMES: Record<Priority, string> = {
  urgent: "Urgent", high: "High", medium: "Medium", low: "Low", none: "No priority",
};
export const PROTOCOL_NAMES: Record<Protocol, string> = { quick: "Quick", brief: "Brief", design: "Design" };
// What each protocol does, under its name in the picker.
export const PROTOCOL_HINTS: Record<Protocol, string> = {
  quick: "A 3-line brief, then the work, no go",
  brief: "A 3-line brief, then waits for go",
  design: "A design doc you talk through, then go",
};

export type Field = "state" | "priority" | "protocol";
export const nameOf = (field: Field, value: string): string =>
  (field === "priority" ? PRIORITY_NAMES : field === "protocol" ? PROTOCOL_NAMES : STATE_NAMES)[value as never] ?? value;

// Vietnamese titles match without their marks: "viec" finds "việc".
export const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").toLowerCase();

// An issue as the page JSON carries it (pages.ts, issueJson).
export interface IssueRow {
  slug: string;
  title: string;
  state: State;
  priority: Priority;
  parent: string | null;
  project: string | null;
  folder: string | null;
  protocol: Protocol;
  link: string | null;
  session: string | null;
  waiting_on: string | null;
  waiting_since: string | null;
  waiting_since_short: string;
  waited: string;
  created: string;
  created_short: string;
}

export interface TreeRow extends IssueRow {
  open: number;
  kids: TreeRow[];
}
