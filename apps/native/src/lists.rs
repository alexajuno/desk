// The issue lists, as the web's (lists/IssuesPage.tsx, parts.tsx, issues/Tree.tsx), which copy Linear's Issues page:
// the page's name in the top bar, then a row of three tabs, All issues, Active and Backlog, each a page of its own with
// its own view; then the list, its groups under soft headers that fold, and 44px rows, a sub-issue nested under its
// parent on a thin line. My issues lists every issue, and a team's Issues its own. desk's server draws each list from
// the view in its words (views.ts): what is filtered, how it is grouped and ordered. The window keeps each page's last
// view, and which groups are folded, between runs, as the web keeps them in the browser. J and K, or ↓ and ↑, move the
// focus, as the mouse does; Enter opens the issue in focus, and T folds its group. Filter (F) and Display options
// (Shift V) are at the tabs' right end, as filters.rs draws them; a change to the view is a change to its words, which
// desk reads again (views.ts), as the web's setView. Its Layout may be Board instead (board.rs, Ctrl B switches). S,
// P and a right-click open a row's menus (menus.rs).
mod board;
mod menus;

use std::collections::HashMap;
use std::time::Duration;

use chrono::{Datelike, Local, NaiveDate};
use gpui_kit::base::StyledExt;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::Value;

use crate::filters::{colours, ring, ringed, Anchors, ChipsLook, Colours, Filtering, Panel, Popups, Select};
use crate::listing::{quote, Chip, Choice, Field, Icon};
use crate::picker::Picker;
use gpui_kit::component::menu::PopupMenu;
use crate::tip::Tipped;
use crate::{net, theme};

const VIEWS: &str = "native-views.json";
const FOLDED: &str = "native-collapsed.json";

// The tabs: their word in the address, their name, and what the list says with no issue.
pub(crate) const TABS: [(&str, &str, &str); 3] =
    [("", "All issues", "No open issues."), ("active", "Active", "Nothing is being worked on."), ("backlog", "Backlog", "Nothing in the backlog.")];

// A tab's page, My issues' or a team's, by which the window keeps its view.
pub(crate) fn path_of(tab: &str, team: Option<&str>) -> String {
    match team {
        Some(team) => format!("/team/{team}/{}", if tab.is_empty() { "all" } else { tab }),
        None if tab.is_empty() => "/issues".into(),
        None => format!("/issues/{tab}"),
    }
}

fn api_of(tab: &str, team: Option<&str>) -> String {
    let base = team.map_or_else(|| "/api/page/issues".to_string(), |t| format!("/api/page/team/{t}/issues"));
    if tab.is_empty() { base } else { format!("{base}/{tab}") }
}

