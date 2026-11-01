// A chat's own smooth scroll for vim's keys, as Vimium's (Frame): a press eases the chat to where it goes, a press while
// it moves adds on to where it was going, and J, K, ↑ or ↓ held down glides it at a steady pace until let go. G G and
// Shift G jump. With reduce motion on, every move jumps.
const still = matchMedia("(prefers-reduced-motion: reduce)");
// How far J, K, ↑ and ↓ scroll the chat, as Vimium's: a few lines.
export const LINE = 60;
// A held key's pace, in px a second: a tap's own, a line in 0.1 s. It comes up to it in RAMP ms, with no jerk.
const PACE = LINE * 10, RAMP = 100;

// The move under way: the chat it scrolls, where it last put it, whether it goes up, where an eased move goes, and the key
// a glide follows.
let move: { el: HTMLElement; at: number; frame: number; up: boolean; to?: number; key?: string } | null = null;

// Whether a move under way takes this chat up, which lets go of its end at once, as the reader scrolling up does (Dock):
// its first frames, still near the end, would else leave the chat following a reply that streams, which pulls it back.
export const rising = (el: HTMLElement) => move?.el === el && move.up;

// The move under way stops where it is.
export function halt() {
  if (move) cancelAnimationFrame(move.frame);
  move = null;
}

// The chat to a place at once, as G G and Shift G take it.
export function jump(el: HTMLElement, top: number) {
  halt();
  el.scrollTo({ top });
}

const clamp = (el: HTMLElement, top: number) => Math.max(0, Math.min(el.scrollHeight - el.clientHeight, top));

// One move, a frame at a time: next gives this frame's place, and whether there is more to go. Something else moving the
// chat meanwhile, a wheel or the chat following its reply (Dock), wins, and the move stops.
function animate(el: HTMLElement, next: (now: number) => [number, boolean], keep: { up: boolean; to?: number; key?: string }) {
  halt();
  const m = { el, at: el.scrollTop, frame: 0, ...keep };
  const tick = (now: number) => {
    if (move !== m) return;
    if (!el.isConnected || Math.abs(el.scrollTop - m.at) > 2) { move = null; return; }
    const [top, more] = next(now);
    el.scrollTop = top;
    m.at = el.scrollTop;
    // The last frame's scroll event comes a frame later, and still finds the move, so the chat lets go of its end.
    m.frame = requestAnimationFrame(more ? tick : () => move === m && (move = null));
  };
  move = m;
  m.frame = requestAnimationFrame(tick);
}

// The chat by `by` px in `ms`, fast then easing, from where a move under way was going.
export function ease(el: HTMLElement, by: number, ms: number) {
  const to = clamp(el, (move?.el === el && move.to !== undefined ? move.to : el.scrollTop) + by);
  if (still.matches || !ms) { jump(el, to); return; }
  const from = el.scrollTop, start = performance.now();
  animate(el, (now) => {
    const t = Math.max(0, Math.min(1, (now - start) / ms));
    return [from + (to - from) * (1 - (1 - t) ** 3), t < 1];
  }, { up: to < from, to });
}

// J, K, ↑ or ↓ held down, which the keyboard repeats: the chat glides until the key is let go or the chat ends.
export function glide(el: HTMLElement, by: 1 | -1, key: string) {
  if (still.matches) { ease(el, by * LINE, 0); return; }
  if (move?.el === el && move.key === key) return;
  const start = performance.now();
  let top = el.scrollTop, then = start;
  animate(el, (now) => {
    top = clamp(el, top + by * PACE * Math.min(1, Math.max(0, now - start) / RAMP) * (Math.max(0, now - then) / 1000));
    then = now;
    return [top, by > 0 ? top < el.scrollHeight - el.clientHeight : top > 0];
  }, { up: by < 0, key });
}

// A key let go ends its glide; the window losing the keys, any glide.
export function letGo(key?: string) {
  if (move?.key && (key === undefined || key === move.key)) halt();
}
