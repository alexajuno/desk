// index.html's splash, Linear's (read from linear.app's own HTML on 25 Oct): the window's background and the panel's
// empty outline, in the page's theme, drawn before any script runs. It covers the app until the page can draw whole,
// then fades out in 0.1 s (desk.css, #splash), so that no part of the page pops in on its own ("currently i find it's
// not that beautiful", the user, 25 Oct). The root route's loader waits for desk's rows and the sidebar's frame, each
// page's loader for its own data (api/page.ts, prime), and then any part drawn that is not whole yet holds it
// (useSplash), as a chat does until its conversation comes. It stays at most WAIT from the start: a slow desk draws
// what it has.
import { when } from "mobx";
import { useLayoutEffect } from "react";
import { frame } from "../store/frame";
import { issues } from "../store/issues";

const WAIT = 3000; // ms from the start, as long as a route's loader waits (api/page.ts)
const left = () => Math.max(1, WAIT - performance.now()); // never 0, which a timeout of `when` reads as none

const holds = new Set<object>(); // the parts drawn that are not whole yet
let drawn = false; // the first page is on screen, under the splash
let lifted = false;

// Whether the splash still covers the page: what changes under it changes at once, with no motion nobody would see.
export const splashUp = () => !lifted;

// The root route's loader: desk's rows, which the sidebar lists, and its frame, which adds the chats.
export const rowsIn = () => when(() => issues.seq >= 0 && frame.data !== null, { timeout: left() }).catch(() => {}).then(() => null);

// A part drawn that is not whole yet keeps the splash up while waits holds, such as a chat until its conversation comes.
export function useSplash(waits: boolean) {
  useLayoutEffect(() => {
    if (!waits || lifted) return;
    const hold = {};
    holds.add(hold);
    return () => {
      holds.delete(hold);
      check();
    };
  }, [waits]);
}

// The router drew the first page (Frame): the splash goes once its fonts are in and no part holds it.
export function firstDrawn() {
  if (drawn) return;
  drawn = true;
  const fonts = {};
  holds.add(fonts);
  void document.fonts.ready.then(() => {
    holds.delete(fonts);
    check();
  });
}

function check() {
  if (lifted || !drawn || holds.size) return;
  // A part that comes on screen in the same frame, as a chat the dock opens, still holds it: look again at the next.
  requestAnimationFrame(() => { if (!holds.size) lift(); });
}

function lift() {
  if (lifted) return;
  lifted = true;
  holds.clear();
  // What began to move under the splash is shown as it ends, so the page fades in whole and still: a chat's messages,
  // which rise in as they come (dock.css), came just before it lifted, and rose through its fade.
  for (const a of document.getAnimations()) {
    const target = (a.effect as KeyframeEffect | null)?.target;
    if (target instanceof Element && target.closest("#splash")) continue;
    if (a.effect?.getComputedTiming().endTime === Infinity) continue; // a working dot breathes for as long as it works
    try {
      a.finish();
    } catch {
      // one that cannot end, as a paused one
    }
  }
  document.documentElement.classList.add("splashed");
  setTimeout(() => document.getElementById("splash")?.remove(), 200); // once its 0.1 s fade is over
}

setTimeout(lift, left());
