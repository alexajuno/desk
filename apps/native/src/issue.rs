// An issue's page, as the web app's IssueView (issues/IssueView.tsx) draws it in the Inbox's right pane: its parents
// over its title, then in review what Approve runs, its steps, its document and its sub-issues; beside them its actions,
// Copy link, Open chat and the step (Start, Go, Approve), the one primary button, over its Properties. Under 820px,
// where Linear's Inbox has no room for the Properties column, the properties are chips under the title and the actions
// a row over it. desk pushes the page again over the sync socket whenever it changes (main.rs, Event::Page).
//
// Each property changes where it is shown, from its menu (picker.rs), and so do the title, a box that saves on Enter
// or as you leave it, and the document, which a click turns into its Markdown to type in, saved a second after you stop
// and as you leave it, with the document it started from, so that a section it left as it was keeps what a session
// wrote there meanwhile (the server's issues.ts, merged).
use std::collections::HashSet;
use std::time::Duration;

use gpui_kit::base::StyledExt;
use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::input::{Escape, InputEvent, Textarea, TextareaState};
use gpui_kit::component::menu::{DropdownMenu, PopupMenuItem};
use gpui_kit::component::text::TextView;
use gpui_kit::component::{ActiveTheme, Sizable, Size as InputSize};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::{json, Value};

use crate::filters::{colours, Anchors};
use crate::picker::{DatePick, Menu, Pick, Picker, PickerEvent, Source};
use crate::steps::Steps;
use crate::{net, picker, theme};

const WIDE: f32 = 820.; // the pane's width from which Properties get their column, as Linear's
const SIDE: f32 = 272.;
const GAP: f32 = 48.;
const MOST: f32 = 1040.;

// The statuses its menu offers: not Triage, which only a chat files, nor Landing, which only Approve sets.
pub(crate) const STATES: [&str; 6] = ["backlog", "running", "waiting", "review", "done", "dropped"];
pub(crate) const PRIORITIES: [&str; 5] = ["none", "urgent", "high", "medium", "low"];

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

pub(crate) fn priority_name(level: &str) -> &'static str {
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

// A menu's choices, from desk, on a thread of its own: its teams, its open projects with the issue's team's first and
// the one it is in, or its project's milestones in their order; each with None first (issues/menus.tsx).
pub(crate) fn choices(field: &'static str, team: Option<String>, project: Option<String>, milestone: Option<String>) -> Result<Menu, String> {
    let none = |label: &str, current: bool| Pick { icon: "none", label: label.into(), value: String::new(), current };
    let rows = |v: &Value| v.as_array().cloned().unwrap_or_default();
    let menu = |picks: Vec<Pick>, placeholder: &'static str, empty: &'static str, width: f32| Menu {
        source: Source::Fixed(picks), placeholder, empty, width, takes_typed: false, start: String::new(),
    };
    match field {
        "team" => {
            let mut picks = vec![none("No team", team.is_none())];
            for t in rows(&net::get("/api/teams")?) {
                picks.push(Pick { icon: "team", label: text(&t["title"]), current: team.as_deref() == t["slug"].as_str(), value: text(&t["slug"]) });
            }
            Ok(menu(picks, "Set team…", "No team matches", 340.))
        }
        "project" => {
            let mut open: Vec<Value> = rows(&net::get("/api/projects")?).into_iter()
                .filter(|p| !matches!(p["status"].as_str(), Some("completed" | "canceled")) || p["slug"].as_str() == project.as_deref())
                .collect();
            open.sort_by_key(|p| (p["team"].as_str() != team.as_deref(), text(&p["created"])));
            let mut picks = vec![none("No project", project.is_none())];
            for p in open {
                picks.push(Pick { icon: "project", label: text(&p["title"]), current: project.as_deref() == p["slug"].as_str(), value: text(&p["slug"]) });
            }
            Ok(menu(picks, "Set project…", "No project matches", 340.))
        }
        _ => {
            let Some(project) = project else { return Ok(menu(Vec::new(), "Set milestone…", "Put the issue in a project first", 264.)) };
            let mine = rows(&net::get(&format!("/api/projects/{project}"))?["milestones"]);
            if mine.is_empty() { return Ok(menu(Vec::new(), "Set milestone…", "This project has no milestones", 264.)) }
            let mut picks = vec![none("No milestone", milestone.is_none())];
            for m in mine {
                picks.push(Pick { icon: "milestone", label: text(&m["title"]), current: milestone.as_deref() == m["id"].as_str(), value: text(&m["id"]) });
            }
            Ok(menu(picks, "Set milestone…", "No milestone matches", 264.))
        }
    }
}

