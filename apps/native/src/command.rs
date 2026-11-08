// Linear's O then T, O then P and O then I, as the web's (frame/open.tsx): its command menu, narrowed to teams,
// projects or issues, opens one. Untyped, the open issue's own come first (its project; its parent and sub-issues),
// then those opened lately, as Linear's Related and Recent, then the rest; typing keeps the rows holding every word.
// It is drawn as the search box is (search.rs, the web's .menu.command): the box at the window's top, its glyph
// before what is typed, rows under headings, and Open at its foot.
use gpui_kit::base::StyledExt;
use gpui_kit::component::input::{Enter, Escape, Input, InputEvent, InputState, MoveDown, MoveUp};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::Value;

use crate::filters::{colours, modal_shadow};
use crate::sync::Issue;
use crate::theme;

const RECENT: usize = 10;
const SHOWN: usize = 50;
const FILE: &str = "native-recent.json";

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Kind {
    Team,
    Project,
    Issue,
}

#[derive(Clone)]
pub(crate) struct Row {
    pub kind: Kind,
    pub slug: String,
    pub title: String,
    pub state: String, // an issue's, for its icon
}

pub(crate) enum CommandEvent {
    Open(Row),
    Closed,
}

impl EventEmitter<CommandEvent> for Command {}

// What the menu lists, read from the window as it opens.
pub(crate) struct Sources {
    pub teams: Vec<(String, String)>,              // the active ones, in the sidebar's order
    pub projects: Vec<(String, String, String)>,   // slug, title, status
    pub issues: Vec<Issue>,
    pub here: Option<Issue>,                       // the issue whose page is open
}

pub(crate) struct Command {
    kind: Kind,
    sources: Sources,
    query: Entity<InputState>,
    on: usize,
    scroll: ScrollHandle,
    _typed: Subscription,
}

enum Entry {
    Heading(&'static str),
    Row(Row),
}

// The issues and projects opened lately, the latest first.
fn recent(kind: &str) -> Vec<String> {
    crate::state_dir().and_then(|d| std::fs::read_to_string(d.join(FILE)).ok()).and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v[kind].as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())).unwrap_or_default()
}

