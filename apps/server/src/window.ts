// Hyprland, for what desk does with windows: bring forward the browser window showing a page, when one of desk's
// desktop notifications is clicked. Sessions open in desk's panel; until 17 Oct they opened in floating kitty windows
// this module made.
import * as agents from "./agents.ts";
import { run, sleep, which } from "./proc.ts";

async function hyprctl(...args: string[]): Promise<string> {
  if (!which("hyprctl")) throw new Error("Raising a window needs Hyprland.");
  const r = await run(["hyprctl", ...args], { timeout: 10, env: await agents.sessionEnv() });
  if (r.code) throw new Error(`Hyprland said: ${(r.stdout + r.stderr).trim()}`);
  return r.stdout;
}

// Hyprland 0.56 takes Lua after `dispatch` and answers "ok".
async function dispatch(lua: string) {
  const said = (await hyprctl("dispatch", lua)).trim();
  if (said !== "ok") throw new Error(`Hyprland said: ${said}`);
}

interface Client { class: string; title: string; address: string; workspace: { id: number } }
const clients = async (): Promise<Client[]> => JSON.parse(await hyprctl("clients", "-j"));

// Go to the window whose title starts with the page's ("Inbox · desk - Google Chrome"), on its own workspace, and focus
// it; false when there is none. The browser renames its window a moment after the tab changes, so this looks again for
// up to a second.
export async function raiseTitled(title: string): Promise<boolean> {
  for (let n = 0; n < 10; n++) {
    for (const c of await clients()) {
      if (title && c.title.startsWith(title)) {
        await dispatch(`hl.dsp.focus({ window = "address:${c.address}" })`);
        return true;
      }
    }
    await sleep(100);
  }
  return false;
}