// Set parent…: the open issues desk offers to sit under, without `exclude` and its own sub-issues, No parent first.
pub(crate) fn parents(exclude: &str, current: &str) -> Result<Menu, String> {
    let found = net::get(&format!("/api/parents?exclude={}", picker::encode(exclude)))?;
    let mut picks = vec![Pick { icon: "none", label: "No parent".into(), value: String::new(), current: current.is_empty() }];
    for i in found.as_array().into_iter().flatten() {
        let value = text(&i["slug"]);
        picks.push(Pick { icon: theme::state_glyph(i["state"].as_str().unwrap_or("")), label: text(&i["title"]), current: value == current, value });
    }
    Ok(Menu { source: Source::Fixed(picks), placeholder: "Set parent…", empty: "No open issue matches", width: 340., takes_typed: false, start: String::new() })
}

pub enum IssueEvent {
    // its chat, in the middle: Open chat, I, or a parent or sub-issue picked
    Open(String),
    // Go or Approve from the Inbox moves on as Linear does: the next row opens, and the note says what happened
    Onward { next: Option<String>, note: String },
    // a new title gave it a new slug, which the page follows
    Moved(String),
    // a menu closed or a box let go: the keys go back to the list
    Done,
}

// A property's menu open, under the row or chip that opened it.
struct Opened {
    anchor: String,
    view: AnyView,
    _events: Subscription,
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
    anchors: Anchors,
    opened: Option<Opened>,
    title: Entity<TextareaState>,
    title_was: String,                    // the title as desk last gave it, which Esc puts back
    doc: Option<Entity<TextareaState>>,   // the document while you type in it, as its Markdown
    saved: String,                        // the document as desk holds it, as far as this page knows: what an edit starts from
    save_soon: Option<Task<()>>,
    _boxes: Vec<Subscription>,
    trust: bool,              // starting found the folder untrusted: Trust folder takes the step's place
    notice: Option<(String, bool)>, // what desk said, and whether it went wrong
    folded: HashSet<&'static str>,
    scroll: ScrollHandle,
}

impl EventEmitter<IssueEvent> for IssuePage {}

impl IssuePage {
    pub fn new(slug: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let steps = cx.new(|_| {
            let mut steps = Steps::new();
            steps.inline = true;
            steps
        });
        let title = cx.new(|cx| TextareaState::new(window, cx).auto_grow(1, 20).submit_on_enter(true));
        let boxes = vec![cx.subscribe(&title, |page, _, event: &InputEvent, cx| match event {
            InputEvent::PressEnter { .. } => { page.save_title(cx); cx.emit(IssueEvent::Done) }
            InputEvent::Blur => page.save_title(cx),
            _ => {}
        })];
        Self {
            slug,
            width: 800.,
            page: None,
            steps,
            skip: HashSet::new(),
            lands_of: Vec::new(),
            pressed: None,
            painted: None,
            anchors: Anchors::default(),
            opened: None,
            title,
            title_was: String::new(),
            doc: None,
            saved: String::new(),
            save_soon: None,
            _boxes: boxes,
            trust: false,
            notice: None,
            folded: HashSet::new(),
            scroll: ScrollHandle::new(),
        }
    }

