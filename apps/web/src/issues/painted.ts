import type { IssueRow } from "../lib/desk";
import { ui } from "../store/ui";

// The issue's fields with any change shown before the server has it (ui.paint).
export function painted<T extends IssueRow>(issue: T): T {
  const o = ui.overrides.get(issue.slug);
  return o ? { ...issue, ...o } : issue;
}
