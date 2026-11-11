// GitHub's webhooks: desk requests the reviewers on the user's own PRs once they are ready, as GitHub pushes the event,
// in place of muse's bin/front-door listing the user's PRs each minute ("this kind of script should be moved under desk
// project", "we should try to work on a push solution rather than pull", the user, 11 Nov). That poll's `gh` read its
// token from the login keyring, locked while nobody is logged in, and each refused unlock leaked a file in
// gnome-keyring-daemon until a login hung on a black screen (Nov 10 and 11). So the token here is the user's own from
// pass, `dev/github-preview-bot-token`, which pass gives with nobody logged in, as mail.ts's Gmail login.
//
// GitHub reaches desk through the Cloudflare Tunnel that carries n8n's hooks, as https://hooks.alexajuno.com/hooks/github,
// which passes this path and nothing else of desk (muse's n8n/tunnel/n8n.yml). Each repo of REVIEWERS has a hook for its
// pull_request events, signed with `pass show dev/github-desk-webhook-secret`. A delivery that finds desk away, the
// laptop asleep or off, fails, and muse's n8n-wake redelivers it after the next boot or resume. One that comes while desk
// restarts fails too, and nothing redelivers it: it is seconds, against the minute a PR waited for the poll.
//
// The rule is front-door's: when one of the user's PRs opens ready, reopens or leaves draft, request the repo's reviewers,
// unless one of them is already requested or has reviewed. Requesting only adds, so reviewers the user asked for by hand
// stay. desk answers once it is done, so a failure is a failed delivery, which the catch-up sends again. A test desk
// says what it would request and requests nothing.

import { execFile } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { TEST } from "./config.ts";

const ME = "alexajuno";
// "all PRs ask for tinhphantrong and chinhdt, ignore mihnsen" and "only api and portal repo needs review" (the user,
// 1 Oct, from front-door). A repo here takes reviews once it has a hook: genai-portal waits for an admin to add its own.
const REVIEWERS: Record<string, string[]> = {
  "qikify/genai-api": ["tinhphantrong0612", "chinhdt112"],
  "qikify/genai-portal": ["tinhphantrong0612", "chinhdt112"],
};
const READY = new Set(["opened", "reopened", "ready_for_review"]);

interface PullRequest { number: number; draft: boolean; user: { login: string }; requested_reviewers: { login: string }[] }

const secret = async (name: string) => (await promisify(execFile)("pass", ["show", name], { timeout: 30_000 })).stdout.split("\n")[0].trim();

// GitHub signs the body as it sent it: an HMAC-SHA256 with the hook's secret, in hex after "sha256=".
function signed(body: Buffer, header: unknown, key: string) {
  const want = Buffer.from(`sha256=${createHmac("sha256", key).update(body).digest("hex")}`);
  const got = Buffer.from(typeof header === "string" ? header : "");
  return got.length === want.length && timingSafeEqual(got, want);
}

async function github(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await secret("dev/github-preview-bot-token")}`, accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`github: ${init.method ?? "GET"} ${path} answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function requestReviewers(repo: string, pr: PullRequest, action: string) {
  const key = `${repo}#${pr.number}`, wanted = REVIEWERS[repo];
  const reviews = (await github(`/repos/${repo}/pulls/${pr.number}/reviews?per_page=100`)) as { user: { login: string } | null }[];
  const present = new Set([...pr.requested_reviewers.map((r) => r.login), ...reviews.map((r) => r.user?.login)]);
  const already = wanted.filter((login) => present.has(login));
  if (already.length) {
    console.log(`github: ${key} ${action}, already has ${already.join(", ")}`);
    return { pr: key, already };
  }
  if (!TEST) await github(`/repos/${repo}/pulls/${pr.number}/requested_reviewers`, { method: "POST", body: JSON.stringify({ reviewers: wanted }) });
  console.log(`github: ${key} ${action}, ${TEST ? "would request" : "requested"} ${wanted.join(", ")}`);
  return { pr: key, requested: wanted, test: TEST || undefined };
}

export function routes(app: FastifyInstance) {
  app.register(async (hooks) => {
    // The signature is over the bytes GitHub sent, so the body stays as they came.
    hooks.removeContentTypeParser("application/json");
    hooks.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    hooks.post("/hooks/github", async (req, reply) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!signed(body, req.headers["x-hub-signature-256"], await secret("dev/github-desk-webhook-secret"))) {
        return reply.code(401).send({ detail: "The signature does not match." });
      }
      const event = req.headers["x-github-event"];
      if (event !== "pull_request") return { ignored: event };
      const { action, pull_request: pr, repository } = JSON.parse(body.toString()) as { action: string; pull_request: PullRequest; repository: { full_name: string } };
      if (!REVIEWERS[repository.full_name] || !READY.has(action) || pr.draft || pr.user.login !== ME) return { ignored: `${event}.${action}` };
      return requestReviewers(repository.full_name, pr, action);
    });
  });
}
