// What the app's screen holds besides the data: the row in focus (hover, or J and K, as in Linear), the rows selected
// (X, Shift-click, Shift ↑ ↓, Ctrl A, as in Linear), an open editor, the shortcuts panel, the new issue panel, and
// changes shown before the server has them.
import { action, makeObservable, observable, observableRef } from "mobx";
import type { Field } from "../lib/desk";

export interface CreatorPreset {
  state?: string;
  priority?: string;
  protocol?: string;
  parent?: string;
  parentTitle?: string;
  project?: string;
  projectTitle?: string;
}

class UI {
  focused: string | null = null; // the slug of the row in focus
  selected = observable.set<string>(); // the slugs of the rows selected, which S, P, right-click and the bar act on
  anchor: string | null = null; // where a Shift-click's range starts: the row last selected
  byMouse = false;
  editing = false;
  keysOpen = false;
  creator: CreatorPreset | null = null;
  overrides = observable.map<string, Partial<Record<Field, string>>>();

  constructor() {
    makeObservable(this, {
      focused: observable, byMouse: observable, editing: observable, keysOpen: observable, creator: observableRef,
      focus: action, select: action, toggleSelect: action, unselect: action, clearSelection: action, setEditing: action, setKeys: action, openCreator: action, closeCreator: action, paint: action, unpaint: action,
    });
  }

  focus(slug: string | null, byMouse = false) {
    this.focused = slug;
    this.byMouse = byMouse;
  }

  select(slugs: string[]) {
    for (const slug of slugs) this.selected.add(slug);
    if (slugs.length) this.anchor = slugs[slugs.length - 1];
  }

  toggleSelect(slug: string) {
    if (this.selected.has(slug)) this.selected.delete(slug);
    else this.selected.add(slug);
    this.anchor = slug;
  }

  unselect(slugs: string[]) {
    for (const slug of slugs) this.selected.delete(slug);
  }

  clearSelection() {
    this.selected.clear();
    this.anchor = null;
  }

  setEditing(on: boolean) {
    this.editing = on;
  }

  setKeys(open: boolean) {
    this.keysOpen = open;
  }

  openCreator(preset: CreatorPreset = {}) {
    this.creator = preset;
  }

  closeCreator() {
    this.creator = null;
  }

  // A change shows at once, then is saved, then the page draws what the server holds (desk.js paint).
  paint(slug: string, field: Field, value: string) {
    this.overrides.set(slug, { ...this.overrides.get(slug), [field]: value });
  }

  unpaint(slug: string) {
    this.overrides.delete(slug);
  }
}

export const ui = new UI();

// The pages showing now: each registers how to draw itself again, which an action calls once it saved.
const reloaders = new Set<() => Promise<void>>();
export function onReload(fn: () => Promise<void>) {
  reloaders.add(fn);
  return () => { reloaders.delete(fn); };
}
export const reloadPages = () => Promise.all([...reloaders].map((fn) => fn()));
