// Calls to desk's server. The old pages' forms post form-encoded fields; their routes answer with a redirect that
// may carry ?msg= and ?trust=1 for the strip (app.py, back), which a fetch follows and the app reads off the final URL.
export const post = (url: string, fields: Record<string, string> = {}) =>
  fetch(url, { method: "POST", body: new URLSearchParams(fields) });

export const postJson = (url: string, body: unknown = {}) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export async function reason(res: Response): Promise<string> {
  try {
    return (await res.json()).detail;
  } catch {
    return `Failed (${res.status})`;
  }
}

// What a form route said after its redirect: a message for the strip, and whether to offer Trust folder.
export function said(res: Response): { msg: string | null; trust: boolean } {
  const url = new URL(res.url);
  return { msg: url.searchParams.get("msg") ?? url.searchParams.get("note"), trust: url.searchParams.get("trust") === "1" };
}
