// The list an issue was opened from, so that J and K on its page open the next and the previous issue in it, and its
// top bar says where it stands ("7 / 187"), as Linear's issue view does. Kept in sessionStorage.walk, so a reload keeps it.
import { observable, runInAction } from "mobx";

const read = (): string[] => {
  try { return JSON.parse(sessionStorage.walk ?? "[]"); } catch { return []; }
};
const walk = observable.box<string[]>(read(), { deep: false });

// As a row opens its issue: the issue rows of its list, in their order, less those a folded group hides.
export function noteWalk(row: HTMLElement) {
  const list = row.closest(".tree, .board") ?? document;
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