    pub fn set(&mut self, page: Value, window: &mut Window, cx: &mut Context<Self>) {
        self.steps.update(cx, |steps, cx| steps.set(&page, cx));
        // the title and the document as desk has them, unless you are typing in them
        let title = text(&page["issue"]["title"]);
        if title != self.title_was && !self.title.read(cx).focus_handle(cx).is_focused(window) {
            self.title.update(cx, |t, cx| t.set_value(title.clone(), window, cx));
            self.title_was = title;
        }
        if self.doc.is_none() { self.saved = text(&page["body"]) }
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

    // A field set: a status or priority picked is shown at once, the rest once desk's page says it. A new title
    // answers with the issue's new slug, which the page follows.
    fn set_field(&mut self, field: &'static str, value: String, cx: &mut Context<Self>) {
        self.post_set(json!({"field": field, "value": value.clone()}), cx);
        if field == "state" || field == "priority" { self.painted = Some((field, value)) }
        cx.notify();
    }

    fn post_set(&mut self, body: Value, cx: &mut Context<Self>) {
        let (slug, path) = (self.slug.clone(), format!("/issue/{}/set", self.slug));
        cx.spawn(async move |this, cx| {
            let done = cx.background_spawn(async move { net::post(&path, body) }).await;
            let _ = this.update(cx, |page, cx| {
                match done {
                    Ok(answer) => {
                        if let Some(to) = answer["moved"][&slug].as_str() {
                            page.slug = to.to_string();
                            cx.emit(IssueEvent::Moved(to.to_string()));
                        }
                        if let Some(n) = answer["closed"].as_array().map(Vec::len).filter(|n| *n > 0) {
                            page.notice = Some((format!("Auto-closed {n} more issue{}", if n > 1 { "s" } else { "" }), false));
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

    // The title as typed, on Enter or as you leave it: one line, its spaces as one; an empty one stays as it was.
    fn save_title(&mut self, cx: &mut Context<Self>) {
        let typed = self.title.read(cx).value().split_whitespace().collect::<Vec<_>>().join(" ");
        if typed.is_empty() || typed == self.title_was {
            if typed != self.title.read(cx).value().as_ref() { self.put_title_back(cx) }
            return;
        }
        self.title_was = typed.clone();
        self.set_field("title", typed, cx);
    }

    fn put_title_back(&mut self, cx: &mut Context<Self>) {
        let was = self.title_was.clone();
        let title = self.title.clone();
        cx.defer(move |cx| {
            if let Some(window) = cx.active_window() {
                let _ = window.update(cx, |_, window, cx| title.update(cx, |t, cx| t.set_value(was, window, cx)));
            }
        });
    }

    // A click on the document: its Markdown, to type in where it is shown.
    fn edit_doc(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.doc.is_some() { return }
        let body = self.page.as_ref().map(|p| text(&p["body"])).unwrap_or_default();
        self.saved = body.clone();
        let doc = cx.new(|cx| TextareaState::new(window, cx).auto_grow(3, 100_000).placeholder("Add description…").default_value(body));
        doc.update(cx, |d, cx| d.focus(window, cx));
        self._boxes.truncate(1);
        self._boxes.push(cx.subscribe(&doc, |page, _, event: &InputEvent, cx| match event {
            InputEvent::Change => {
                page.save_soon = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_millis(1000)).await;
                    let _ = this.update(cx, |page, cx| page.save_doc(cx));
                }));
            }
            InputEvent::Blur => page.leave_doc(cx),
            _ => {}
        }));
        self.doc = Some(doc);
        cx.notify();
    }

    // The document as typed, when it changed, with the one it was edited from.
    fn save_doc(&mut self, cx: &mut Context<Self>) {
        self.save_soon = None;
        let Some(doc) = &self.doc else { return };
        let typed = doc.read(cx).value().replace("\r\n", "\n");
        if typed == self.saved { return }
        let base = std::mem::replace(&mut self.saved, typed.clone());
        if let Some(page) = &mut self.page { page["body"] = json!(typed) }
        self.post_set(json!({"field": "body", "value": typed, "base": base}), cx);
    }

    // Leaving the document, by Esc or a click elsewhere: saved, and drawn again.
    fn leave_doc(&mut self, cx: &mut Context<Self>) {
        self.save_doc(cx);
        self.doc = None;
        self._boxes.truncate(1);
        cx.notify();
    }

    // A property's menu, under the row or chip named; the same one again closes it.
    fn open_menu(&mut self, field: &'static str, anchor: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.opened.as_ref().is_some_and(|o| o.anchor == anchor) {
            return self.close_menu(cx);
        }
        let Some(page) = self.page.clone() else { return };
        let bounds = self.anchors.get(anchor).unwrap_or_default();
        let issue = &page["issue"];
        let anchor = anchor.to_string();
        let now = |name: &str| issue[name].as_str().filter(|v| !v.is_empty()).map(str::to_string);
        match field {
            "due" => {
                let date = cx.new(|cx| DatePick::new(issue["due"].as_str(), bounds, window, cx));
                let events = cx.subscribe(&date, move |page, _, event: &PickerEvent, cx| page.picked("due", event, cx));
                self.opened = Some(Opened { anchor, view: date.into(), _events: events });
            }
            "waiting_on" | "folder" => {
                let menu = if field == "folder" {
                    Menu { source: Source::Folders(now("folder").unwrap_or_default()), placeholder: "Search repos, or type ~/path…", empty: "No folder matches", width: 360., takes_typed: true, start: String::new() }
                } else {
                    Menu { source: Source::Fixed(Vec::new()), placeholder: "Waiting on whom, for what…", empty: "Enter saves it, such as QA on #570", width: 360., takes_typed: true, start: now("waiting_on").unwrap_or_default() }
                };
                self.show_menu(field, anchor, menu, bounds, window, cx);
            }
            _ => {
                // the choices come from desk: its teams, its open projects (the issue's team's first), or the project's milestones
                let (team, project, milestone) = (now("team"), now("project"), now("milestone"));
                cx.spawn_in(window, async move |this, cx| {
                    let picks = cx.background_spawn(async move { choices(field, team, project, milestone) }).await;
                    let _ = this.update_in(cx, |page, window, cx| match picks {
                        Ok(menu) => page.show_menu(field, anchor, menu, bounds, window, cx),
                        Err(error) => { page.notice = Some((error, true)); cx.notify() }
                    });
                })
                .detach();
            }
        }
        cx.notify();
    }

    fn show_menu(&mut self, field: &'static str, anchor: String, menu: Menu, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let picker = cx.new(|cx| Picker::new(menu, bounds, window, cx));
        let events = cx.subscribe(&picker, move |page, _, event: &PickerEvent, cx| page.picked(field, event, cx));
        self.opened = Some(Opened { anchor, view: picker.into(), _events: events });
        cx.notify();
    }

    fn picked(&mut self, field: &'static str, event: &PickerEvent, cx: &mut Context<Self>) {
        let value = match event {
            PickerEvent::Picked(value) | PickerEvent::Typed(value) => value.clone(),
            PickerEvent::Closed => return self.close_menu(cx),
        };
        self.close_menu(cx);
        if field == "folder" {
            if value.is_empty() { return }
            let path = format!("/issue/{}/folder", self.slug);
            cx.spawn(async move |this, cx| {
                let done = cx.background_spawn(async move { net::act(&path, json!({"folder": value})) }).await;
                if let Err(error) = done {
                    let _ = this.update(cx, |page, cx| { page.notice = Some((error, true)); cx.notify() });
                }
            })
            .detach();
        } else {
            self.set_field(field, value, cx);
        }
    }

    fn close_menu(&mut self, cx: &mut Context<Self>) {
        if self.opened.take().is_some() { cx.emit(IssueEvent::Done) }
        cx.notify();
    }

    // A row of Properties, or a chip, that opens its menu: ghost until the mouse is on it.
    fn opener(&self, id: &'static str, field: &'static str, cx: &mut Context<Self>) -> Stateful<Div> {
        let hover = colours(cx).ghost_hover;
        let on = self.opened.as_ref().is_some_and(|o| o.anchor == id);
        div()
            .id(id)
            .relative()
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .when(on, |d| d.bg(hover))
            .child(self.anchors.probe(id))
            .on_click(cx.listener(move |page, _, window, cx| page.open_menu(field, id, window, cx)))
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
                    let _ = this.update(cx, |p, cx| p.set_field(field, value.to_string(), cx));
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
        let row = |page: &Self, id: &'static str, field: &'static str, icon: AnyElement, words: String, set: bool, cx: &mut Context<Self>| {
            page.opener(id, field, cx).h(px(32.)).px(px(8.)).ml(px(-8.)).rounded(px(6.)).child(fixed(icon, words, set))
        };
        let pick = |id: &'static str| Button::new(id).ghost().w_full().h(px(32.)).px(px(8.)).ml(px(-8.)).text_size(px(13.)).font_normal().text_color(strong);
        let status = pick("prop-state").child(Self::prop(theme::state_icon(&state, cx), state_name(&state)));
        let prio = pick("prop-priority").child(Self::prop(priority_icon(&priority, cx).size(px(14.)), priority_name(&priority)));
        let team = page["team"]["title"].as_str().map(str::to_string);
        let project = page["project"]["title"].as_str().map(str::to_string).or_else(|| issue["project"].as_str().map(str::to_string));
        let milestone = page["milestone"].as_str().map(str::to_string);
        let due = issue["due"].as_str().filter(|d| !d.is_empty()).map(str::to_string);
        let folder = issue["folder"].as_str().filter(|f| !f.is_empty()).unwrap_or("~").to_string();
        let late: Hsla = if cx.theme().mode.is_dark() { rgb(0xff6364).into() } else { rgb(0xe2253b).into() }; // --late
        let closed = state == "done" || state == "dropped";
        let left = due.as_deref().and_then(picker::days_left);
        let due_colour = match left { Some(d) if !closed && d <= 0 => late, Some(d) if !closed && d <= 7 => t.waiting, _ => muted };
        let due_words = due.as_deref().and_then(picker::day_label);
        let link = issue["link"].as_str().map(str::to_string);
        let landed = page["landed"].as_str().map(|l| l.replace('`', "")).filter(|l| !link.as_ref().is_some_and(|k| l.contains(k.as_str())));
        let session = issue["session"].as_str().map(|s| s.chars().take(8).collect::<String>());
        let glyph = |name: &str| theme::glyph(name, muted).size(px(14.)).into_any_element();
        div()
            .v_flex()
            .text_size(px(13.))
            .child(div().mb(px(8.)).font_medium().text_color(muted).child("Properties"))
            .child(self.menu(status, "state", state.clone(), cx))
            .child(row(self, "prop-team", "team", glyph("team"), team.clone().unwrap_or_else(|| "Add to team".into()), team.is_some(), cx))
            .child(self.menu(prio, "priority", priority.clone(), cx))
            .when(state == "waiting", |p| {
                let on = text(&issue["waiting_on"]);
                let waited = text(&issue["waited"]);
                let since = format!("since {}{}", text(&issue["waiting_since_short"]), if waited != "today" && !waited.is_empty() { format!(" · {waited}") } else { String::new() });
                p.child(label("Waiting on"))
                    .child(row(self, "prop-waiting", "waiting_on", glyph("clock"), if on.is_empty() { "Who or what?".into() } else { on.clone() }, !on.is_empty(), cx))
                    .child(div().h(px(32.)).flex().items_center().text_color(muted).child(since))
            })
            .child(label("Project"))
            .child(row(self, "prop-project", "project", glyph("project"), project.clone().unwrap_or_else(|| "Add to project".into()), project.is_some(), cx))
            .when(project.is_some(), |p| p.child(row(self, "prop-milestone", "milestone", glyph("milestone"), milestone.clone().unwrap_or_else(|| "Add to milestone".into()), milestone.is_some(), cx)))
            .child(label("Due date"))
            .child(row(self, "prop-due", "due", theme::glyph("calendar", due_colour).size(px(14.)).into_any_element(), due_words.clone().unwrap_or_else(|| "Set due date".into()), due.is_some(), cx)
                .when(left.is_some_and(|d| !closed && d <= 0), |r| r.text_color(late)))
            .child(label("Works in"))
            .child(row(self, "prop-folder", "folder", glyph("folder"), folder, true, cx))
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
        let chip = |page: &Self, id: &'static str, field: &'static str, icon: AnyElement, words: String, set: bool, cx: &mut Context<Self>| {
            page.opener(id, field, cx)
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
            .child(chip(self, "chip-team", "team", glyph("team"), team.clone().unwrap_or_else(|| "Team".into()), team.is_some(), cx))
            .child(self.menu(prio, "priority", priority.clone(), cx))
            .when(state == "waiting", |c| {
                let on = text(&issue["waiting_on"]);
                c.child(chip(self, "chip-waiting", "waiting_on", glyph("clock"), if on.is_empty() { "Waiting on".into() } else { on.clone() }, !on.is_empty(), cx))
            })
            .child(chip(self, "chip-project", "project", glyph("project"), project.clone().unwrap_or_else(|| "Project".into()), project.is_some(), cx))
            .when(project.is_some(), |c| c.child(chip(self, "chip-milestone", "milestone", glyph("milestone"), milestone.clone().unwrap_or_else(|| "Milestone".into()), milestone.is_some(), cx)))
            .when_some(issue["due"].as_str().filter(|d| !d.is_empty()).and_then(picker::day_label), |c, due| c.child(chip(self, "chip-due", "due", glyph("calendar"), due, true, cx)))
            .child(chip(self, "chip-folder", "folder", glyph("folder"), folder.clone().unwrap_or_else(|| "Folder".into()), folder.is_some(), cx))
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
            .child(
                div().mb(px(16.)).mx(px(-4.)).text_size(px(24.)).line_height(px(31.)).font_semibold().text_color(strong)
                    // Esc leaves the title as it was
                    .capture_action(cx.listener(|page, _: &Escape, window, cx| {
                        let was = page.title_was.clone();
                        page.title.update(cx, |t, cx| t.set_value(was, window, cx));
                        cx.emit(IssueEvent::Done);
                    }))
                    .child(Textarea::new(&self.title).appearance(false).with_size(InputSize::XSmall).text_size(px(24.)).line_height(px(31.))),
            )
            .when(!wide, |m| m.child(self.chips(&page, cx)));
        if state == "review" && page["reviewing"].as_bool() == Some(true) && page["lands"].is_object() {
            main = main.child(self.review(cx));
        }
        if page["plan_steps"].as_array().is_some_and(|s| !s.is_empty()) {
            let steps = div().ml(px(-12.)).child(self.steps.clone()).into_any_element();
            main = main.child(self.section("steps", "Steps", None, steps, cx));
        }
        let body = text(&page["body"]);
        let document = div().id("document").mt(px(24.)).text_size(px(15.)).line_height(px(24.)).text_color(fg);
        main = main.child(match &self.doc {
            // typed in: its Markdown, until you leave it (Esc, or a click elsewhere)
            Some(doc) => document
                .capture_action(cx.listener(|page, _: &Escape, _, cx| { page.leave_doc(cx); cx.emit(IssueEvent::Done) }))
                .mx(px(-4.))
                .child(Textarea::new(doc).appearance(false).with_size(InputSize::XSmall).text_size(px(15.)).line_height(px(24.)))
                .into_any_element(),
            None if body.trim().is_empty() => document.cursor_text().text_color(muted).child("Add description…")
                .on_click(cx.listener(|page, _, window, cx| page.edit_doc(window, cx))).into_any_element(),
            None => document.cursor_text()
                .on_click(cx.listener(|page, _, window, cx| page.edit_doc(window, cx)))
                .child(TextView::markdown(SharedString::from(format!("body-{}", self.slug)), body).selectable(true))
                .into_any_element(),
        });
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
        let menu = self.opened.as_ref().map(|o| {
            let at = self.anchors.get(&o.anchor).map(|b| point(b.left(), b.bottom() + px(4.))).unwrap_or(point(px(400.), px(120.)));
            deferred(anchored().position(at).snap_to_window_with_margin(px(8.)).child(o.view.clone())).with_priority(2)
        });
        div().size_full().children(menu).child(
            div()
                .id("issue-page")
                .size_full()
                .overflow_y_scroll()
                .track_scroll(&self.scroll)
                .child(div().flex().justify_center().child(div().w_full().max_w(px(MOST)).px(px(24.)).pt(px(32.)).pb(px(64.)).child(column))),
        )
    }
}
