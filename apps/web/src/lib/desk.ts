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
  design: "Talked through with a sketch, then go",
};

export type Field = "state" | "priority" | "protocol";
export const nameOf = (field: Field, value: string): string =>
  (field === "priority" ? PRIORITY_NAMES : field === "protocol" ? PROTOCOL_NAMES : STATE_NAMES)[value as never] ?? value;

// Vietnamese titles match without their marks: "viec" finds "việc".
export const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").toLowerCase();

// "Oct 16" for "2026-10-16T19:26:20", read as local time, as desk writes a short date (the server's when.ts, shortDate).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso.replace(" ", "T"));
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// Whether the issue came from a Slack message the user tagged with 🐧 (slack.ts), whose link it keeps.
export const fromSlack = (link: string | null) => /^https:\/\/[\w-]+\.slack\.com\//.test(link ?? "");

// An issue as the page JSON carries it (pages.ts, issueJson).
export interface IssueRow {
  slug: string;
  title: string;
  state: State;
  priority: Priority;
  parent: string | null;
  team: string | null;
  folder: string | null;
  protocol: Protocol;
  link: string | null;
  session: string | null;
  waiting_on: string | null;
  waiting_since: string | null;
  waiting_since_short: string;
  waited: string;
  review_of: "plan" | "question" | "result" | "reply" | null; // in review, what it holds for you
  created: string;
  created_short: string;
}

export interface TreeRow extends IssueRow {
  open: number;
  kids: TreeRow[];
}