// An issue or project opened: first among the recent.
pub(crate) fn note_visit(kind: &str, slug: &str) {
    let Some(dir) = crate::state_dir() else { return };
    let mut all: serde_json::Map<String, Value> = std::fs::read_to_string(dir.join(FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let mut list: Vec<String> = recent(kind).into_iter().filter(|s| s != slug).collect();
    list.insert(0, slug.into());
    list.truncate(RECENT);
    all.insert(kind.into(), list.into());
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join(FILE), Value::Object(all).to_string());
}

const CLOSED: [&str; 4] = ["done", "dropped", "completed", "canceled"];

impl Command {
    pub(crate) fn new(kind: Kind, sources: Sources, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let placeholder = match kind { Kind::Team => "Open team…", Kind::Project => "Open project…", Kind::Issue => "Open issue…" };
        let query = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
        query.update(cx, |q, cx| q.focus(window, cx));
        let typed = cx.subscribe(&query, |c, _, event: &InputEvent, cx| if let InputEvent::Change = event { c.on = 0; cx.notify() });
        Self { kind, sources, query, on: 0, scroll: ScrollHandle::new(), _typed: typed }
    }

    fn entries(&self, cx: &App) -> Vec<Entry> {
        let typed = self.query.read(cx).value().trim().to_lowercase();
        let words: Vec<&str> = typed.split_whitespace().collect();
        let hit = |text: &str| { let text = text.to_lowercase(); words.iter().all(|w| text.contains(w)) };
        // groups under their headings; typed, one list with none, as Linear's
        let grouped = |groups: Vec<(&'static str, Vec<Row>)>| -> Vec<Entry> {
            groups.into_iter().filter(|(_, rows)| !rows.is_empty()).flat_map(|(h, rows)| std::iter::once(Entry::Heading(h)).chain(rows.into_iter().map(Entry::Row))).collect()
        };
        let s = &self.sources;
        match self.kind {
            Kind::Team => {
                let rows: Vec<Row> = s.teams.iter().filter(|(_, t)| hit(t)).map(|(slug, t)| Row { kind: Kind::Team, slug: slug.clone(), title: t.clone(), state: String::new() }).collect();
                if words.is_empty() { grouped(vec![("Teams", rows)]) } else { rows.into_iter().map(Entry::Row).collect() }
            }
            Kind::Project => {
                let row = |p: &(String, String, String)| Row { kind: Kind::Project, slug: p.0.clone(), title: p.1.clone(), state: p.2.clone() };
                let mut all: Vec<&(String, String, String)> = s.projects.iter().collect();
                all.sort_by_key(|p| p.1.to_lowercase());
                if !words.is_empty() { return all.into_iter().filter(|p| hit(&p.1)).map(|p| Entry::Row(row(p))).collect() }
                let related: Vec<Row> = s.here.as_ref().and_then(|i| i.project.as_ref()).and_then(|slug| all.iter().find(|p| p.0 == *slug)).map(|p| vec![row(p)]).unwrap_or_default();
                let lately: Vec<Row> = recent("project").iter().filter_map(|slug| all.iter().find(|p| p.0 == *slug)).map(|p| row(p)).collect();
                let shown: Vec<String> = related.iter().chain(&lately).map(|r| r.slug.clone()).collect();
                let rest = all.iter().filter(|p| !shown.contains(&p.0) && !CLOSED.contains(&p.2.as_str())).map(|p| row(p)).collect();
                grouped(vec![("Related project", related), ("Recent projects", lately), ("Projects", rest)])
            }
            Kind::Issue => {
                let here = s.here.as_ref().map(|i| i.slug.clone());
                let row = |i: &Issue| Row { kind: Kind::Issue, slug: i.slug.clone(), title: i.title.clone(), state: i.state.clone() };
                let mut all: Vec<&Issue> = s.issues.iter().filter(|i| Some(&i.slug) != here.as_ref()).collect();
                all.sort_by(|a, b| b.created.cmp(&a.created));
                if !words.is_empty() {
                    let mut found: Vec<&Issue> = all.into_iter().filter(|i| hit(&i.title)).collect();
                    found.sort_by_key(|i| CLOSED.contains(&i.state.as_str()));
                    return found.into_iter().take(SHOWN).map(|i| Entry::Row(row(i))).collect();
                }
                let related: Vec<Row> = match &s.here {
                    Some(h) => h.parent.iter().filter_map(|p| all.iter().find(|i| i.slug == *p)).chain(all.iter().filter(|i| i.parent.as_ref() == Some(&h.slug))).map(|i| row(i)).collect(),
                    None => Vec::new(),
                };
                let lately: Vec<Row> = recent("issue").iter().filter(|slug| Some(*slug) != here.as_ref()).filter_map(|slug| all.iter().find(|i| i.slug == *slug)).map(|i| row(i)).collect();
                let shown: Vec<String> = related.iter().chain(&lately).map(|r| r.slug.clone()).collect();
                let rest = all.iter().filter(|i| !shown.contains(&i.slug) && !CLOSED.contains(&i.state.as_str())).take(SHOWN).map(|i| row(i)).collect();
                grouped(vec![("Related issues", related), ("Recent", lately), ("Issues", rest)])
            }
        }
    }

    fn rows(&self, cx: &App) -> Vec<Row> {
        self.entries(cx).into_iter().filter_map(|e| if let Entry::Row(r) = e { Some(r) } else { None }).collect()
    }

    fn walk(&mut self, by: isize, cx: &mut Context<Self>) {
        let n = self.rows(cx).len();
        if n == 0 { return }
        self.on = (self.on as isize + by).rem_euclid(n as isize) as usize;
        // its place among the list's children, headings too
        let entries = self.entries(cx);
        let mut seen = 0;
        if let Some(at) = entries.iter().position(|e| { let r = matches!(e, Entry::Row(_)); if r { seen += 1 } r && seen == self.on + 1 }) {
            self.scroll.scroll_to_item(at);
        }
        cx.notify();
    }

    fn open(&mut self, n: usize, cx: &mut Context<Self>) {
        if let Some(row) = self.rows(cx).into_iter().nth(n) { cx.emit(CommandEvent::Open(row)) }
    }
}

impl Render for Command {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = colours(cx);
        let entries = self.entries(cx);
        let glyph = match self.kind { Kind::Team => "team", Kind::Project => "project", Kind::Issue => "issues" };
        let mut list = div().id("command-list").v_flex().max_h(px(369.)).overflow_y_scroll().track_scroll(&self.scroll).pt(px(6.)).pr(px(9.)).pb(px(5.)).pl(px(6.));
        let mut n = 0;
        if entries.is_empty() {
            list = list.child(div().h_flex().flex_none().h(px(46.)).px(px(12.)).text_color(c.cmd_hint).child("No results"));
        }
        for (i, entry) in entries.into_iter().enumerate() {
            list = list.child(match entry {
                Entry::Heading(h) => div().h_flex().flex_none().h(px(30.)).px(px(12.)).text_size(px(12.)).font_medium().text_color(c.tip_key).child(h).into_any_element(),
                Entry::Row(row) => {
                    let (me, on) = (n, n == self.on);
                    n += 1;
                    let icon = match row.kind {
                        Kind::Issue => theme::state_icon(&row.state, cx).into_any_element(),
                        Kind::Team => theme::glyph("team", if on { c.cmd_on_text } else { c.tip_text }).into_any_element(),
                        Kind::Project => theme::glyph("project", if on { c.cmd_on_text } else { c.tip_text }).into_any_element(),
                    };
                    div().id(("command-row", i)).h_flex().flex_none().h(px(46.)).py(px(2.)).child(
                        div().h_flex().size_full().px(px(12.)).gap(px(8.)).rounded(px(8.)).font_weight(FontWeight(450.))
                            .text_color(if on { c.cmd_on_text } else { c.tip_text })
                            .when(on, |r| r.bg(c.cmd_on))
                            .child(div().flex_none().size(px(16.)).flex().items_center().justify_center().child(icon))
                            .child(div().min_w_0().truncate().child(row.title.clone())),
                    )
                    .on_mouse_move(cx.listener(move |c, _, _, cx| if c.on != me { c.on = me; cx.notify() }))
                    .on_mouse_down(MouseButton::Left, cx.listener(move |c, _, _, cx| c.open(me, cx)))
                    .into_any_element()
                }
            });
        }
        let kbd = |k: &'static str| div().px(px(2.)).py(px(2.)).rounded(px(4.)).border(px(0.5)).border_color(c.key_edge).text_size(px(11.)).font_medium().text_color(c.tip_key).child(k);
        let foot = div().h_flex().flex_none().h(px(35.)).px(px(4.)).border_t(px(0.5)).border_color(c.tip_edge).text_size(px(12.)).font_medium()
            .child(div().id("command-open").h_flex().h(px(24.)).px(px(8.)).gap(px(6.)).rounded_full().text_color(c.tip_text).cursor_pointer().hover(|s| s.bg(c.cmd_on))
                .child(kbd("↵")).child("Open")
                .on_click(cx.listener(|c, _, _, cx| { let on = c.on; c.open(on, cx) })));
        let width = (window.viewport_size().width.as_f32() - 32.).min(720.);
        div().child(
            div()
                .id("command")
                .occlude()
                .v_flex()
                .w(px(width))
                .rounded(px(12.))
                .overflow_hidden()
                .border(px(0.5))
                .border_color(c.tip_edge)
                .bg(c.tip)
                .shadow(modal_shadow(c.dark))
                .text_size(px(13.))
                .text_color(c.tip_text)
                .capture_action(cx.listener(|c, _: &MoveDown, _, cx| { cx.stop_propagation(); c.walk(1, cx) }))
                .capture_action(cx.listener(|c, _: &MoveUp, _, cx| { cx.stop_propagation(); c.walk(-1, cx) }))
                .capture_action(cx.listener(|c, _: &Enter, _, cx| { cx.stop_propagation(); let on = c.on; c.open(on, cx) }))
                .capture_action(cx.listener(|_, _: &Escape, _, cx| { cx.stop_propagation(); cx.emit(CommandEvent::Closed) }))
                .on_mouse_down_out(cx.listener(|_, _, _, cx| cx.emit(CommandEvent::Closed)))
                .child(
                    div().relative().pt(px(6.)).px(px(6.)).child(
                        div().flex().items_center().h(px(40.)).pl(px(30.)).pr(px(6.))
                            .child(div().absolute().left(px(12.)).top(px(12.)).child(theme::glyph(glyph, c.tip_text)))
                            .child(Input::new(&self.query).appearance(false).text_size(px(13.)).px_0().py_0().h(px(24.))),
                    ),
                )
                .child(list)
                .child(foot),
        )
    }
}