// A file of the window's state, read whole: the views by page, the folded groups by list.
fn kept(file: &str) -> serde_json::Map<String, Value> {
    crate::state_dir().and_then(|d| std::fs::read_to_string(d.join(file)).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn keep(file: &str, all: &serde_json::Map<String, Value>) {
    let Some(dir) = crate::state_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join(file), Value::Object(all.clone()).to_string());
}

// Linear's due date: "Nov 8th", with its year when it is not this one.
fn due_label(day: NaiveDate) -> String {
    let n = day.day();
    let ord = match (n % 10, n) { (1, n) if n != 11 => "st", (2, n) if n != 12 => "nd", (3, n) if n != 13 => "rd", _ => "th" };
    let year = if day.year() == Local::now().year() { String::new() } else { format!(", {}", day.year()) };
    format!("{} {n}{ord}{year}", day.format("%b"))
}

pub(crate) enum ListEvent {
    Open(String), // an issue, by its slug
    New(Value),   // a group's +: a new issue with what the group says
}

impl EventEmitter<ListEvent> for IssueList {}

pub(crate) struct IssueList {
    pub tab: String,
    pub team: Option<String>,
    query: String,       // the view, in the words of the page's address
    data: Option<Value>, // the list as desk last drew it
    failed: Option<String>,
    asked: usize,        // the newest ask: an older answer is dropped
    pub focus: FocusHandle,
    focused: Option<String>, // the row in focus, by its slug
    scroll: ScrollHandle,
    popups: Popups,
    anchors: Anchors,
    dragging: Option<board::DraggedCard>,
    painted: HashMap<String, (String, String)>, // a status or priority just set, by the issue's slug, until desk draws it
    asking: Option<(Entity<Picker>, Point<Pixels>, Subscription)>, // on whom it waits, or its parent
    menu: Option<(Entity<PopupMenu>, Point<Pixels>, Subscription)>, // a row's status, priority or actions
    _again: Option<Task<()>>,
}

impl IssueList {
    pub(crate) fn new(tab: &str, team: Option<String>, cx: &mut Context<Self>) -> Self {
        let mut list = Self {
            tab: tab.into(),
            team,
            query: String::new(),
            data: None,
            failed: None,
            asked: 0,
            focus: cx.focus_handle(),
            focused: None,
            scroll: ScrollHandle::new(),
            popups: Popups::default(),
            anchors: Anchors::default(),
            dragging: None,
            painted: HashMap::new(),
            asking: None,
            menu: None,
            _again: None,
        };
        list.query = list.last_view();
        list.ask(cx);
        list
    }

    pub(crate) fn path(&self) -> String {
        path_of(&self.tab, self.team.as_deref())
    }

    fn last_view(&self) -> String {
        kept(VIEWS).get(&self.path()).and_then(Value::as_str).unwrap_or("").to_string()
    }

    // The page's title, for the window's: "My issues › Active", "desk › All issues".
    pub(crate) fn title(&self) -> String {
        let name = TABS.iter().find(|(t, _, _)| *t == self.tab).map(|(_, n, _)| *n).unwrap_or("All issues");
        let whose = match &self.team {
            Some(_) => self.data.as_ref().and_then(|d| d["team"]["title"].as_str()).unwrap_or("").to_string(),
            None => "My issues".into(),
        };
        format!("{whose} › {name}")
    }

    pub(crate) fn set_tab(&mut self, tab: &str, cx: &mut Context<Self>) {
        if self.tab == tab { return }
        self.tab = tab.into();
        self.query = self.last_view();
        self.focused = None;
        self.popups = Popups::default();
        self.ask(cx);
    }

    // The list again, as desk draws it for the view.
    fn ask(&mut self, cx: &mut Context<Self>) {
        self.asked += 1;
        let asked = self.asked;
        let url = format!("{}{}", api_of(&self.tab, self.team.as_deref()), if self.query.is_empty() { String::new() } else { format!("?{}", self.query) });
        let path = self.path();
        cx.spawn(async move |this, cx| {
            let got = cx.background_spawn(async move { net::get(&url) }).await;
            let _ = this.update(cx, |list, cx| {
                if list.asked != asked || list.path() != path { return }
                match got {
                    Ok(data) => {
                        // the view as desk read it, kept as the page's last
                        list.query = data["view"]["query"].as_str().unwrap_or("").to_string();
                        let mut views = kept(VIEWS);
                        if list.query.is_empty() { views.remove(&path); } else { views.insert(path, list.query.clone().into()); }
                        keep(VIEWS, &views);
                        list.data = Some(data);
                        list.failed = None;
                        list.painted.clear();
                    }
                    Err(e) => list.failed = Some(e),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn view(&self) -> &Value {
        self.data.as_ref().map_or(&Value::Null, |d| &d["view"])
    }

    // Words of the view changed, as the web's setView: None, or the page's default, drops a word; then desk draws the
    // list for the new view.
    fn set_view(&mut self, changes: Vec<(String, Option<String>)>, cx: &mut Context<Self>) {
        let defaults = self.view()["defaults"].clone();
        let mut words: Vec<(String, String)> =
            self.query.split('&').filter_map(|w| w.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())).collect();
        for (name, value) in changes {
            match value.filter(|v| defaults[name.as_str()].as_str() != Some(v.as_str())) {
                None => words.retain(|(k, _)| *k != name),
                Some(v) => match words.iter_mut().find(|(k, _)| *k == name) {
                    Some(word) => word.1 = quote(&v),
                    None => words.push((name, quote(&v))),
                },
            }
        }
        self.query = words.into_iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&");
        self.ask(cx);
    }

    // An issue changed: the list is drawn again once the changes stop for a moment.
    pub(crate) fn refresh(&mut self, cx: &mut Context<Self>) {
        self._again = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(250)).await;
            let _ = this.update(cx, |list, cx| list.ask(cx));
        }));
    }

    fn collapse_key(&self) -> String {
        self.data.as_ref().and_then(|d| d["collapse_key"].as_str()).unwrap_or("").to_string()
    }

    fn folded(&self) -> Vec<String> {
        kept(FOLDED).get(&self.collapse_key()).and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default()
    }

    // A group's triangle: it folds or opens; all of the list's groups at once with Alt, as Linear's.
    fn fold(&mut self, value: &str, all: bool, cx: &mut Context<Self>) {
        let key = self.collapse_key();
        let mut shut = self.folded();
        let closing = !shut.iter().any(|v| v == value);
        let groups: Vec<String> = if all { self.groups().iter().map(|g| g["value"].as_str().unwrap_or("").to_string()).collect() } else { vec![value.to_string()] };
        for g in groups {
            shut.retain(|v| *v != g);
            if closing { shut.push(g) }
        }
        let mut memory = kept(FOLDED);
        if shut.is_empty() { memory.remove(&key); } else { memory.insert(key, shut.into()); }
        keep(FOLDED, &memory);
        // a row in focus that the fold hid lets the focus go
        if self.focused.as_ref().is_some_and(|f| !self.shown().contains(f)) { self.focused = None }
        cx.notify();
    }

    fn groups(&self) -> Vec<Value> {
        self.data.as_ref().and_then(|d| d["groups"].as_array().cloned()).unwrap_or_default()
    }

    fn empty_text(&self) -> &'static str {
        TABS.iter().find(|(t, _, _)| *t == self.tab).map(|(_, _, e)| *e).unwrap_or("")
    }

    // The rows on screen, in order, by slug: the open groups' rows and their sub-issues, or the board's cards, column
    // by column.
    fn shown(&self) -> Vec<String> {
        if self.is_board() {
            return self.columns().into_iter().flat_map(|(_, cards)| cards).filter_map(|p| p["slug"].as_str().map(str::to_string)).collect();
        }
        fn walk(items: &[Value], out: &mut Vec<String>) {
            for p in items {
                if let Some(slug) = p["slug"].as_str() { out.push(slug.into()) }
                walk(p["kids"].as_array().map(Vec::as_slice).unwrap_or(&[]), out);
            }
        }
        let shut = self.folded();
        let grouped = self.data.as_ref().is_some_and(|d| d["grouped"] == true);
        let mut out = Vec::new();
        for g in self.groups() {
            if grouped && shut.iter().any(|v| g["value"].as_str() == Some(v)) { continue }
            walk(g["items"].as_array().map(Vec::as_slice).unwrap_or(&[]), &mut out);
        }
        out
    }

    // The group of the row in focus, for T.
    fn group_of(&self, slug: &str) -> Option<String> {
        fn has(items: &[Value], slug: &str) -> bool {
            items.iter().any(|p| p["slug"].as_str() == Some(slug) || has(p["kids"].as_array().map(Vec::as_slice).unwrap_or(&[]), slug))
        }
        self.groups().into_iter().find(|g| has(g["items"].as_array().map(Vec::as_slice).unwrap_or(&[]), slug)).and_then(|g| g["value"].as_str().map(str::to_string))
    }

    fn walk(&mut self, by: isize, cx: &mut Context<Self>) {
        let rows = self.shown();
        if rows.is_empty() { return }
        let at = self.focused.as_ref().and_then(|f| rows.iter().position(|r| r == f));
        let next = match at {
            Some(at) => (at as isize + by).clamp(0, rows.len() as isize - 1) as usize,
            None if by > 0 => 0,
            None => rows.len() - 1,
        };
        self.focused = Some(rows[next].clone());
        cx.notify();
    }

    fn key(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // a box drawn inside the list, such as Filter's or the question on whom, keeps its own keys
        if !self.focus.is_focused(window) { return }
        let k = &e.keystroke;
        if k.modifiers.control && k.key == "b" && !(k.modifiers.alt || k.modifiers.shift || k.modifiers.platform) {
            if let Some(layout) = self.view()["layout"].as_str() {
                let other = if layout == "board" { "list" } else { "board" };
                self.set_view(vec![("layout".into(), Some(other.into()))], cx);
                cx.stop_propagation();
            }
            return;
        }
        // Ctrl ⌫: the issue in focus, to the trash
        if k.modifiers.control && ["backspace", "delete"].contains(&k.key.as_str()) && !(k.modifiers.alt || k.modifiers.shift) {
            if let Some(slug) = self.focused.clone() { self.delete(&slug, cx); cx.stop_propagation() }
            return;
        }
        if k.modifiers.control || k.modifiers.alt || k.modifiers.platform { return }
        if k.modifiers.shift {
            if k.key != "v" || self.data.is_none() { return }
            self.toggle_display(cx);
            cx.stop_propagation();
            return;
        }
        match k.key.as_str() {
            "f" if self.data.is_some() => self.open_filter(None, "filter", window, cx),
            "s" | "p" => match self.focused.clone() {
                Some(slug) => {
                    let at = self.under_row(&slug);
                    self.field_menu(slug, if k.key == "s" { "state" } else { "priority" }, at, window, cx);
                }
                None => return,
            },
            // I, as the web's: the issue's chat, which its page is here
            "i" => match self.focused.clone() {
                Some(slug) => cx.emit(ListEvent::Open(slug)),
                None => return,
            },
            "escape" if self.popups.display => self.close_popups(window, cx),
            "j" | "down" => self.walk(1, cx),
            "k" | "up" => self.walk(-1, cx),
            "enter" => match self.focused.clone() {
                Some(slug) => cx.emit(ListEvent::Open(slug)),
                None => return,
            },
            "t" => match self.focused.clone().filter(|_| !self.is_board()).and_then(|f| self.group_of(&f)) {
                Some(group) => self.fold(&group, false, cx),
                None => return,
            },
            _ => return,
        }
        cx.stop_propagation();
    }

    // A tab, as Linear's view tabs: a 28px pill, ringed, the open one filled brighter.
    fn tab_pill(&self, n: usize, tab: &'static str, name: &'static str, c: &Colours, cx: &mut Context<Self>) -> Stateful<Div> {
        let here = self.tab == tab;
        let (ring_hover, hover, dark) = (c.ring_hover, c.ghost_hover, c.dark);
        let shadow = move |edge: Hsla| ringed(edge, dark);
        div()
            .id(("tab", n))
            .h_flex()
            .flex_none()
            .h(px(28.))
            .px(px(10.))
            .rounded_full()
            .text_size(px(12.))
            .font_medium()
            .cursor_pointer()
            .when(here, |t| t.bg(c.tab_on).text_color(c.text_1).shadow(vec![ring(c.ring, 0.5)]))
            .when(!here, |t| {
                let (text_2, lit) = (c.text_2, shadow(ring_hover));
                t.bg(c.chip).text_color(c.text_3).shadow(shadow(c.ring)).hover(move |s| s.bg(hover).text_color(text_2).shadow(lit.clone()))
            })
            .child(name)
            .on_click(cx.listener(move |list, _, _, cx| list.set_tab(tab, cx)))
    }

    // Filter and Display options at the tabs' right end, as Linear's: 28px round buttons, filled and ringed as the tabs,
    // Display with a dot while the list's display is not its default.
    fn tools(&self, c: &Colours, cx: &mut Context<Self>) -> Option<Div> {
        let view = self.data.as_ref().map(|d| &d["view"])?;
        let (hover, ring_hover, text_2, dark) = (c.btn_hover, c.ring_hover, c.text_2, c.dark);
        let tool = |id: &'static str| {
            div().id(id).group(id).relative().flex().flex_none().items_center().justify_center().size(px(28.)).rounded_full().cursor_pointer()
                .bg(c.chip).shadow(ringed(c.ring, dark))
                .hover(move |s| s.bg(hover).shadow(ringed(ring_hover, dark)))
                .child(theme::glyph(id, c.text_3).group_hover(id, move |s| s.text_color(text_2)))
                .child(self.anchors.probe(id))
        };
        let filter = tool("filter")
            .on_click(cx.listener(|list, _, window, cx| {
                if list.popups.menu_at() == Some("filter") { list.close_popups(window, cx) } else { list.open_filter(None, "filter", window, cx) }
            }))
            .tip("Filter  F");
        let display = tool("display")
            .when(view["default"] == false, |b| b.child(div().absolute().top_0().right_0().size(px(7.)).rounded_full().bg(c.accent)))
            .on_click(cx.listener(|list, _, _, cx| list.toggle_display(cx)))
            .tip("Display options  Shift V");
        Some(div().h_flex().ml_auto().gap(px(6.)).child(filter).child(display))
    }

    // A group's header: its triangle, its icon, its name and count, and the + of a new issue that starts in it.
    fn group_head(&self, n: usize, g: &Value, shut: bool, c: &Colours, cx: &mut Context<Self>) -> Stateful<Div> {
        let value = g["value"].as_str().unwrap_or("").to_string();
        let (toggle_colour, text_2) = (c.group_toggle, c.text_2);
        let triangle = div()
            .id(("fold", n))
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(20.))
            .mr(px(-2.))
            .rounded_full()
            .cursor_pointer()
            .text_color(toggle_colour)
            .hover(move |s| s.text_color(text_2))
            .child(svg().path(if shut { "desk/glyph/triangle.svg" } else { "desk/glyph/triangle-open.svg" }).size(px(16.)).text_color(toggle_colour))
            .on_click(cx.listener(move |list, e: &ClickEvent, _, cx| list.fold(&value, e.modifiers().alt, cx)))
            .tip(if shut { "Expand group" } else { "Collapse group" });
        let preset = g["preset"].clone();
        let (active, text_1) = (c.active, c.text_1);
        let add = preset.is_object().then(|| {
            div()
                .id(("add", n))
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(24.))
                .ml_auto()
                .rounded(px(6.))
                .cursor_pointer()
                .hover(move |s| s.bg(active).text_color(text_1))
                .child(theme::glyph("plus", c.text_3))
                .on_click(cx.listener(move |_, _, _, cx| cx.emit(ListEvent::New(preset.clone()))))
                .tip("New issue")
        });
        div()
            .id(("group", n))
            .h_flex()
            .flex_none()
            .h(px(36.))
            .mt(px(8.))
            .pl(px(8.))
            .pr(px(12.))
            .gap(px(8.))
            .rounded(px(8.))
            .bg(c.box_fill)
            .text_size(px(12.))
            .font_medium()
            .text_color(c.text_1)
            .child(triangle)
            .children(icon_of(g["icon"].as_str(), c, cx))
            .child(g["label"].as_str().unwrap_or("").to_string())
            .child(div().text_color(c.text_3).font_weight(FontWeight(450.)).child(g["count"].as_u64().unwrap_or(0).to_string()))
            .children(add)
    }

    // An issue's row, Linear's: its priority and status, its title, who it waits on and since when, how many of its
    // sub-issues are open, its due date, and the day it was made at the right.
    fn row(&self, p: &Value, nested: bool, c: &Colours, cx: &mut Context<Self>) -> Stateful<Div> {
        let slug = p["slug"].as_str().unwrap_or("").to_string();
        let context = p["context"] == true;
        let focused = self.focused.as_deref() == Some(slug.as_str());
        let state = p["state"].as_str().unwrap_or("backlog");
        let faded = |e: Div| if context { e.opacity(0.5) } else { e };
        let icon = |e: AnyElement| faded(div().flex().flex_none().items_center().justify_center().size(px(22.)).mx(px(-3.)).rounded(px(4.)).child(e));
        let waiting = (state == "waiting").then(|| {
            let on = p["waiting_on"].as_str().filter(|w| !w.is_empty()).unwrap_or("Waiting").to_string();
            [
                div().flex_shrink(1.).min_w_0().max_w(relative(0.4)).truncate().text_size(px(12.)).text_color(c.text_3).child(on),
                div().flex_none().ml(px(-4.)).text_size(px(12.)).text_color(c.text_3).child(format!("· {}", p["waited"].as_str().unwrap_or(""))),
            ]
        });
        let open = p["open"].as_u64().filter(|n| *n > 0).map(|n| {
            faded(div().h_flex().flex_none().h(px(22.)).px(px(8.)).rounded_full().border_1().border_color(c.edge_3).text_size(px(12.)).text_color(c.text_3)
                .child(format!("{n} open")))
        });
        let due = p["due"].as_str().and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()).map(|day| {
            let days = (day - Local::now().date_naive()).num_days();
            let closed = ["done", "dropped"].contains(&state);
            let tone = if closed { None } else if days <= 0 { Some(c.late) } else if days <= 7 { Some(theme::text(cx).waiting) } else { None };
            div().h_flex().flex_none().h(px(22.)).pl(px(6.)).pr(px(8.)).gap(px(6.)).rounded_full().border(px(0.5)).border_color(c.edge_3)
                .text_size(px(12.)).text_color(if days <= 0 && !closed { c.late } else { c.text_2 })
                .child(theme::glyph("calendar", tone.unwrap_or(c.text_3)).size(px(14.)))
                .child(due_label(day))
        });
        let (raised, open_slug, menu_slug) = (c.box_fill, slug.clone(), slug.clone());
        div()
            .id(SharedString::from(format!("row-{slug}")))
            .relative()
            .h_flex()
            .flex_none()
            .h(px(44.))
            .pl(px(if nested { 16. } else { 24. }))
            .pr(px(16.))
            .gap(px(10.))
            .rounded(px(6.))
            .cursor_pointer()
            .text_color(if context { c.text_3 } else { c.text_1 })
            .when(focused, |r| r.bg(raised))
            .hover(move |s| s.bg(raised))
            .child(icon(crate::issue::priority_icon(p["priority"].as_str().unwrap_or("none"), cx).size(px(16.)).into_any_element()))
            .child(icon(theme::state_icon(state, cx).into_any_element()))
            .child(div().min_w_0().truncate().font_medium().child(p["title"].as_str().unwrap_or("").to_string()))
            .children(waiting.into_iter().flatten())
            .children(open)
            .children(due)
            .child(div().flex_1())
            .child(faded(div().flex_none().min_w(px(44.)).text_right().text_size(px(12.)).text_color(c.text_3).child(p["created_short"].as_str().unwrap_or("").to_string())))
            .on_mouse_move(cx.listener(move |list, _, _, cx| {
                if list.focused.as_deref() != Some(slug.as_str()) { list.focused = Some(slug.clone()); cx.notify() }
            }))
            .child(self.anchors.probe(format!("row-{menu_slug}")))
            .on_click(cx.listener(move |_, _, _, cx| cx.emit(ListEvent::Open(open_slug.clone()))))
            .on_mouse_down(MouseButton::Right, cx.listener(move |list, e: &MouseDownEvent, window, cx| {
                // the list's own focus on a press would take the keys from the menu
                cx.stop_propagation();
                window.prevent_default();
                list.focused = Some(menu_slug.clone());
                list.actions_menu(menu_slug.clone(), e.position, window, cx);
            }))
    }

    // A row and, under it on a thin line, its sub-issues.
    fn tree(&self, items: &[Value], nested: bool, c: &Colours, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mut out = Vec::new();
        for p in items {
            out.push(self.row(p, nested, c, cx).into_any_element());
            let kids = p["kids"].as_array().map(Vec::as_slice).unwrap_or(&[]);
            if !kids.is_empty() {
                out.push(div().v_flex().ml(px(30.)).border_l_1().border_color(c.edge_3).children(self.tree(kids, true, c, cx)).into_any_element());
            }
        }
        out
    }
}

