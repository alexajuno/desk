// The list on screen: its page's path and its view as the server last drew it. The Filter menus read it each time
// they draw, and a change to the view resolves once the list's next data is in, so a ticked box shows its new state.
import { action, makeObservable, observable, observableRef, when } from "mobx";
import { setFilter as setFilterAt, setView as setViewAt, toggleValue as toggleAt, type Filter, type ViewData } from "./view";

class ListView {
  path = "";
  view: ViewData | null = null;
  loads = 0;
  displayOpen = false;

  constructor() {
    makeObservable(this, { path: observable, view: observableRef, loads: observable, displayOpen: observable, set: action, clear: action, setDisplay: action });
  }

  set(path: string, view: ViewData) {
    this.path = path;
    this.view = view;
    this.loads++;
  }

  clear() {
    this.view = null;
    this.displayOpen = false;
  }

  setDisplay(open: boolean) {
    this.displayOpen = open;
  }
}

export const listView = new ListView();

const next = () => {
  const before = listView.loads;
  return when(() => listView.loads > before, { timeout: 5000 }).catch(() => undefined);
};

export function setView(changes: Record<string, string | boolean | null>) {
  if (!listView.view) return Promise.resolve();
  const done = next();
  setViewAt(listView.path, listView.view, changes);
  return done;
}

export function setFilter(name: string, filter: Filter | null) {
  if (!listView.view) return Promise.resolve();
  const done = next();
  setFilterAt(listView.path, listView.view, name, filter);
  return done;
}

export function toggleValue(name: string, value: string) {
  if (!listView.view) return Promise.resolve();
  const done = next();
  toggleAt(listView.path, listView.view, name, value);
  return done;
}
