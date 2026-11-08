// An issue's page, as the web app's IssueView (issues/IssueView.tsx) draws it in the Inbox's right pane: its parents
// over its title, then in review what Approve runs, its steps, its document and its sub-issues; beside them its actions,
// Copy link, Open chat and the step (Start, Go, Approve), the one primary button, over its Properties. Under 820px,
// where Linear's Inbox has no room for the Properties column, the properties are chips under the title and the actions
// a row over it. desk pushes the page again over the sync socket whenever it changes (main.rs, Event::Page).
//
// Status and priority change from their menus here; the other properties show what they are, and change on the web's
// page until their pickers come here too.
use std::collections::HashSet;

use gpui_kit::base::StyledExt;
use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::menu::{DropdownMenu, PopupMenuItem};
use gpui_kit::component::text::TextView;
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::{json, Value};

use crate::steps::Steps;
use crate::{net, theme};

const WIDE: f32 = 820.; // the pane's width from which Properties get their column, as Linear's
const SIDE: f32 = 272.;
const GAP: f32 = 48.;
const MOST: f32 = 1040.;

// The statuses its menu offers: not Triage, which only a chat files, nor Landing, which only Approve sets.
const STATES: [&str; 6] = ["backlog", "running", "waiting", "review", "done", "dropped"];
const PRIORITIES: [&str; 5] = ["none", "urgent", "high", "medium", "low"];

pub fn state_name(state: &str) -> &'static str {
    match state {
        "triage" => "Triage",
        "backlog" => "Backlog",
        "running" => "In progress",
        "waiting" => "Waiting",
        "review" => "In review",
        "landing" => "Landing",
        "done" => "Done",
        "dropped" => "Dropped",
        _ => "",
    }
}

fn priority_name(level: &str) -> &'static str {
    match level {
        "urgent" => "Urgent",
        "high" => "High",
        "medium" => "Medium",
        "low" => "Low",
        _ => "No priority",
    }
}

// desk.css's --urgent, --prio, and --text-3 for none.
pub fn priority_icon(level: &str, cx: &App) -> Svg {
    let colour: Hsla = match level {
        "urgent" => rgb(0xff7235).into(),
        "high" | "medium" | "low" if cx.theme().mode.is_dark() => rgb(0xc6c6c9).into(),
        "high" | "medium" | "low" => rgb(0x5c5c5e).into(),
        _ => cx.theme().muted_foreground,
    };
    theme::glyph(&format!("prio-{}", if PRIORITIES.contains(&level) { level } else { "none" }), colour)
}

// Where its session stands, after its id.
fn live_word(page: &Value, state: &str) -> &'static str {
    if page["session_kind"] == "interactive" {
        "open in a terminal"
    } else if page["live"] == "working" {
        "working"
    } else if ["done", "dropped", "waiting"].contains(&state) {
        "idle"
    } else {
        "your turn"
    }
}