// An icon by the key desk's views.ts gives it: state-running, priority-high, project-started, glyph-folder.
pub(crate) fn icon_of(key: Option<&str>, c: &Colours, cx: &App) -> Option<AnyElement> {
    let (kind, value) = key?.split_once('-')?;
    Some(match kind {
        "state" => theme::state_icon(value, cx).into_any_element(),
        "priority" => crate::issue::priority_icon(value, cx).size(px(16.)).into_any_element(),
        "project" => theme::project_icon(value, 0, cx).into_any_element(),
        _ => theme::glyph(value, c.text_3).into_any_element(),
    })
}

impl Focusable for IssueList {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for IssueList {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // a card let go of outside every column
        if self.dragging.is_some() && !cx.has_active_drag() { self.dragging = None }
        let c = colours(cx);
        let divider = theme::text(cx).divider;
        let crumb = match &self.team {
            Some(_) => div().h_flex().gap(px(8.)).child(theme::glyph("team", c.text_2)).child(
                self.data.as_ref().and_then(|d| d["team"]["title"].as_str()).unwrap_or("").to_string(),
            ),
            None => div().child("My issues"),
        };
        let bar = div().h_flex().flex_none().h(px(44.)).px(px(16.)).gap(px(8.)).border_b_1().border_color(divider).text_color(c.text_1).child(crumb);
        let tabs: Vec<_> = TABS.iter().enumerate().map(|(n, (tab, name, _))| self.tab_pill(n, tab, name, &c, cx)).collect();
        let view_bar = div().h_flex().flex_none().h(px(43.)).pl(px(8.)).pr(px(10.)).gap(px(4.)).children(tabs).children(self.tools(&c, cx));
        let mut page = div().v_flex().pt(px(12.)).px(px(8.)).pb(px(120.));
        let board = match &self.data {
            Some(data) if self.is_board() => Some(
                div().flex_1().min_h_0().v_flex().pt(px(12.)).px(px(8.)).children(self.filter_chips(ChipsLook::List, cx)).child(self.board(data, &c, cx)),
            ),
            _ => None,
        };
        match &self.data {
            _ if board.is_some() => {}
            None => {
                if let Some(e) = &self.failed { page = page.child(div().p(px(16.)).text_color(c.text_3).child(e.clone())) }
            }
            Some(data) => {
                page = page.children(self.filter_chips(ChipsLook::List, cx));
                let grouped = data["grouped"] == true;
                let shut = self.folded();
                let groups = self.groups();
                for (n, g) in groups.iter().enumerate() {
                    let folded = grouped && shut.iter().any(|v| g["value"].as_str() == Some(v));
                    if grouped { page = page.child(self.group_head(n, g, folded, &c, cx)) }
                    if !folded { page = page.children(self.tree(g["items"].as_array().map(Vec::as_slice).unwrap_or(&[]), false, &c, cx)) }
                }
                let hidden = data["hidden"].as_u64().unwrap_or(0);
                if groups.is_empty() && hidden == 0 {
                    page = page.child(div().p(px(16.)).text_color(c.text_3).child(self.empty_text()));
                }
                if hidden > 0 {
                    page = page.child(
                        div().h_flex().justify_center().gap(px(8.)).my(px(24.)).text_color(c.text_3)
                            .child(div().text_color(c.text_1).font_medium().child(format!("{hidden} issue{}", if hidden == 1 { "" } else { "s" })))
                            .child("hidden by filters")
                            .child(
                                div().id("clear-filters").h_flex().h(px(24.)).px(px(8.)).gap(px(6.)).rounded_full().text_color(c.text_1).font_medium()
                                    .cursor_pointer().hover(|s| s.bg(c.active))
                                    .child("Clear filters")
                                    .child(theme::glyph("close", c.text_1).size(px(12.)))
                                    .on_click(cx.listener(|list, _, _, cx| list.clear_filters(cx))),
                            ),
                    );
                }
            }
        }
        div()
            .v_flex()
            .size_full()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|list, e: &KeyDownEvent, window, cx| list.key(e, window, cx)))
            .child(bar)
            .child(view_bar)
            .map(|root| match board {
                Some(board) => root.child(board),
                None => root.child(div().id("list-scroll").flex_1().min_h_0().overflow_y_scroll().track_scroll(&self.scroll).child(page)),
            })
            .children(self.filter_layers(cx))
            .children(self.menu_layer())
            .children(self.asking_layer())
    }
}

