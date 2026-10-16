// Folded sections (desk.css .sec): a click on a section's heading or its triangle folds or unfolds it, and Alt+click
// every section with the same kind of heading on the page; the folded ones on each page are remembered in this
// browser (localStorage.folded, { "/issue/x": ["context"], ... }) by the heading's id, as the old pages keep them, so
// both share what is folded. An id that repeats on a page, as a Context in the description and another in result.md,
// is told apart by its count: "context~1". Sections come both from React and from the server's HTML, so this works on
// the page's DOM, as desk.js did.
import { deskPath } from "../app/nav";

function sectionKeys(): [HTMLElement, string][] {
  const count: Record<string, number> = {};
  return [...document.querySelectorAll<HTMLElement>(".sec")].map((sec) => {
    const id = sec.dataset.sec ?? "", n = (count[id] = (count[id] ?? -1) + 1);
    return [sec, n ? `${id}~${n}` : id];
  });
}

const remembered = (): Record<string, string[]> => JSON.parse(localStorage.folded ?? "{}");

export function showFolded(path = deskPath()) {
  const shut = remembered()[path] ?? [];
  for (const [sec, key] of sectionKeys()) {
    const folded = shut.includes(key);
    sec.classList.toggle("folded", folded);
    sec.querySelector(":scope > .sec-head .sec-toggle")?.setAttribute("aria-expanded", String(!folded));
  }
}

export function toggleSection(sec: HTMLElement, all = false) {
  const closing = !sec.classList.contains("folded"), here = deskPath();
  const kind = (s: Element) => s.querySelector(":scope > .sec-head")?.tagName;
  const memory = remembered(), shut = new Set(memory[here]);
  for (const [s, key] of sectionKeys()) if (s === sec || (all && kind(s) === kind(sec))) closing ? shut.add(key) : shut.delete(key);
  if (shut.size) memory[here] = [...shut];
  else delete memory[here];
  localStorage.folded = JSON.stringify(memory);
  showFolded(here);
}

// A link to a heading, from On this page or the address, unfolds the sections it sits in.
export function unfoldTo(target: Element | null) {
  for (let sec = target?.closest(".sec") as HTMLElement | null; sec; sec = sec.parentElement?.closest(".sec") as HTMLElement | null)
    if (sec.classList.contains("folded")) toggleSection(sec);
}