fn text(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

pub enum IssueEvent {
    // its chat, in the middle: Open chat, I, or a parent or sub-issue picked
    Open(String),
    // Go or Approve from the Inbox moves on as Linear does: the next row opens, and the note says what happened
    Onward { next: Option<String>, note: String },
}

pub struct IssuePage {
    pub slug: String,
    pub width: f32, // the pane's, which the Inbox sets as it lays it out
    page: Option<Value>,
    steps: Entity<Steps>,
    skip: HashSet<usize>,     // the landing steps unticked, which Approve skips
    lands_of: Vec<String>,    // the landing steps those are for: a new set starts all ticked
    pressed: Option<&'static str>, // the step pressed, "Landing…" or "Starting…", until desk answers
    painted: Option<(&'static str, String)>, // a status or priority picked, shown until desk's page says it
    trust: bool,              // starting found the folder untrusted: Trust folder takes the step's place
    notice: Option<(String, bool)>, // what desk said, and whether it went wrong
    folded: HashSet<&'static str>,
    scroll: ScrollHandle,
}

impl EventEmitter<IssueEvent> for IssuePage {}

impl IssuePage {
    pub fn new(slug: String, cx: &mut Context<Self>) -> Self {
        let steps = cx.new(|_| {
            let mut steps = Steps::new();
            steps.inline = true;
            steps
        });
        Self {
            slug,
            width: 800.,
            page: None,
            steps,
            skip: HashSet::new(),
            lands_of: Vec::new(),
            pressed: None,
            painted: None,
            trust: false,
            notice: None,
            folded: HashSet::new(),
            scroll: ScrollHandle::new(),
        }
    }

    pub fn set(&mut self, page: Value, cx: &mut Context<Self>) {
        self.steps.update(cx, |steps, cx| steps.set(&page, cx));
        let lands: Vec<String> = page["lands"]["steps"].as_array().into_iter().flatten().map(text).collect();
        if lands != self.lands_of {
            self.skip.clear();
            self.lands_of = lands;
        }
        if let Some((field, value)) = &self.painted {
            if page["issue"][*field].as_str() == Some(value.as_str()) { self.painted = None }
        }
        self.page = Some(page);
        cx.notify();
    }

    fn field(&self, page: &Value, name: &str) -> String {
        match &self.painted {
            Some((field, value)) if *field == name => value.clone(),
            _ => text(&page["issue"][name]),
        }
    }

    // A status or priority picked from its menu: shown at once, then desk's page confirms it.
    fn set_field(&mut self, field: &'static str, value: &'static str, cx: &mut Context<Self>) {
        self.painted = Some((field, value.to_string()));
        cx.notify();
        let path = format!("/issue/{}/set", self.slug);
        cx.spawn(async move |this, cx| {
            let done = cx.background_spawn(async move { net::post(&path, json!({"field": field, "value": value})) }).await;
            let _ = this.update(cx, |page, cx| {
                if let Err(error) = done {
                    page.painted = None;
                    page.notice = Some((error, true));
                }
                cx.notify();
            });
        })
        .detach();
    }

    // Start, Go, Approve or Trust folder, as the web's page posts them (useStep's act).
    fn act(&mut self, action: &'static str, cx: &mut Context<Self>) {
        match action {
            "approve" => { self.pressed = Some("Landing…"); self.painted = Some(("state", "landing".into())) }
            "go" => self.painted = Some(("state", "running".into())),
            "start" => { self.pressed = Some("Starting…"); self.painted = Some(("state", "running".into())) }
            _ => {}
        }
        self.trust = false;
        self.notice = None;
        cx.notify();
        let mut body = json!({"src": "inbox"});
        if action == "approve" && !self.skip.is_empty() {
            let mut skip: Vec<usize> = self.skip.iter().copied().collect();
            skip.sort();
            body["skip"] = json!(skip.iter().map(usize::to_string).collect::<Vec<_>>().join(","));
        }
        let path = format!("/issue/{}/{action}", self.slug);
        cx.spawn(async move |this, cx| {
            let done = cx.background_spawn(async move { net::act(&path, body) }).await;
            let _ = this.update(cx, |page, cx| {
                page.pressed = None;
                match done {
                    Ok(to) => {
                        let note = net::query(&to, "note");
                        if to.starts_with("/inbox") && note.is_some() {
                            cx.emit(IssueEvent::Onward { next: net::query(&to, "i"), note: note.unwrap_or_default() });
                        } else {
                            page.notice = net::query(&to, "msg").map(|m| (m, false));
                            page.trust = net::query(&to, "trust").as_deref() == Some("1");
                        }
                    }
                    Err(error) => {
                        page.painted = None;
                        page.notice = Some((error, true));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    // Ctrl Enter: the step, as its button says.
    pub fn press_step(&mut self, cx: &mut Context<Self>) {
        let Some(page) = &self.page else { return };
        if self.trust { return self.act("trust", cx) }
        let button = &page["step"]["button"];
        if self.pressed.is_some() || button["disabled"].as_bool() == Some(true) { return }
        if button["chat"].as_bool() == Some(true) { return self.open_chat(cx) }
        let action = match button["action"].as_str() {
            Some("start") => "start",
            Some("go") => "go",
            Some("approve") => "approve",
            _ => return,
        };
        self.act(action, cx);
    }

    // I: the issue's chat, in the middle.
    pub fn open_chat(&mut self, cx: &mut Context<Self>) {
        cx.emit(IssueEvent::Open(self.slug.clone()));
    }

    fn copy_link(&mut self, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(format!("http://{}/issue/{}", net::host(), self.slug)));
        self.notice = Some(("Link copied".into(), false));
        cx.notify();
    }

    // A round button of the actions' row, as Linear's Copy issue URL: a 28px circle, ringed, with a 14px glyph.
    fn round(&self, id: &'static str, glyph: &'static str, cx: &mut Context<Self>) -> Stateful<Div> {
        let dark = cx.theme().mode.is_dark();
        let fill: Hsla = if dark { rgb(0x1b1c1d).into() } else { rgb(0xffffff).into() };
        let ring = if dark { hsla(0., 0., 1., 0.137) } else { hsla(0., 0., 0., 0.09) };
        let ring_hover = if dark { hsla(0., 0., 1., 0.229) } else { hsla(0., 0., 0., 0.15) };
        let shadow = |ring: Hsla| {
            vec![
                BoxShadow { color: ring, offset: point(px(0.), px(0.)), blur_radius: px(0.), spread_radius: px(0.5), inset: false },
                BoxShadow { color: hsla(0., 0., 0., if dark { 0.3 } else { 0.04 }), offset: point(px(0.), px(0.5)), blur_radius: px(1.), spread_radius: px(if dark { 1. } else { 0. }), inset: false },
            ]
        };
        div()
            .id(id)
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(28.))
            .rounded_full()
            .bg(fill)
            .shadow(shadow(ring))
            .hover(move |s| s.shadow(shadow(ring_hover)))
            .cursor_pointer()
            .child(theme::glyph(glyph, cx.theme().foreground).size(px(14.)))
    }

    // The step: the one primary button.
    fn step_button(&self, page: &Value, cx: &mut Context<Self>) -> Option<Stateful<Div>> {
        let theme = cx.theme();
        let (fill, hover) = (theme.primary, theme.primary_hover);
        let white: Hsla = rgb(0xffffff).into();
        let primary = |id: &'static str, label: String| {
            div()
                .id(id)
                .h_flex()
                .flex_none()
                .h(px(28.))
                .px(px(10.))
                .rounded_full()
                .bg(fill)
                .text_size(px(12.))
                .font_medium()
                .text_color(white)
                .child(label)
        };
        let button = &page["step"]["button"];
        let session = page["issue"]["session"].is_string();
        if self.trust {
            return Some(primary("step", "Trust folder".into()).hover(move |s| s.bg(hover)).cursor_pointer().on_click(cx.listener(|p, _, _, cx| p.act("trust", cx))));
        }
        if let Some(label) = self.pressed {
            return Some(primary("step", label.into()).opacity(0.6));
        }
        if !button.is_object() { return None }
        if button["chat"].as_bool() == Some(true) {
            return session.then(|| primary("step", "Open chat".into()).hover(move |s| s.bg(hover)).cursor_pointer().on_click(cx.listener(|p, _, _, cx| p.open_chat(cx))));
        }
        let label = text(&button["label"]);
        if button["disabled"].as_bool() == Some(true) {
            return Some(primary("step", label).opacity(0.6));
        }
        Some(primary("step", label).hover(move |s| s.bg(hover)).cursor_pointer().on_click(cx.listener(|p, _, _, cx| p.press_step(cx))))
    }

    // Copy link, Open chat whenever the chat is not the step, and the step.
    fn actions(&self, page: &Value, cx: &mut Context<Self>) -> Div {
        let chat_step = page["step"]["button"]["chat"].as_bool() == Some(true);
        let session = page["issue"]["session"].is_string();
        div()
            .h_flex()
            .justify_end()
            .gap(px(6.))
            .child(self.round("copy-link", "link", cx).on_click(cx.listener(|p, _, _, cx| p.copy_link(cx))))
            .when(session && !chat_step, |row| row.child(self.round("open-chat", "chat", cx).on_click(cx.listener(|p, _, _, cx| p.open_chat(cx)))))
            .children(self.step_button(page, cx))
    }

    // The status's or priority's menu, on the row or chip that shows it.
    fn menu(&self, button: Button, field: &'static str, current: String, cx: &mut Context<Self>) -> impl IntoElement {
        let this = cx.entity().downgrade();
        button.dropdown_menu_with_anchor(Anchor::TopLeft, move |mut menu, _, _| {
            let values: &[&'static str] = if field == "state" { &STATES } else { &PRIORITIES };
            for value in values {
                let value: &'static str = value;
                let this = this.clone();
                let item = PopupMenuItem::element(move |_, cx| {
                    let icon = if field == "state" { theme::state_icon(value, cx).into_any_element() } else { priority_icon(value, cx).size(px(14.)).into_any_element() };
                    div().h_flex().gap_2().child(icon).child(if field == "state" { state_name(value) } else { priority_name(value) })
                })
                .checked(value == current)
                .on_click(move |_, _, cx| {
                    let _ = this.update(cx, |p, cx| p.set_field(field, value, cx));
                });
                menu = menu.item(item);
            }
            menu
        })
    }

    // A row of Properties: 32px, its icon and its words.
    fn prop(icon: impl IntoElement, words: impl IntoElement) -> Div {
        div().h_flex().w_full().h(px(32.)).gap_2().text_size(px(13.)).font_normal().child(icon).child(div().flex_1().min_w_0().truncate().child(words))
    }

    fn properties(&self, page: &Value, cx: &mut Context<Self>) -> Div {
        let theme = cx.theme();
        let t = theme::text(cx);
        let (muted, strong) = (theme.muted_foreground, t.strong);
        let state = self.field(page, "state");
        let priority = self.field(page, "priority");
        let issue = &page["issue"];
        let label = |words: &'static str| div().mt(px(24.)).mb(px(8.)).font_medium().text_color(muted).child(words);
        let fixed = |icon: AnyElement, words: String, set: bool| {
            Self::prop(icon, div().text_color(if set { strong } else { muted }).child(words))
        };
        let pick = |id: &'static str| Button::new(id).ghost().w_full().h(px(32.)).px(px(8.)).ml(px(-8.)).text_size(px(13.)).font_normal().text_color(strong);
        let status = pick("prop-state").child(Self::prop(theme::state_icon(&state, cx), state_name(&state)));
        let prio = pick("prop-priority").child(Self::prop(priority_icon(&priority, cx).size(px(14.)), priority_name(&priority)));
        let team = page["team"]["title"].as_str().map(str::to_string);
        let project = page["project"]["title"].as_str().map(str::to_string).or_else(|| issue["project"].as_str().map(str::to_string));
        let milestone = page["milestone"].as_str().map(str::to_string);
        let due = issue["due"].as_str().map(str::to_string);
        let folder = issue["folder"].as_str().filter(|f| !f.is_empty()).unwrap_or("~").to_string();
        let link = issue["link"].as_str().map(str::to_string);
        let landed = page["landed"].as_str().map(|l| l.replace('`', "")).filter(|l| !link.as_ref().is_some_and(|k| l.contains(k.as_str())));
        let session = issue["session"].as_str().map(|s| s.chars().take(8).collect::<String>());
        let glyph = |name: &str| theme::glyph(name, muted).size(px(14.)).into_any_element();
        div()
            .v_flex()
            .text_size(px(13.))
            .child(div().mb(px(8.)).font_medium().text_color(muted).child("Properties"))
            .child(self.menu(status, "state", state.clone(), cx))
            .child(fixed(glyph("team"), team.clone().unwrap_or_else(|| "Add to team".into()), team.is_some()))
            .child(self.menu(prio, "priority", priority.clone(), cx))
            .when(state == "waiting", |p| {
                let on = text(&issue["waiting_on"]);
                let waited = text(&issue["waited"]);
                let since = format!("since {}{}", text(&issue["waiting_since_short"]), if waited != "today" && !waited.is_empty() { format!(" · {waited}") } else { String::new() });
                p.child(label("Waiting on"))
                    .child(fixed(glyph("clock"), if on.is_empty() { "Who or what?".into() } else { on.clone() }, !on.is_empty()))
                    .child(div().h(px(32.)).flex().items_center().text_color(muted).child(since))
            })
            .child(label("Project"))
            .child(fixed(glyph("project"), project.clone().unwrap_or_else(|| "Add to project".into()), project.is_some()))
            .when(project.is_some(), |p| p.child(fixed(glyph("milestone"), milestone.clone().unwrap_or_else(|| "Add to milestone".into()), milestone.is_some())))
            .child(label("Due date"))
            .child(fixed(glyph("calendar"), due.clone().unwrap_or_else(|| "Set due date".into()), due.is_some()))
            .child(label("Works in"))
            .child(fixed(glyph("folder"), folder, true))
            .when_some(link, |p, link| p.child(label("Link")).child(Self::prop(div(), div().text_color(strong).child(link.rsplit('/').next().unwrap_or("").to_string()))))
            .when_some(landed, |p, landed| p.child(label("Landed")).child(div().py(px(6.)).text_color(strong).child(landed)))
            .when_some(session, |p, session| {
                p.child(label("Session")).child(
                    div().h_flex().h(px(32.)).gap_2().child(div().font_family("JetBrains Mono").text_size(px(12.)).text_color(strong).child(session)).child(div().text_color(muted).child(live_word(page, &state))),
                )
            })
    }

    // Under 820px, the properties as a row of chips under the title, as Linear's Inbox has them.
    fn chips(&self, page: &Value, cx: &mut Context<Self>) -> Div {
        let theme = cx.theme();
        let t = theme::text(cx);
        let (muted, fg, raised) = (theme.muted_foreground, theme.foreground, t.raised);
        let state = self.field(page, "state");
        let priority = self.field(page, "priority");
        let issue = &page["issue"];
        let chip = |icon: AnyElement, words: String, set: bool| {
            div()
                .h_flex()
                .flex_none()
                .max_w(px(260.))
                .h(px(24.))
                .gap(px(4.))
                .pl(px(6.))
                .pr(px(8.))
                .rounded_full()
                .bg(raised)
                .text_size(px(12.))
                .font_medium()
                .text_color(if set { fg } else { muted })
                .child(icon)
                .child(div().min_w_0().truncate().child(words))
        };
        let pick = |id: &'static str, icon: AnyElement, words: &'static str| {
            Button::new(id).ghost().h(px(24.)).pl(px(6.)).pr(px(8.)).rounded_full().bg(raised).text_size(px(12.)).font_medium().text_color(fg).child(div().h_flex().gap(px(4.)).text_size(px(12.)).font_medium().child(icon).child(words))
        };
        let glyph = |name: &str| theme::glyph(name, muted).size(px(14.)).into_any_element();
        let team = page["team"]["title"].as_str().map(str::to_string);
        let project = page["project"]["title"].as_str().map(str::to_string).or_else(|| issue["project"].as_str().map(str::to_string));
        let milestone = page["milestone"].as_str().map(str::to_string);
        let status = pick("chip-state", theme::state_icon(&state, cx).into_any_element(), state_name(&state));
        let prio = pick("chip-priority", priority_icon(&priority, cx).size(px(14.)).into_any_element(), if priority == "none" { "Priority" } else { priority_name(&priority) });
        let folder = issue["folder"].as_str().filter(|f| !f.is_empty()).map(str::to_string);
        div()
            .h_flex()
            .flex_wrap()
            .gap(px(6.))
            .mb(px(24.))
            .child(self.menu(status, "state", state.clone(), cx))
            .child(chip(glyph("team"), team.clone().unwrap_or_else(|| "Team".into()), team.is_some()))
            .child(self.menu(prio, "priority", priority.clone(), cx))
            .when(state == "waiting", |c| {
                let on = text(&issue["waiting_on"]);
                c.child(chip(glyph("clock"), if on.is_empty() { "Waiting on".into() } else { on.clone() }, !on.is_empty()))
            })
            .child(chip(glyph("project"), project.clone().unwrap_or_else(|| "Project".into()), project.is_some()))
            .when(project.is_some(), |c| c.child(chip(glyph("milestone"), milestone.clone().unwrap_or_else(|| "Milestone".into()), milestone.is_some())))
            .when_some(issue["due"].as_str().map(str::to_string), |c, due| c.child(chip(glyph("calendar"), due, true)))
            .child(chip(glyph("folder"), folder.clone().unwrap_or_else(|| "Folder".into()), folder.is_some()))
    }

    // What Approve runs, as the session said, each ticked: untick one to skip it.
    fn review(&self, cx: &mut Context<Self>) -> Div {
        let theme = cx.theme();
        let t = theme::text(cx);
        let muted = theme.muted_foreground;
        let accent = t.accent;
        let white: Hsla = rgb(0xffffff).into();
        let steps = &self.lands_of;
        let lands = if steps.is_empty() {
            div().text_color(muted).child("Nothing to land: Approve marks it done.")
        } else {
            div().v_flex().child(div().mb(px(4.)).font_medium().text_color(muted).child("Approve runs")).children(steps.iter().enumerate().map(|(n, step)| {
                let on = !self.skip.contains(&n);
                let tick = div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .mt(px(3.))
                    .size(px(14.))
                    .rounded(px(4.))
                    .when(on, |b| b.bg(accent).child(theme::glyph("tick-bold", white).size(px(10.))))
                    .when(!on, |b| b.border_1().border_color(muted));
                div()
                    .id(("land", n))
                    .h_flex()
                    .items_start()
                    .gap_2()
                    .min_h(px(24.))
                    .pl(px(4.))
                    .cursor_pointer()
                    .on_click(cx.listener(move |p, _, _, cx| {
                        if !p.skip.remove(&n) { p.skip.insert(n); }
                        cx.notify();
                    }))
                    .child(tick)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .mt(px(2.))
                            .font_family("JetBrains Mono")
                            .text_size(px(12.))
                            .text_color(if on { theme.foreground } else { muted })
                            .when(!on, |c| c.line_through())
                            .child(step.clone()),
                    )
            }))
        };
        div()
            .v_flex()
            .mb(px(24.))
            .px(px(16.))
            .py(px(14.))
            .rounded(px(10.))
            .border_1()
            .border_color(t.edge)
            .bg(t.raised)
            .text_size(px(13.))
            .child(div().mb(px(8.)).text_size(px(18.)).font_semibold().text_color(t.strong).child("Review"))
            .child(lands)
    }

    // A part of the page under its heading, which folds from the triangle in the gutter left of it, or a click on it.
    fn section(&self, key: &'static str, title: &'static str, extra: Option<AnyElement>, body: AnyElement, cx: &mut Context<Self>) -> Div {
        let folded = self.folded.contains(key);
        let dark = cx.theme().mode.is_dark();
        let toggle: Hsla = if dark { rgb(0x2c313b).into() } else { rgb(0xc4c8df).into() };
        let strong = theme::text(cx).strong;
        let head = div()
            .id(key)
            .relative()
            .h_flex()
            .gap_2()
            .mt(px(32.))
            .mb(px(8.))
            .text_size(px(18.))
            .line_height(px(25.))
            .font_semibold()
            .text_color(strong)
            .cursor_pointer()
            .on_click(cx.listener(move |p, _, _, cx| {
                if !p.folded.remove(key) { p.folded.insert(key); }
                cx.notify();
            }))
            .child(
                div()
                    .absolute()
                    .left(px(-24.))
                    .top(px(2.5))
                    .size(px(20.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(theme::glyph(if folded { "triangle" } else { "triangle-open" }, toggle)),
            )
            .child(title)
            .children(extra);
        div().v_flex().child(head).when(!folded, |s| s.child(body))
    }

    // Its sub-issues, open ones first, each under its parent.
    fn tree(&self, items: &Value, depth: usize, rows: &mut Vec<AnyElement>, cx: &mut Context<Self>) {
        for item in items.as_array().into_iter().flatten() {
            let slug = text(&item["slug"]);
            let theme = cx.theme();
            let hover = theme.list_hover;
            let strong = theme::text(cx).strong;
            let open = slug.clone();
            rows.push(
                div()
                    .id(SharedString::from(format!("kid-{slug}")))
                    .h_flex()
                    .h(px(36.))
                    .pl(px(8. + 10. * depth as f32))
                    .pr(px(8.))
                    .gap_2()
                    .rounded(px(6.))
                    .hover(move |s| s.bg(hover))
                    .cursor_pointer()
                    .on_click(cx.listener(move |_, _, _, cx| cx.emit(IssueEvent::Open(open.clone()))))
                    .child(theme::state_icon(item["state"].as_str().unwrap_or(""), cx))
                    .child(div().flex_1().min_w_0().truncate().text_color(strong).child(text(&item["title"])))
                    .into_any_element(),
            );
            self.tree(&item["kids"], depth + 1, rows, cx);
        }
    }

    // Its parents, the farthest first, over its title.
    fn parents(&self, page: &Value, cx: &mut Context<Self>) -> Option<Div> {
        let trail = page["trail"].as_array().filter(|t| !t.is_empty())?;
        let theme = cx.theme();
        let (muted, dim, strong) = (theme.muted_foreground, theme::text(cx).dim, theme::text(cx).strong);
        let mut line = div().h_flex().gap(px(6.)).mb(px(6.)).min_w_0().text_size(px(13.)).line_height(px(20.)).text_color(muted);
        for (n, parent) in trail.iter().enumerate() {
            let slug = text(&parent["slug"]);
            line = line
                .child(
                    div()
                        .id(("parent", n))
                        .min_w_0()
                        .truncate()
                        .cursor_pointer()
                        .hover(move |s| s.text_color(strong))
                        .on_click(cx.listener(move |_, _, _, cx| cx.emit(IssueEvent::Open(slug.clone()))))
                        .child(text(&parent["title"])),
                )
                .child(div().flex_none().text_color(dim).child("›"));
        }
        Some(line)
    }
}

impl Render for IssuePage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let t = theme::text(cx);
        let (muted, fg, strong, waiting) = (theme.muted_foreground, theme.foreground, t.strong, t.waiting);
        let Some(page) = self.page.clone() else {
            return div().size_full().flex().items_center().justify_center().text_color(muted).child("Reading the issue…");
        };
        if page.is_null() {
            return div().size_full().flex().items_center().justify_center().text_color(muted).child("That issue is gone.");
        }
        let wide = self.width >= WIDE;
        let room = self.width.min(MOST) - 48. - if wide { SIDE + GAP } else { 0. };
        self.steps.update(cx, |steps, _| steps.width = room + 12.);
        let state = self.field(&page, "state");

        let mut main = div().v_flex().flex_1().min_w_0();
        main = main
            .children(self.parents(&page, cx))
            .child(div().mb(px(16.)).text_size(px(24.)).line_height(px(31.)).font_semibold().text_color(strong).child(text(&page["issue"]["title"])))
            .when(!wide, |m| m.child(self.chips(&page, cx)));
        if state == "review" && page["reviewing"].as_bool() == Some(true) && page["lands"].is_object() {
            main = main.child(self.review(cx));
        }
        if page["plan_steps"].as_array().is_some_and(|s| !s.is_empty()) {
            let steps = div().ml(px(-12.)).child(self.steps.clone()).into_any_element();
            main = main.child(self.section("steps", "Steps", None, steps, cx));
        }
        let body = text(&page["body"]);
        if !body.is_empty() {
            main = main.child(
                div()
                    .mt(px(24.))
                    .text_size(px(15.))
                    .line_height(px(24.))
                    .text_color(fg)
                    .child(TextView::markdown(SharedString::from(format!("body-{}", self.slug)), body).selectable(true)),
            );
        }
        for (file, title) in [("plan.md", "Plan"), ("result.md", "Result")] {
            if let Some(html) = page["agent_files"][file].as_str() {
                let body = div().text_size(px(15.)).line_height(px(24.)).text_color(fg).child(TextView::html(SharedString::from(format!("{file}-{}", self.slug)), html.to_string())).into_any_element();
                main = main.child(self.section(if file == "plan.md" { "plan.md" } else { "result.md" }, title, Some(div().text_size(px(13.)).font_normal().text_color(muted).child(file).into_any_element()), body, cx));
            }
        }
        if page["kids"].as_array().is_some_and(|k| !k.is_empty()) {
            let mut rows = Vec::new();
            self.tree(&page["kids"], 0, &mut rows, cx);
            let (done, all) = (page["progress"][0].as_u64().unwrap_or(0), page["progress"][1].as_u64().unwrap_or(0));
            let pill = (all > 0).then(|| {
                div().px(px(6.)).h(px(20.)).flex().items_center().rounded_full().border_1().border_color(t.edge).text_size(px(12.)).font_normal().text_color(muted).child(format!("{done}/{all} done")).into_any_element()
            });
            main = main.child(self.section("sub-issues", "Sub-issues", pill, div().ml(px(-8.)).v_flex().children(rows).into_any_element(), cx));
        }

        let notice = self.notice.clone().map(|(words, wrong)| div().text_size(px(12.)).text_color(if wrong { waiting } else { muted }).child(words));
        let actions = self.actions(&page, cx);
        let column = if wide {
            div()
                .h_flex()
                .items_start()
                .gap(px(GAP))
                .child(main)
                .child(
                    div()
                        .v_flex()
                        .flex_none()
                        .w(px(SIDE))
                        .child(actions)
                        .child(div().h(px(24.)).flex().items_center().justify_end().children(notice))
                        .child(self.properties(&page, cx)),
                )
        } else {
            div().v_flex().gap(px(16.)).child(div().v_flex().items_end().gap(px(4.)).child(actions).children(notice)).child(main)
        };
        div().size_full().child(
            div()
                .id("issue-page")
                .size_full()
                .overflow_y_scroll()
                .track_scroll(&self.scroll)
                .child(div().flex().justify_center().child(div().w_full().max_w(px(MOST)).px(px(24.)).pt(px(32.)).pb(px(64.)).child(column))),
        )
    }
}
