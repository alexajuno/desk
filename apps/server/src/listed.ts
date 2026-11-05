// Whether a chat's list of steps kept up with the talk: "not a fixed plan, but after each turn, we update the plan" (the
// user, 5 Nov). The session host asks as a turn on the user's message ends (host.ts, listBehind).
import * as chats from "./chats.ts";
import * as store from "./issues.ts";

// When, in ms, each issue's list last changed. Kept in memory, as Auto's marks are: a desk that restarted during the turn
// has forgotten, and at worst tells the chat once when it had no need to.
const moved = new Map<string, number>();

export const changed = (slug: string) => void moved.set(slug, Date.now());

// Whether the session's chat works an issue whose list has not changed since the message its turn answers. A closed issue's
// list is its record, and what comes after is mostly thanks. A chat that just bound itself to an issue in another folder
// lists its steps there, in the next turn, as desk tells it to.
const CLOSED = new Set(["landing", "done", "dropped"]);

export async function behind(session: string, since: number): Promise<boolean> {
  const chat = chats.agentChatOf(session);
  if (!chat?.issue || chats.moving(chat.id)) return false;
  const i = await store.load(chat.issue).catch(() => null);
  return Boolean(i) && !CLOSED.has(i!.state) && (moved.get(i!.slug) ?? 0) < since;
}
