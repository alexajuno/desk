// desk's app (apps/desktop), whose preload.cjs gives desk's page window.deskApp: it lays a tab of Claude's over its box
// in a chat's Browser (sessions/Browser.tsx), or aside, and gives a picture of it. desk in a web page, the phone's
// included, has none, and shows no Browser ("likely we’ll just abandon chrome in web app", the user, 1 Nov).
export interface DeskApp {
  show(target: string | null, at?: object, aside?: boolean): void;
  still(target: string): Promise<Uint8Array | null>;
}

export const APP = (window as { deskApp?: DeskApp }).deskApp;
