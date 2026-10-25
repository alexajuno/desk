// desk on the user's tailnet: `tailscale serve` hands desk's page to the user's own devices over HTTPS, at this
// machine's name there, such as myarch.tail348f25.ts.net, so the phone runs desk as an app (25 Oct). Its requests
// reach desk from 127.0.0.1, with that name as their Host and https://<name> as their Origin (checked on 25 Oct).
// desk reads the name from tailscale when it starts, and every few minutes after, since tailscale may come up later.
import { run } from "./proc.ts";

let name: string | null = null;

async function refresh() {
  try {
    const done = await run(["tailscale", "status", "--json"], { timeout: 10 });
    name = (JSON.parse(done.stdout) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, "") || null;
  } catch {
    name = null; // no tailscale, or it said nothing readable
  }
}

void refresh();
setInterval(refresh, 5 * 60_000).unref();

// This machine's name on the tailnet, or null while tailscale is not running.
export const tailnetName = () => name;
