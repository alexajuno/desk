// What you type after / until the search's box shows: a key typed before it draws would reach no box, or act as a
// shortcut. / gives the focus at once to this box, out of sight, and the search takes what it caught (23 Oct).
const catcher = () => document.getElementById("search-catch") as HTMLInputElement | null;

export const Catcher = () => (
  <input id="search-catch" className="search-catch" type="text" tabIndex={-1} aria-hidden="true" autoComplete="off" spellCheck={false} />
);

export function catchKeys() {
  const box = catcher();
  if (!box) return;
  box.value = "";
  box.focus();
}

// What it caught, while it still has the focus: a click elsewhere meanwhile keeps the focus where it went.
export function takeCaught(): string | null {
  const box = catcher();
  if (!box || document.activeElement !== box) return null;
  const text = box.value;
  box.value = "";
  return text;
}