// The list's view is desk's server's: it says what Filter and Display offer, with the list it draws (views.ts).
impl Filtering for IssueList {
    fn popups(&mut self) -> &mut Popups {
        &mut self.popups
    }

    fn popped(&self) -> &Popups {
        &self.popups
    }

    fn anchors(&self) -> &Anchors {
        &self.anchors
    }

    fn home(&self) -> FocusHandle {
        self.focus.clone()
    }

    fn fields(&self, _: &App) -> Vec<Field> {
        let text = |v: &Value| v.as_str().unwrap_or("").to_string();
        let icon = |v: &Value| v.as_str().and_then(Icon::from_key);
        self.view()["fields"].as_array().into_iter().flatten().map(|f| Field {
            name: text(&f["name"]),
            label: text(&f["label"]),
            icon: icon(&f["icon"]),
            values: f["values"].as_array().into_iter().flatten().map(|v| Choice {
                value: text(&v["value"]),
                label: text(&v["label"]),
                icon: icon(&v["icon"]),
                count: v["count"].as_u64().unwrap_or(0) as usize,
            }).collect(),
        }).collect()
    }

    fn noun(&self) -> String {
        self.view()["noun"].as_str().unwrap_or("issue").into()
    }

    fn chips(&self, _: &App) -> Vec<Chip> {
        let text = |v: &Value| v.as_str().unwrap_or("").to_string();
        let chips = self.data.as_ref().and_then(|d| d["chips"].as_array().cloned()).unwrap_or_default();
        chips.iter().map(|c| Chip {
            name: text(&c["name"]),
            label: text(&c["label"]),
            not: c["not"] == true,
            values: c["values"].as_array().into_iter().flatten().map(|v| (text(&v[0]), text(&v[1]), v[2].as_str().and_then(Icon::from_key))).collect(),
        }).collect()
    }

