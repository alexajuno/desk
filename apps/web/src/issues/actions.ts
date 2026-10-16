// What the issue pages do to an issue, through the server's form routes (app.ts), as desk.js did.
import { post, postJson, reason } from "../api/http";
import { deskPath, go } from "../app/nav";
import type { Field } from "../lib/desk";
import { toast } from "../ui/toast";
import { reloadPages, ui } from "../store/ui";

export async function setField(slug: string, field: Field | "title" | "body" | "waiting_on" | "project" | "parent", value: string) {
  if (field === "state" || field === "priority" || field === "protocol") ui.paint(slug, field, value);
  const res = await post(`/issue/${slug}/set`, { field, value });
  if (!res.ok) toast(await reason(res));
  await reloadPages();
  ui.unpaint(slug);
}

export async function setFolder(slug: string, folder: string) {
  await post(`/issue/${slug}/folder`, { folder });
  await reloadPages();
}

// A session's chat, in a floating kitty window over desk (window.ts): the page stays as it is; a failure says why.
export async function openWindow(url: string, body: unknown = {}) {
  const res = await postJson(url, body);
  if (!res.ok) toast(await reason(res));
  return res.ok ? res.json() : null;
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
  const to = left ? (parent && !deleted.includes(parent) ? `/issue/${parent}` : "/backlog") : null;
  sessionStorage.undo = JSON.stringify([...undoList(), { slug, back: left ? deskPath() : null, to }].slice(-20));
  if (ui.focused && deleted.includes(ui.focused)) ui.focus(null);
  const kids = deleted.length - 1;
  toast(kids ? `Issue and ${kids} sub-issue${kids > 1 ? "s" : ""} deleted` : "Issue deleted", { label: "Undo", kbd: "Ctrl Z", run: undo });
  if (to) go(to, { replace: true });
  else await reloadPages();
}

export async function undo() {
  const list = undoList(), last = list.pop();
  if (!last) return;
  sessionStorage.undo = JSON.stringify(list);
  const res = await post(`/trash/${last.slug}/restore`);
  if (!res.ok) return toast(await reason(res));
  toast("Issue restored");
  if (last.back && deskPath() === last.to) go(last.back, { replace: true });
  else await reloadPages();
}
