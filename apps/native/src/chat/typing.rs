// What the composer does with what is typed, as the web app's Composer (Dock.tsx): / and @ completed from a list over
// the box, what is typed kept for each chat between runs, Ctrl S's stash, ↑ taking back the messages that wait, Ctrl
// Enter sending them now, a message that did not go put back in the box, and /model and /effort set as the chip sets
// them.
use std::sync::Mutex;

use gpui_kit::base::StyledExt;
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use regex::Regex;
use serde_json::{json, Value};

use super::{now, Chat, Pending};
use crate::filters::{colours, pop_shadow};
use crate::live::{self, Attachment, Model, EFFORTS};
use crate::{net, picker, theme, toast};

// --- kept between runs, as the web keeps them in localStorage: the 50 chats typed in last keep theirs -------------------

const DRAFTS: &str = "native-composer-drafts";
const STASHES: &str = "native-composer-stashes";
static KEEPING: Mutex<()> = Mutex::new(());

fn kept(file: &str) -> Vec<(String, String)> {
    crate::state_dir()
        .and_then(|d| std::fs::read_to_string(d.join(file)).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn kept_of(file: &str, id: &str) -> Option<String> {
    kept(file).into_iter().find(|(k, _)| k == id).map(|(_, text)| text)
}

fn keep(file: &str, id: &str, text: &str) {
    let _one = KEEPING.lock();
    let mut all = kept(file);
    all.retain(|(k, _)| k != id);
    if !text.trim().is_empty() { all.push((id.to_string(), text.to_string())) }
    let from = all.len().saturating_sub(50);
    let Some(dir) = crate::state_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join(file), serde_json::to_string(&all[from..]).unwrap_or_default());
}

// --- completion -------------------------------------------------------------------------------------------------------

#[derive(Clone)]
pub(super) struct Pick {
    label: String,
    hint: String,
    insert: String,
}

// A word being typed that the composer completes: a / at the start, or after a space once a letter follows it, as
// Claude Code's terminal does; or an @ after a space. `start` is where its / or @ is.
#[derive(Clone)]
pub(super) struct Token {
    slash: bool,
    start: usize,
    word: String,
}

fn token_at(text: &str, caret: usize) -> Option<Token> {
    let before = text.get(..caret)?;
    let start = before.char_indices().rev().find(|(_, c)| c.is_whitespace()).map_or(0, |(i, c)| i + c.len_utf8());
    let typed = &before[start..];
    if let Some(word) = typed.strip_prefix('/') {
        let named = word.chars().all(|c| c.is_ascii_alphanumeric() || "_:.-".contains(c));
        return (named && (start == 0 || !word.is_empty())).then(|| Token { slash: true, start, word: word.into() });
    }
    typed.strip_prefix('@').map(|word| Token { slash: false, start, word: word.into() })
}

fn picks_of(list: &Value, mark: &str) -> Vec<Pick> {
    list.as_array().into_iter().flatten().filter_map(|c| {
        let name = c["name"].as_str()?;
        Some(Pick { label: format!("{mark}{name}"), hint: c["description"].as_str().unwrap_or("").to_string(), insert: format!("{mark}{name} ") })
    }).collect()
}

// What one completion asks desk, off the window's thread: the lists it fetched, to keep, and the rows to show.
struct Found {
    commands: Option<Vec<Pick>>,
    agents: Option<Vec<Pick>>,
    rows: Vec<Pick>,
}

fn find(session: String, token: Token, opening: bool, commands: Option<Vec<Pick>>, agents: Option<Vec<Pick>>) -> Found {
    let word = token.word.to_lowercase();
    let holds = |p: &Pick| p.label[1..].to_lowercase().contains(&word);
    if token.slash {
        let all = commands.unwrap_or_else(|| net::get(&format!("/api/live/{session}/commands")).map(|v| picks_of(&v, "/")).unwrap_or_default());
        let mut rows: Vec<Pick> = all.iter().filter(|p| holds(p)).cloned().collect();
        rows.sort_by_key(|p| !p.label[1..].to_lowercase().starts_with(&word));
        rows.truncate(12);
        return Found { commands: Some(all), agents: None, rows };
    }
    // A new desk chat's first @ names one of your agents, whom the chat is then with; otherwise @ is a file.
    let (agents, rows) = if opening {
        let all = agents.unwrap_or_else(|| net::get("/api/agents").map(|v| picks_of(&v, "@")).unwrap_or_default());
        let rows: Vec<Pick> = all.iter().filter(|p| holds(p)).cloned().collect();
        (Some(all), rows)
    } else {
        (None, Vec::new())
    };
    if !rows.is_empty() { return Found { commands: None, agents, rows } }
    let files = net::get(&format!("/api/live/{session}/files?q={}", picker::encode(&token.word))).unwrap_or(Value::Null);
    let rows = files.as_array().into_iter().flatten().filter_map(Value::as_str).take(12)
        .map(|f| Pick { label: f.to_string(), hint: String::new(), insert: format!("@{f} ") }).collect();
    Found { commands: None, agents, rows }
}

// --- the box ----------------------------------------------------------------------------------------------------------

// /model or /effort at a message's start: what to send the server, and the message as typed, to put back if it refuses.
pub(super) struct Picked {
    set: Value,
    typed: String,
}

// What the box holds, put away or to put back: the text, its files and where the cursor was.
#[derive(Default)]
pub(super) struct Boxed {
    pub text: String,
    pub attached: Vec<Attachment>,
    pub caret: usize,
}

// /model and /effort at the start of a message, as many as typed and in any order, set as the chip sets them.
struct Runs {
    model: Option<Model>,
    effort: Option<String>,
    rest: String,
}

impl Chat {
    // The chat's session is known: what was typed in it and put away come back.
    pub(super) fn bring_back(&mut self, session: &str) {
        self.draft = kept_of(DRAFTS, session);
        self.stash = kept_of(STASHES, session).map(|text| Boxed { caret: text.len(), text, attached: Vec::new() });
    }

    // What is typed changed: kept for the chat, and the word at the cursor completed.
    pub(super) fn typed(&mut self, cx: &mut Context<Self>) {
        let (text, caret) = { let c = self.composer.read(cx); (c.value().to_string(), c.cursor()) };
        if let Some(session) = self.session.clone() {
            let kept = text.clone();
            cx.background_spawn(async move { keep(DRAFTS, &session, &kept) }).detach();
        }
        self.complete(token_at(&text, caret), cx);
        cx.notify();
    }

    fn complete(&mut self, token: Option<Token>, cx: &mut Context<Self>) {
        self.asked += 1;
        let (Some(token), Some(session)) = (token, self.session.clone()) else {
            self.token = None;
            self.picks.clear();
            return;
        };
        let m = &self.meta;
        let opening = (m.is_null() || (m["chat"].as_bool().unwrap_or(false) && m["agent"].is_null())) && token.start == 0 && self.items.is_empty() && self.pending.is_empty();
        let (asked, mid) = (self.asked, token.slash && token.start > 0);
        let (commands, agents) = (self.commands.clone(), self.agents.clone());
        self.token = Some(token.clone());
        cx.spawn(async move |this, cx| {
            let found = cx.background_spawn(async move { find(session, token, opening, commands, agents) }).await;
            let _ = this.update(cx, |chat, cx| {
                if found.commands.is_some() { chat.commands = found.commands }
                if found.agents.is_some() { chat.agents = found.agents }
                if chat.asked != asked { return } // a later key asked again
                chat.picks = found.rows;
                // a / mid-message runs only if Claude takes it up, so, as in Claude Code, no row is lit: Enter still sends
                chat.pick_at = (!mid && !chat.picks.is_empty()).then_some(0);
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn move_pick(&mut self, by: isize, cx: &mut Context<Self>) {
        let n = self.picks.len() as isize;
        let at = match self.pick_at { Some(at) => (at as isize + by).rem_euclid(n), None if by > 0 => 0, None => n - 1 };
        self.pick_at = Some(at as usize);
        self.picks_scroll.scroll_to_item(at as usize);
        cx.notify();
    }

    pub(super) fn choose(&mut self, n: usize, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(token), Some(pick)) = (self.token.take(), self.picks.get(n).cloned()) else { return };
        let (text, caret) = { let c = self.composer.read(cx); (c.value().to_string(), c.cursor()) };
        let caret = caret.max(token.start).min(text.len());
        let next = format!("{}{}{}", &text[..token.start], pick.insert, &text[caret..]);
        let at = token.start + pick.insert.len();
        self.picks.clear();
        self.composer.update(cx, |c, cx| {
            c.set_value(next, window, cx);
            c.set_selected_range(at..at, cx);
        });
        cx.notify();
    }

    pub(super) fn close_picks(&mut self, cx: &mut Context<Self>) {
        self.asked += 1;
        self.picks.clear();
        self.token = None;
        cx.notify();
    }

    // The list over the box, as the web's .picks: each row its name in mono, then what it does.
    pub(super) fn picks_list(&self, cx: &mut Context<Self>) -> Option<Div> {
        if self.picks.is_empty() { return None }
        let c = colours(cx);
        let mono = cx.theme().mono_font_family.clone();
        let mut list = div().id("picks").v_flex().max_h(px(280.)).overflow_y_scroll().track_scroll(&self.picks_scroll).p(px(4.))
            .rounded(px(10.)).border_1().border_color(c.pop_edge).bg(c.pop).shadow(pop_shadow(c.dark));
        for (n, pick) in self.picks.iter().enumerate() {
            list = list.child(
                div().id(("pick", n)).h_flex().flex_none().w_full().min_h(px(30.)).px(px(8.)).py(px(4.)).gap(px(10.)).rounded(px(6.)).cursor_pointer()
                    .when(self.pick_at == Some(n), |r| r.bg(c.pop_on))
                    .child(div().flex_none().font_family(mono.clone()).text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(c.text_1).child(pick.label.clone()))
                    .when(!pick.hint.is_empty(), |r| r.child(div().min_w_0().truncate().text_xs().text_color(c.text_3).child(pick.hint.clone())))
                    .on_hover(cx.listener(move |chat, on: &bool, _, cx| if *on && chat.pick_at != Some(n) { chat.pick_at = Some(n); cx.notify() }))
                    // a press, not a click, so the box keeps the cursor
                    .on_mouse_down(MouseButton::Left, cx.listener(move |chat, _, window, cx| {
                        chat.choose(n, window, cx);
                        cx.stop_propagation();
                    })),
            );
        }
        Some(div().absolute().left_0().right_0().bottom(relative(1.)).pb(px(6.)).child(list))
    }

    // --- what the box holds -----------------------------------------------------------------------------------------

    fn boxed(&self, cx: &App) -> Boxed {
        let c = self.composer.read(cx);
        Boxed { text: c.value().to_string(), attached: self.attached.clone(), caret: c.cursor() }
    }

    fn put_in_box(&mut self, put: Boxed, window: &mut Window, cx: &mut Context<Self>) {
        self.attached = put.attached;
        self.close_picks(cx);
        let at = put.caret.min(put.text.len());
        self.composer.update(cx, |c, cx| {
            c.set_value(put.text, window, cx);
            c.set_selected_range(at..at, cx);
            c.focus(window, cx);
        });
    }

    fn keep_stash(&self, cx: &mut Context<Self>) {
        let Some(session) = self.session.clone() else { return };
        let text = self.stash.as_ref().map(|s| s.text.clone()).unwrap_or_default();
        cx.background_spawn(async move { keep(STASHES, &session, &text) }).detach();
    }

    // Ctrl S, Claude Code's stash: what is typed goes away and the box empties, to write something else first. Ctrl S
    // on an empty box brings it back, and so does the next message entered, unless Settings says to wait for Ctrl S;
    // Ctrl S over both swaps them, so neither is lost.
    pub(super) fn swap_stash(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let now = self.boxed(cx);
        let now = (!now.text.trim().is_empty() || !now.attached.is_empty()).then_some(now);
        if now.is_none() && self.stash.is_none() {
            let how = if self.stash_back { "Ctrl S puts away what is typed, until the next message is sent." } else { "Ctrl S puts away what is typed, until Ctrl S again." };
            return toast::say(how, cx);
        }
        let back = std::mem::replace(&mut self.stash, now);
        self.put_in_box(back.unwrap_or_default(), window, cx);
        self.keep_stash(cx);
        cx.notify();
    }

    // A message entered leaves the box: the stash comes back into it at once, as Claude Code's does, unless Settings
    // says to wait for Ctrl S, or the message is a slash command, which Claude Code's skips. Otherwise the box empties.
    fn next_box(&mut self, typed: &str, window: &mut Window, cx: &mut Context<Self>) {
        let back = if self.stash_back && !typed.starts_with('/') { self.stash.take() } else { None };
        match back {
            Some(back) => {
                self.put_in_box(back, window, cx);
                self.keep_stash(cx);
                toast::say("Stash restored", cx);
            }
            None => {
                self.attached.clear();
                self.close_picks(cx);
                self.composer.update(cx, |c, cx| c.set_value("", window, cx));
            }
        }
    }

    // What desk refused goes back in the box; what was typed there since goes to the stash, or after it, so nothing is
    // lost.
    pub(super) fn put_back(&mut self, mut failed: Boxed, window: &mut Window, cx: &mut Context<Self>) {
        let now = self.boxed(cx);
        if !now.text.trim().is_empty() || !now.attached.is_empty() {
            if self.stash.is_none() {
                self.stash = Some(now);
                self.keep_stash(cx);
            } else {
                failed.text = [failed.text, now.text].into_iter().filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n");
                failed.attached.extend(now.attached);
            }
        }
        failed.caret = failed.text.len();
        self.put_in_box(failed, window, cx);
    }

    // Enter, or Ctrl Enter, Claude Code's send now while Claude works: what is typed and what waits go in at once.
    pub(super) fn submit(&mut self, now: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.session.is_none() { return }
        let typed = self.composer.read(cx).value().trim().to_string();
        if now && self.working { return self.send_now(typed, true, window, cx) }
        if typed.is_empty() && self.attached.is_empty() { return }
        let (mut text, mut first) = (typed.clone(), None);
        match self.runs_in(&typed) {
            Err(reason) => return toast::say(reason, cx),
            Ok(Some(runs)) => {
                let no_efforts = runs.model.as_ref().is_some_and(|m| m.efforts.is_empty());
                let set = self.show_runs(runs.model.map(|m| (m.value, m.name)), runs.effort, cx);
                if no_efforts { self.meta["runs"]["effort"] = json!("") }
                let r = &self.meta["runs"];
                let (name, effort) = (r["name"].as_str().unwrap_or(""), r["effort"].as_str().unwrap_or(""));
                toast::say(if effort.is_empty() { format!("Now on {name}") } else { format!("Now on {name} · {}", live::effort_name(effort)) }, cx);
                text = runs.rest;
                first = Some(Picked { set, typed: typed.clone() });
            }
            Ok(None) => {}
        }
        let sending = std::mem::take(&mut self.attached);
        self.next_box(&typed, window, cx);
        if text.is_empty() && sending.is_empty() {
            if let Some(Picked { set, .. }) = first { self.call(cx, move |session| live::pick(session, set)) }
            return;
        }
        self.say_now(text, sending, false, first, cx);
    }

    fn runs_in(&self, text: &str) -> Result<Option<Runs>, String> {
        let command = Regex::new(r"^/(model|effort)\s+(\S+)(?:\s+|$)").expect("a fixed pattern");
        let bare = |name: &str| name.to_lowercase().split_whitespace().collect::<String>();
        let (mut runs, mut unknown, mut rest) = (Runs { model: None, effort: None, rest: String::new() }, Vec::new(), text);
        while let Some(m) = command.captures(rest) {
            let (what, word) = (m[1].to_string(), m[2].to_string());
            let w = word.to_lowercase();
            rest = &rest[m[0].len()..];
            if what == "effort" {
                match EFFORTS.iter().find(|(value, label)| value.starts_with(&w) || bare(label).starts_with(&w)) {
                    Some((value, _)) => runs.effort = Some(value.to_string()),
                    None => unknown.push(format!("/effort {word}")),
                }
            } else {
                match self.models.iter().find(|m| m.value.to_lowercase().starts_with(&w) || bare(&m.name).starts_with(&w)) {
                    Some(model) => runs.model = Some(model.clone()),
                    None => unknown.push(format!("/model {word}")),
                }
            }
        }
        if rest.len() == text.len() { return Ok(None) }
        if !unknown.is_empty() {
            // one alone desk can't name, such as /effort auto, Claude Code runs as it always has
            if unknown.len() == 1 && runs.model.is_none() && runs.effort.is_none() && rest.trim().is_empty() { return Ok(None) }
            return Err(format!("desk can't set {}: a model is one the chip lists, an effort low, medium, high, xhigh or max.", unknown.join(" or ")));
        }
        runs.rest = rest.trim().to_string();
        Ok(Some(runs))
    }

    // A message to the session, drawn at once as pending; one desk refuses goes back in the box with its reason.
    // A message after /model or /effort goes once the server has the pick, which restarts the session's process; one it
    // refuses puts the whole message back, the commands with it.
    pub(super) fn say_now(&mut self, text: String, attached: Vec<Attachment>, now_: bool, first: Option<Picked>, cx: &mut Context<Self>) {
        let Some(session) = self.session.clone() else { return };
        let as_chat = self.start_as_chat && self.fresh(); // a new chat's first message, its chip on Chat
        let uuid = uuid::Uuid::new_v4().to_string();
        self.pending.push(Pending { text: text.clone(), attached: attached.clone(), mid: self.working, uuid: uuid.clone(), at: now(), lost: false });
        if !self.working { self.set_working(true, None) } // drawn at once; the server's word follows
        self.tick(cx);
        self.relayout(cx);
        cx.notify();
        let id = uuid.clone();
        cx.spawn(async move |this, cx| {
            let typed = first.as_ref().map(|p| p.typed.clone());
            let said = cx
                .background_spawn(async move {
                    if let Some(Picked { set, .. }) = first { live::pick(&session, set)?; }
                    live::send(&session, &uuid, &text, &attached, as_chat, now_)
                })
                .await;
            let _ = this.update(cx, |chat, cx| {
                match said {
                    Ok(answer) if answer["queued"].as_bool().unwrap_or(false) => {
                        toast::say("It's still working in the background: your message goes in when this turn ends.", cx)
                    }
                    Ok(_) => {}
                    Err(reason) => {
                        toast::say(reason, cx);
                        if let Some(n) = chat.pending.iter().position(|p| p.uuid == id) {
                            let p = chat.pending.remove(n);
                            chat.failed = Some(Boxed { text: typed.unwrap_or(p.text), attached: p.attached, caret: 0 });
                        }
                        chat.relayout(cx);
                    }
                }
                cx.notify()
            });
        })
        .detach();
    }

    // --- the messages that wait ---------------------------------------------------------------------------------------

    // Messages waiting for Claude's next step, or not sent, which ↑ takes back.
    pub(super) fn queued(&self) -> bool {
        self.pending.iter().any(|p| (self.working && p.mid) || p.lost)
    }

    // The messages that wait come back, joined, for the box: one Claude has read already stays in the chat, one not sent
    // comes back as it is.
    fn withdraw(&mut self, window: &mut Window, cx: &mut Context<Self>, then: impl FnOnce(&mut Self, Option<Boxed>, &mut Window, &mut Context<Self>) + 'static) {
        let Some(session) = self.session.clone() else { return };
        let waiting: Vec<(String, bool)> = self.pending.iter().filter(|p| p.mid || p.lost).map(|p| (p.uuid.clone(), p.lost)).collect();
        let asked = waiting.len();
        cx.spawn_in(window, async move |this, cx| {
            let answers = cx.background_spawn(async move {
                let mut answers = Vec::new();
                for (uuid, lost) in waiting {
                    let answer = if lost { Ok(true) } else { net::post(&format!("/api/live/{session}/withdraw"), json!({"uuid": uuid})).map(|v| v["withdrawn"].as_bool().unwrap_or(false)) };
                    let stop = answer.is_err();
                    answers.push((uuid, answer));
                    if stop { break }
                }
                answers
            })
            .await;
            let _ = this.update_in(cx, |chat, window, cx| {
                let (mut back, mut read) = (Vec::new(), 0);
                for (uuid, answer) in answers {
                    match answer {
                        Ok(true) => back.push(uuid),
                        Ok(false) => read += 1,
                        Err(reason) => toast::say(reason, cx),
                    }
                }
                if read > 0 { toast::say(if asked == 1 { "Claude has read it already.".to_string() } else { format!("Claude has read {read} of them already.") }, cx) }
                let (took, kept): (Vec<Pending>, Vec<Pending>) = std::mem::take(&mut chat.pending).into_iter().partition(|p| back.contains(&p.uuid));
                chat.pending = kept;
                chat.relayout(cx);
                let out = (!took.is_empty()).then(|| Boxed {
                    text: took.iter().map(|p| p.text.as_str()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n"),
                    attached: took.into_iter().flat_map(|p| p.attached).collect(),
                    caret: 0,
                });
                then(chat, out, window, cx);
                cx.notify();
            });
        })
        .detach();
    }

    // ↑ on the box's first line while messages wait: they come back into the box, above what is typed, to edit.
    pub(super) fn take_back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.withdraw(window, cx, |chat, back, window, cx| {
            let Some(back) = back else { return };
            let now = chat.boxed(cx);
            let caret = back.text.len();
            let text = [back.text, now.text].into_iter().filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n");
            let attached = back.attached.into_iter().chain(now.attached).collect();
            chat.put_in_box(Boxed { text, attached, caret }, window, cx);
        });
    }

    // Send now: Claude Code takes no word to hurry a message it holds, so the waiting ones are taken back and sent again
    // with what is typed, as one message, at once.
    pub(super) fn send_now(&mut self, typed: String, from_box: bool, window: &mut Window, cx: &mut Context<Self>) {
        let sending = if from_box { std::mem::take(&mut self.attached) } else { Vec::new() };
        if typed.is_empty() && sending.is_empty() && !self.queued() { return }
        if from_box { self.next_box(&typed, window, cx) }
        self.withdraw(window, cx, move |chat, back, _, cx| {
            let (mut text, mut attached) = back.map(|b| (b.text, b.attached)).unwrap_or_default();
            if !typed.is_empty() { text = [text, typed].into_iter().filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n") }
            attached.extend(sending);
            if text.is_empty() && attached.is_empty() { return }
            chat.say_now(text, attached, true, None, cx);
        });
    }

    // A message still out of the transcript well after its turn ended was never read, and never will be: lost on the
    // way, such as with desk's restart while it waited for a turn. It says so, for you to send again. One starting with
    // < shows in no transcript, so its absence says nothing.
    pub(super) fn watch_lost(&mut self, cx: &mut Context<Self>) {
        if self.working || self.pending.is_empty() || self.losing { return }
        self.losing = true;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(std::time::Duration::from_millis(LOST_AFTER)).await;
            let _ = this.update(cx, |chat, cx| {
                chat.losing = false;
                if chat.working { return }
                let at = now();
                for p in &mut chat.pending {
                    if at.saturating_sub(p.at) >= LOST_AFTER && !p.text.trim_start().starts_with('<') { p.lost = true }
                }
                chat.relayout(cx);
                cx.notify();
            });
        })
        .detach();
    }

    // Not sent · Send: the message goes again as it was.
    pub(super) fn resend(&mut self, uuid: &str, cx: &mut Context<Self>) {
        let Some(n) = self.pending.iter().position(|p| p.uuid == uuid) else { return };
        let p = self.pending.remove(n);
        self.say_now(p.text, p.attached, false, None, cx);
    }

    // The stash's chip in the composer's foot: its first line, which Ctrl S brings back.
    pub(super) fn stash_chip(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let stash = self.stash.as_ref()?;
        let muted = cx.theme().muted_foreground;
        let first = stash.text.trim().lines().next().unwrap_or("").to_string();
        let words = if first.is_empty() { format!("{} {}", stash.attached.len(), if stash.attached.len() == 1 { "file" } else { "files" }) } else { first };
        let hover = theme::text(cx).hover;
        Some(
            div().id("stashed").h_flex().flex_shrink(1.).min_w_0().max_w(px(240.)).h(px(28.)).pl(px(8.)).pr(px(6.)).gap(px(4.)).rounded(px(6.))
                .cursor_pointer().text_xs().text_color(muted).hover(move |s| s.bg(hover))
                .child(theme::glyph("archive", muted).size(px(14.)))
                .child(div().min_w_0().truncate().child(words))
                .on_click(cx.listener(|chat, _, window, cx| chat.swap_stash(window, cx)))
                .into_any_element(),
        )
    }
}

const LOST_AFTER: u64 = 8000;