    // From the view's words, which a change sets at once, before desk answers.
    fn filter(&self, name: &str) -> (bool, Vec<String>) {
        let Some(word) = self.query.split('&').filter_map(|w| w.split_once('=')).find(|(k, _)| *k == name).map(|(_, v)| net::decode(v)) else {
            return Default::default();
        };
        let not = word.starts_with("not:");
        (not, word.trim_start_matches("not:").split(',').filter(|v| !v.is_empty()).map(str::to_string).collect())
    }

    fn set_filters(&mut self, changes: Vec<(String, Option<(bool, Vec<String>)>)>, cx: &mut Context<Self>) {
        let words = changes.into_iter().map(|(name, f)| (name, f.map(|(not, values)| format!("{}{}", if not { "not:" } else { "" }, values.join(","))))).collect();
        self.set_view(words, cx);
    }

    fn panel(&self) -> Panel {
        let view = self.view();
        let select = |d: &Value| {
            let key = d["key"].as_str().unwrap_or("").to_string();
            Select {
                label: d["label"].as_str().unwrap_or("").into(),
                options: d["options"].as_object().into_iter().flatten().map(|(v, l)| (v.clone(), l.as_str().unwrap_or("").to_string())).collect(),
                current: view[key.as_str()].as_str().unwrap_or("").into(),
                key,
            }
        };
        let display = view["display"].as_array().cloned().unwrap_or_default();
        let is = |d: &Value, keys: &[&str]| keys.iter().any(|k| d["key"] == *k);
        Panel {
            layout: display.iter().find(|d| is(d, &["layout"])).map(select),
            first: display.iter().filter(|d| is(d, &["group", "order"])).map(select).collect(),
            rest: display.iter().filter(|d| !is(d, &["layout", "group", "order"])).map(select).collect(),
            switches: view["switches"].as_array().into_iter().flatten().map(|s| {
                let key = s["key"].as_str().unwrap_or("").to_string();
                let on = view[key.as_str()] == true;
                (key, s["label"].as_str().unwrap_or("").to_string(), on)
            }).collect(),
            reverse: (view["reversible"] == true).then(|| view["reverse"] == true),
        }
    }

    fn set_display(&mut self, changes: Vec<(String, Option<String>)>, cx: &mut Context<Self>) {
        self.set_view(changes, cx);
    }

    // The page's defaults again, the order not reversed and every switch off.
    fn reset_display(&mut self, cx: &mut Context<Self>) {
        let view = self.view();
        let mut changes: Vec<(String, Option<String>)> =
            view["defaults"].as_object().into_iter().flatten().map(|(k, v)| (k.clone(), v.as_str().map(str::to_string))).collect();
        changes.push(("reverse".into(), None));
        changes.extend(view["switches"].as_array().into_iter().flatten().filter_map(|s| s["key"].as_str()).map(|k| (k.to_string(), None)));
        self.set_view(changes, cx);
    }
}
