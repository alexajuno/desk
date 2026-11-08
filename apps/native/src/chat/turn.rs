// Claude's turn between two replies, as the web app draws it (Dock.tsx, Steps and Working): its tool steps and thoughts
// as one fold, open from the start, a line per step that a click opens on its input and result; Claude's commands as
// a terminal shows them, a long output only its last lines; and, while the turn runs, the line saying it works.
use std::sync::LazyLock;

use gpui_kit::base::StyledExt;
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use regex::Regex;
use serde_json::Value;

use super::{elapsed, Chat};
use crate::live::{Block, Item};
use crate::theme;

// A long output's lines the chat shows, its end, where a build says its error or its result; and the fewest a fold
// hides, since a fold over fewer costs as much room as the lines.
const LAST: usize = 8;
const FOLDS: usize = 4;
// The most of a step's input or result its detail shows, as the web app's box scrolls past 240px.
const DETAIL: usize = 40;

static PUT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-X\s*PUT\b|--request\s+PUT\b").unwrap());
static SECTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"/api/issues/[^/\\"'\s]+/sections/(Plan|Result)\b"#).unwrap());
static STEP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"/api/issues/[^/\\"'\s]+/steps/([1-9][\d.]*)"#).unwrap());
static TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""step_title":\s*"((?:[^"\\]|\\.)*)""#).unwrap());
static EXIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^Exit code \d+(\n|$)").unwrap());
static COLOUR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;]*m").unwrap());

// What a command sent of the issue's document, once it ran and desk took it: a step's diagram and decisions, or its
// Plan. Such a step leaves the fold and shows as what it sent.
pub fn sent(tool: &Item, result: Option<&Item>) -> Option<String> {
    let result = result?;
    if result.error || result.text.contains("\"detail\"") || !PUT.is_match(&tool.input) { return None }
    if let Some(m) = STEP.captures(&tool.input) {
        let place = m[1].trim_end_matches('.').to_string();
        let title = TITLE.captures(&result.text).and_then(|t| serde_json::from_str::<String>(&format!("\"{}\"", &t[1])).ok());
        return Some(match title { Some(title) => format!("Step {place} · {title}"), None => format!("Step {place}") });
    }
    SECTION.captures(&tool.input).map(|m| format!("Sent the {}", &m[1]))
}

// What a fold did, in a few words: "Read 3 files, ran 2 commands".
fn summed(names: &[&str]) -> String {
    let order = ["think", "read", "search", "edit", "ran", "web", "agent", "skill", "ask", "tool"];
    let mut count = [0usize; 10];
    for name in names {
        let word = match *name {
            "Read" => "read",
            "Edit" | "Write" | "NotebookEdit" => "edit",
            "Bash" => "ran",
            "Grep" | "Glob" => "search",
            "WebSearch" | "WebFetch" => "web",
            "Agent" | "Task" => "agent",
            "Thinking" => "think",
            "Skill" => "skill",
            "AskUserQuestion" => "ask",
            _ => "tool",
        };
        count[order.iter().position(|w| *w == word).unwrap()] += 1;
    }
    let says = |n: usize, one: &str, many: &str| if n == 1 { one.to_string() } else { many.replace('#', &n.to_string()) };
    let words = [
        ("thought", "thought"), ("read a file", "read # files"), ("searched", "searched # times"), ("edited a file", "edited # files"),
        ("ran a command", "ran # commands"), ("looked on the web", "looked on the web # times"), ("ran an agent", "ran # agents"),
        ("used a skill", "used # skills"), ("asked you", "asked you # times"), ("used a tool", "used # tools"),
    ];
    let text = count.iter().zip(words).filter(|(n, _)| **n > 0).map(|(n, (one, many))| says(*n, one, many)).collect::<Vec<_>>().join(", ");
    let mut chars = text.chars();
    chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
}

fn cut(text: &str, lines: usize) -> String {
    let mut shown: Vec<&str> = text.lines().take(lines).collect();
    if text.lines().count() > lines { shown.push("…") }
    shown.join("\n")
}

impl Chat {
    // A fold of steps: its head, which opens and closes it, then its steps, the ones streaming now last.
    pub(super) fn fold(&self, list: &[usize], live: bool, this: &WeakEntity<Self>, cx: &App) -> AnyElement {
        let theme = cx.theme();
        let text = theme::text(cx);
        let items: Vec<&Item> = list.iter().map(|&n| &self.items[n]).collect();
        let running: Vec<Block> = if live { self.live_steps() } else { Vec::new() };
        let key = items.first().map(|i| i.key.clone()).unwrap_or_else(|| "live".into());
        let open = !self.closed.contains(&key);
        let names: Vec<&str> = items.iter().map(|i| if i.kind == "thinking" { "Thinking" } else { i.name.as_str() })
            .chain(running.iter().map(|b| if b.kind == "thinking" { "Thinking" } else { b.name.as_str() }))
            .collect();
        let failed = items.iter().any(|i| i.kind == "tool" && self.results.get(&i.id).is_some_and(|r| r.error));
        let summary = summed(&names);
        let toggle = {
            let this = this.clone();
            let key = key.clone();
            move |_: &ClickEvent, _: &mut Window, cx: &mut App| {
                let _ = this.update(cx, |chat, cx| chat.toggle(|c| &mut c.closed, key.clone(), cx));
            }
        };
        let head = div()
            .id(SharedString::from(format!("fold-{key}")))
            .h_flex()
            .gap(px(6.))
            .min_h(px(26.))
            .pl(px(2.))
            .pr_2()
            .py(px(3.))
            .rounded(px(6.))
            .text_color(theme.muted_foreground)
            .hover(|s| s.bg(text.hover).text_color(theme.foreground))
            .cursor_pointer()
            .on_click(toggle)
            .child(theme::glyph(if open { "caret-open" } else { "caret" }, theme.muted_foreground).size(px(10.)))
            .child(if summary.is_empty() { "Working".to_string() } else { summary })
            .when(failed, |h| h.child(div().text_color(text.waiting).child("a step failed")));
        let mut body = div().v_flex().gap(px(1.)).mt_1().ml(px(7.)).pl(px(10.)).border_l_1().border_color(theme.border);
        // Claude's commands draw as a terminal shows them, one block for each run of them.
        let mut commands: Vec<&Item> = Vec::new();
        let flush = |body: Div, commands: &mut Vec<&Item>| {
            if commands.is_empty() { return body }
            let block = self.commands(commands, this, cx);
            commands.clear();
            body.child(block)
        };
        for item in &items {
            if item.kind == "tool" && item.name == "Bash" {
                commands.push(item);
                continue;
            }
            body = flush(body, &mut commands);
            body = body.child(self.step(item, this, cx));
        }
        body = flush(body, &mut commands);
        for b in &running {
            body = body.child(Self::line(if b.kind == "thinking" { "Thinking" } else { &b.name }, "", text.dim, cx));
        }
        let now = running.last().map(|b| if b.kind == "thinking" { "Thinking".to_string() } else { b.name.clone() });
        div()
            .v_flex()
            .py_1()
            .text_size(px(13.))
            .child(head)
            .when(open, |f| f.child(body))
            .when(!open && live, |f| f.when_some(now, |f, now| f.child(div().ml(px(20.)).text_xs().text_color(text.dim).truncate().child(now))))
            .into_any_element()
    }

    // A step's line: its tool's name, dim while it runs and orange once it failed, then what it did.
    fn line(name: &str, what: &str, name_colour: Hsla, cx: &App) -> Div {
        let theme = cx.theme();
        div()
            .h_flex()
            .h(px(24.))
            .px(px(6.))
            .gap_2()
            .rounded(px(6.))
            .text_xs()
            .text_color(theme.muted_foreground)
            .child(div().flex_none().font_medium().text_color(name_colour).child(name.to_string()))
            .child(div().min_w_0().truncate().child(what.to_string()))
    }

    // A step that is not a command: its line, which a click opens on its input and its result; a thought shows its
    // first line, and the whole of it on a click.
    fn step(&self, item: &Item, this: &WeakEntity<Self>, cx: &App) -> AnyElement {
        let theme = cx.theme();
        let text = theme::text(cx);
        let open = self.opened.contains(&item.key);
        let result = self.results.get(&item.id);
        let thought = item.kind == "thinking";
        let (name, what) = if thought { ("Thought", item.text.trim().lines().next().unwrap_or("")) } else { (item.name.as_str(), item.summary.as_str()) };
        let colour = if result.is_some_and(|r| r.error) { text.waiting } else if !thought && result.is_none() && self.working { text.dim } else { theme.foreground };
        let line = Self::line(name, what, colour, cx);
        let key = item.key.clone();
        let this = this.clone();
        let pre = |body: String, colour: Hsla| {
            div()
                .ml(px(6.))
                .mt(px(2.))
                .mb(px(6.))
                .px(px(10.))
                .py_2()
                .rounded(px(6.))
                .bg(text.raised)
                .font_family(theme.mono_font_family.clone())
                .text_size(px(11.5))
                .line_height(relative(1.5))
                .text_color(colour)
                .child(body)
        };
        div()
            .v_flex()
            .child(
                line.id(SharedString::from(format!("step-{key}")))
                    .cursor_pointer()
                    .hover(|s| s.bg(text.hover))
                    .on_click(move |_, _, cx| {
                        let _ = this.update(cx, |chat, cx| chat.toggle(|c| &mut c.opened, key.clone(), cx));
                    }),
            )
            .when(open && thought, |s| {
                s.child(div().px(px(6.)).mt(px(2.)).mb_1().text_xs().line_height(relative(1.5)).text_color(theme.muted_foreground).child(item.text.clone()))
            })
            .when(open && !thought, |s| {
                s.child(pre(cut(&item.input, DETAIL), theme.foreground)).when_some(result, |s, r| {
                    s.child(pre(if r.text.is_empty() { "(no output)".into() } else { cut(&r.text, DETAIL) }, theme.muted_foreground))
                })
            })
            .into_any_element()
    }

    // A run of commands as a terminal shows them: what Claude said each does, the command after its prompt, then what it
    // printed, a long output only its last lines under how many came before, which a click opens whole. Claude Code
    // gives a command's output only once it ends, so one running shows its seconds.
    fn commands(&self, list: &[&Item], this: &WeakEntity<Self>, cx: &App) -> AnyElement {
        let theme = cx.theme();
        let text = theme::text(cx);
        let mut block = div()
            .v_flex()
            .gap(px(14.))
            .my_1()
            .px(px(6.))
            .py(px(2.))
            .font_family(theme.mono_font_family.clone())
            .text_size(px(12.5))
            .line_height(px(19.))
            .text_color(theme.muted_foreground);
        for item in list {
            let result = self.results.get(&item.id);
            let command = if item.command.is_empty() { item.summary.clone() } else { item.command.clone() };
            let said: String = command.chars().take(120).collect::<String>() + if command.chars().count() > 120 { "…" } else { "" };
            let what = if item.summary != said { item.summary.clone() } else { String::new() };
            let whole = self.wholes.get(&item.id);
            let out = COLOUR.replace_all(whole.or(result.map(|r| &r.text)).map_or("", |s| s.as_str()), "").trim_end().to_string();
            let exit = if result.is_some_and(|r| r.error) {
                EXIT.find(&out).map_or(out.clone(), |m| m.as_str().to_string())
            } else {
                String::new()
            };
            let lines: Vec<&str> = if out.len() > exit.len() { out[exit.len()..].split('\n').collect() } else { Vec::new() };
            let before = if whole.is_none() { result.map_or(0, |r| r.more as usize) } else { 0 };
            let folds = before > 0 || lines.len() >= LAST + FOLDS;
            let open = self.opened.contains(&item.key);
            let shown: &[&str] = if folds && !open { &lines[lines.len().saturating_sub(LAST)..] } else { &lines };
            let hidden = lines.len() - shown.len() + before;
            let busy = result.is_none() && self.working;
            let more = {
                let this = this.clone();
                let key = item.key.clone();
                let id = item.id.clone();
                let fetch = before > 0 && result.is_some();
                move |_: &ClickEvent, _: &mut Window, cx: &mut App| {
                    let _ = this.update(cx, |chat, cx| chat.whole(key.clone(), id.clone(), fetch, cx));
                }
            };
            let fold_text = if hidden > 0 { format!("… {hidden} more line{}", if hidden == 1 { "" } else { "s" }) } else { format!("… only the last {LAST} lines") };
            block = block.child(
                div()
                    .v_flex()
                    .when(!what.is_empty(), |c| c.child(div().text_color(text.dim).child(format!("# {what}"))))
                    .child(div().text_color(text.strong).child(
                        StyledText::new(format!("$ {command}")).with_highlights([(0..2, HighlightStyle { color: Some(text.dim), ..Default::default() })]),
                    ))
                    .when(!exit.is_empty(), |c| c.child(div().text_color(text.waiting).child(exit.trim_end().to_string())))
                    .when(folds, |c| {
                        c.child(
                            div()
                                .id(SharedString::from(format!("more-{}", item.key)))
                                .text_color(text.dim)
                                .cursor_pointer()
                                .hover(|s| s.text_color(theme.foreground))
                                .on_click(more)
                                .child(fold_text),
                        )
                    })
                    .when(!shown.is_empty(), |c| c.child(shown.join("\n")))
                    .when(busy, |c| c.child(div().text_color(text.dim).child(format!("running{}", if item.at > 0 { format!(" · {}", elapsed(item.at)) } else { String::new() })))),
            );
        }
        block.into_any_element()
    }

    // A command's output opened whole, fetched the first time when the chat holds only its end; or closed again.
    fn whole(&mut self, key: String, id: String, fetch: bool, cx: &mut Context<Self>) {
        if self.opened.contains(&key) || !fetch || self.wholes.contains_key(&id) {
            return self.toggle(|c| &mut c.opened, key, cx);
        }
        let Some(session) = self.session.clone() else { return };
        cx.spawn(async move |this, cx| {
            let tool = id.clone();
            let got = cx.background_spawn(async move { crate::live::result(&session, &tool) }).await;
            let _ = this.update(cx, |chat, cx| match got {
                Ok(text) => {
                    chat.wholes.insert(id, text);
                    chat.toggle(|c| &mut c.opened, key, cx);
                }
                Err(error) => {
                    chat.error = Some(error);
                    cx.notify();
                }
            });
        })
        .detach();
    }

    // The line saying the turn works, and for how long, or what holds it up, with the key that stops it.
    pub(super) fn working_line(&self, cx: &App) -> AnyElement {
        let theme = cx.theme();
        let text = theme::text(cx);
        let says = held(&self.status).unwrap_or_else(|| {
            let ran = super::now().saturating_sub(self.since);
            if self.since > 0 && ran >= 1000 { format!("Working · {}", elapsed(self.since)) } else { "Working".into() }
        });
        div()
            .h_flex()
            .py_2()
            .gap_2()
            .text_size(px(13.))
            .text_color(theme.muted_foreground)
            .child(
                div().flex_none().size(px(9.)).rounded_full().bg(text.accent).with_animation(
                    "spark",
                    Animation::new(std::time::Duration::from_secs(2)).repeat(),
                    |dot, t| dot.opacity(0.45 + 0.55 * (1. - (t * std::f32::consts::TAU).cos()) / 2.),
                ),
            )
            .child(says)
            .child(div().ml_auto().text_size(px(11.)).text_color(text.dim).child("Ctrl C to stop"))
            .into_any_element()
    }
}

// What holds the turn up, in the working line's words.
fn held(status: &Value) -> Option<String> {
    let limits = |w: &str| match w {
        "five_hour" => "5-hour limit",
        "seven_day" | "seven_day_overage_included" => "Weekly limit",
        "seven_day_opus" => "Weekly Opus limit",
        "seven_day_sonnet" => "Weekly Sonnet limit",
        "overage" => "Extra usage limit",
        _ => "Usage limit",
    };
    match status["kind"].as_str()? {
        "compacting" => Some("Compacting the conversation".into()),
        "limit" => Some(format!("{} reached", limits(status["window"].as_str().unwrap_or("")))),
        _ => {
            let wait = (status["until"].as_u64().unwrap_or(0) as i64 - super::now() as i64 + 999) / 1000;
            let error = status["error"].as_str().unwrap_or("").replace('_', " ");
            let (attempt, of) = (status["attempt"].as_u64().unwrap_or(0), status["of"].as_u64().unwrap_or(0));
            Some(format!("{} · {error} · attempt {attempt} of {of}", if wait > 0 { format!("Retrying in {wait}s") } else { "Retrying".into() }))
        }
    }
}
