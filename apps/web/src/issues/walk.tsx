// The list an issue was opened from, so that J and K on its page open the next and the previous issue in it, and its
// top bar says where it stands ("7 / 187"), as Linear's issue view does. Kept in sessionStorage.walk, so a reload keeps it.
import { observable, runInAction } from "mobx";
import { observer } from "mobx-react-lite";
import { go } from "../app/nav";

const read = (): string[] => {
  try { return JSON.parse(sessionStorage.walk ?? "[]"); } catch { return []; }
};
const walk = observable.box<string[]>(read(), { deep: false });

// As a row opens its issue: the issue rows of its list, in their order, less those a folded group hides. The list is
// the page's every group, or the board, else the outermost tree round the row (an issue's sub-issues, a search's results).
export function noteWalk(row: HTMLElement) {
  let list: ParentNode = row.closest(".issue-list, .board") ?? document;
  if (list === document) for (let t = row.closest(".tree"); t; t = t.parentElement?.closest(".tree") ?? null) list = t;
  const slugs = [...new Set([...list.querySelectorAll<HTMLElement>(".item[data-slug]")].filter((r) => r.checkVisibility()).map((r) => r.dataset.slug!))];
  runInAction(() => walk.set(slugs));
  sessionStorage.walk = JSON.stringify(slugs);
}

// Where the issue stands in the list it was opened from, from 1; null when it is not in it.
export function placeOf(slug: string): { at: number; of: number } | null {
  const slugs = walk.get(), i = slugs.indexOf(slug);
  return i < 0 ? null : { at: i + 1, of: slugs.length };
}

// The issue `by` rows down (1) or up (-1) from this one; null at either end, or off the list.
export function stepFrom(slug: string, by: number): string | null {
  const slugs = walk.get(), i = slugs.indexOf(slug);
  return i < 0 ? null : slugs[i + by] ?? null;
}

// Linear's arrow, from its issue view's Navigate down; turned over for Navigate up.
const ARROW = <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.48 10.326a.75.75 0 0 0-.96-1.152l-1.77 1.475V3.75a.75.75 0 0 0-1.5 0v6.899L5.48 9.174a.75.75 0 0 0-.96 1.152l3 2.5a.75.75 0 0 0 .96 0l3-2.5Z" /></svg>;

// Where the issue stands in the list it was opened from, and the next and previous issue in it, as J and K open them:
// Linear's "7 / 187" and its ↓ ↑ at the right end of the issue's top bar, or of its chat's head while the issue beside it
// is hidden. An issue opened from no list has none.
export const Walk = observer(function Walk({ slug }: { slug: string }) {
  const place = placeOf(slug);
  if (!place) return null;
  const step = (by: number) => { const to = stepFrom(slug, by); if (to) go(`/issue/${to}`); };
  return (
    <span className="walk">
      <span className="walk-at">{place.at}<span> / {place.of}</span></span>
      <span className="walk-steps">
        <button type="button" title="Navigate down  J" disabled={place.at === place.of} onClick={() => step(1)}>{ARROW}</button>
        <button type="button" title="Navigate up  K" disabled={place.at === 1} onClick={() => step(-1)}>{ARROW}</button>
      </span>
    </span>
  );
});
