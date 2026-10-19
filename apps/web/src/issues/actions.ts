// What the issue pages do to an issue, through the server's form routes (app.ts), as desk.js did.
import { post, postJson, reason } from "../api/http";
import { deskPath, go } from "../app/nav";
import type { Field } from "../lib/desk";
import { toast } from "../ui/toast";
import { reloadPages, ui } from "../store/ui";

type Settable = Field | "title" | "body" | "waiting_on" | "project" | "parent";

// base: for the body, the document the edit started from, so the server keeps what a session wrote meanwhile.
export async function setField(slug: string, field: Settable, value: string, base?: string) {
  if (field === "state" || field === "priority" || field === "protocol") ui.paint(slug, field, value);
  const res = await post(`/issue/${slug}/set`, { field, value, ...(base === undefined ? {} : { base }) });
  if (!res.ok) toast(await reason(res));
  else autoClosed(await res.json());
  await reloadPages();
  ui.unpaint(slug);
}

// The same field on every issue of a list's selection, saved whole or not at all.
export async function setFields(slugs: string[], field: Settable, value: string) {
  if (field === "state" || field === "priority") for (const slug of slugs) ui.paint(slug, field, value);
  const res = await postJson("/issues/set", { slugs, field, value });
  if (!res.ok) toast(await reason(res));
  else if (!autoClosed(await res.json())) toast(`${slugs.length} issues changed`);
  await reloadPages();
  for (const slug of slugs) ui.unpaint(slug);
  // An issue the change took off the list, such as one dropped, leaves the selection.
  ui.unselect(slugs.filter((slug) => !document.querySelector(`.tree .item[data-slug="${CSS.escape(slug)}"]`)));
}

// Says what Settings › Workflows & automations closed along with a change, if anything.
function autoClosed({ closed }: { closed?: string[] }): boolean {
  if (!closed?.length) return false;
  toast(`Auto-closed ${closed.length} more issue${closed.length > 1 ? "s" : ""}`);
  return true;
}

export async function setFolder(slug: string, folder: string) {
  await post(`/issue/${slug}/folder`, { folder });
  await reloadPages();
}

export async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const box = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(box);
    box.select();
    document.execCommand("copy");
    box.remove();
  }
  toast(done);
}

// Deleted issues wait in desk's trash; the undo list lives in sessionStorage, so Ctrl+Z still works after you move
// to another page (desk.js keeps the same list, so either undoes the other's delete).
interface Undo {
  slug: string;
  back: string | null;
  to: string | null;
}
export const undoList = (): Undo[] => JSON.parse(sessionStorage.undo ?? "[]");

export async function remove(slug: string, here: string | null) {
  const res = await post(`/issue/${slug}/delete`);
  if (!res.ok) return toast(await reason(res));
  const { deleted, parent } = (await res.json()) as { deleted: string[]; parent: string | null };
  const left = here !== null && deleted.includes(here);
  const to = left ? (parent && !deleted.includes(parent) ? `/issue/${parent}` : "/issues") : null;
  sessionStorage.undo = JSON.stringify([...undoList(), { slug, back: left ? deskPath() : null, to }].slice(-20));
  if (ui.focused && deleted.includes(ui.focused)) ui.focus(null);
  const kids = deleted.length - 1;
  toast(kids ? `Issue and ${kids} sub-issue${kids > 1 ? "s" : ""} deleted` : "Issue deleted", { label: "Undo", kbd: "Ctrl Z", run: undo });
  if (to) go(to, { replace: true });
  else await reloadPages();
}

// A list's selection, each with its sub-issues; Undo brings them all back, Ctrl Z one at a time.
export async function removeMany(slugs: string[]) {
  const gone: string[] = [], undone: Undo[] = [];
  for (const slug of slugs) {
    if (gone.includes(slug)) continue; // went with a selected parent
    const res = await post(`/issue/${slug}/delete`);
    if (!res.ok) { toast(await reason(res)); break; }
    gone.push(...((await res.json()) as { deleted: string[] }).deleted);
    undone.push({ slug, back: null, to: null });
  }
  sessionStorage.undo = JSON.stringify([...undoList(), ...undone].slice(-20));
  ui.clearSelection();
  if (ui.focused && gone.includes(ui.focused)) ui.focus(null);
  if (undone.length) toast(`${gone.length} issues deleted`, { label: "Undo", kbd: "Ctrl Z", run: () => undo(undone.length) });
  await reloadPages();
}

export async function undo(times = 1) {
  let restored = 0, last: Undo | undefined;
  for (let n = 0; n < times; n++) {
    const list = undoList();
    last = list.pop();
    if (!last) break;
    sessionStorage.undo = JSON.stringify(list);
    const res = await post(`/trash/${last.slug}/restore`);
    if (!res.ok) return toast(await reason(res));
    restored++;
  }
  if (!restored || !last) return;
  toast(restored > 1 ? `${restored} issues restored` : "Issue restored");
  if (last.back && deskPath() === last.to) go(last.back, { replace: true });
  else await reloadPages();
}
