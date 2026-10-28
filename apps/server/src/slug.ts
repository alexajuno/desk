// A slug made from a title, as WordPress and sindresorhus/slugify make one: accents become plain letters ("Ngủ dậy" →
// ngu-day; đ has no accent to strip, so it maps by hand), an apostrophe goes ("can’t" → cant, not can-t), and a long
// title is cut back to its last whole word, never to half a word or a trailing dash, as Reddit cuts its 50 (the
// research of 28 Oct, ~/notes/findings/2026-10-28-url-slug-from-title-prior-art.md). The title itself stays whole.
export function slugify(title: string, fallback: string, max = 50): string {
  const words = title.normalize("NFD").replace(/\p{M}/gu, "").replace(/[đĐ]/g, "d").toLowerCase()
    .replace(/['‘’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (words.length <= max) return words || fallback;
  const cut = words.lastIndexOf("-", max);
  return cut > 0 ? words.slice(0, cut) : words.slice(0, max);
}
