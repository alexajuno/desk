// The right half's Changes, as the web app's (sessions/Changes.tsx): a card per build step, holding the step's diff from
// the commit its session sent as it ticked the step (the server's changes.ts), its lines drawn as Linear Diffs draws
// them: one number column, a tinted line with a coloured edge for what was added or deleted, the counts in green and
// red. The latest step starts open, a file past 400 changed lines starts folded, the lines a hunk leaves out open from
// the rows between them, and lines picked by their numbers, as on GitHub, take a comment that goes into the chat.
//
// It is one list of rows, a step's head, a file's head, a line, drawn only while on screen, so a diff of thousands of
// lines costs what the screen shows. The diffs are read while the half shows them and let go when it closes.
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use gpui_kit::base::StyledExt;
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::Value;

use crate::chat::Chat;
use crate::{net, theme};

// A file with more changed lines than this starts folded, so one big file doesn't bury the rest.
const OPEN_LINES: u64 = 400;
// How many hidden lines an arrow opens, as GitHub's do.
const MORE_LINES: usize = 20;
// Whole file draws a file at once only up to this many lines.
const WHOLE_LINES: usize = 5000;
// The cards' widest, the conversation's.
const CARDS: f32 = 768.;
// A line of code: 13px mono on 20.8px.
const LINE: f32 = 20.8;

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Kept,
    Added,
    Deleted,
}

struct Line {
    kind: Kind,
    old: Option<usize>,
    now: Option<usize>,
    text: SharedString,
}

struct Hunk {
    header: SharedString,
    lines: Vec<Line>,
}

struct FileDiff {
    path: String,
    was: Option<String>,
    added: u64,
    deleted: u64,
    binary: bool,
    cut: bool,
    length: Option<usize>, // how many lines it has at the step's commit, when its hidden lines can open
    hunks: Vec<Hunk>,
}

struct StepDiff {
    place: String,
    title: String,
    state: String,
    note: String,
    commit: String,
    added: u64,
    deleted: u64,
    files: Vec<FileDiff>,
}

fn text(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or("").to_string()
}

fn parse(page: &Value) -> Vec<StepDiff> {
    let list = |v: &Value| v.as_array().cloned().unwrap_or_default();
    list(&page["steps"])
        .iter()
        .map(|s| StepDiff {
            place: text(s, "place"),
            title: text(s, "title"),
            state: text(s, "state"),
            note: text(s, "note"),
            commit: text(s, "commit"),
            added: s["added"].as_u64().unwrap_or(0),
            deleted: s["deleted"].as_u64().unwrap_or(0),
            files: list(&s["files"])
                .iter()
                .map(|f| FileDiff {
                    path: text(f, "path"),
                    was: f["was"].as_str().map(str::to_string),
                    added: f["added"].as_u64().unwrap_or(0),
                    deleted: f["deleted"].as_u64().unwrap_or(0),
                    binary: f["binary"].as_bool().unwrap_or(false),
                    cut: f["cut"].as_bool().unwrap_or(false),
                    length: f["length"].as_u64().map(|n| n as usize),
                    hunks: list(&f["hunks"])
                        .iter()
                        .map(|h| Hunk {
                            header: text(h, "header").into(),
                            lines: list(&h["lines"])
                                .iter()
                                .map(|l| Line {
                                    kind: match l[0].as_str() { Some("+") => Kind::Added, Some("-") => Kind::Deleted, _ => Kind::Kept },
                                    old: l[1].as_u64().map(|n| n as usize),
                                    now: l[2].as_u64().map(|n| n as usize),
                                    text: l[3].as_str().unwrap_or("").to_string().into(),
                                })
                                .collect(),
                        })
                        .collect(),
                })
                .collect(),
        })
        .collect()
}

// The commits of an issue's steps, in order, from its page: what the diffs are read from.
pub fn commits(page: &Value) -> Vec<String> {
    fn walk(list: &Value, out: &mut Vec<String>) {
        for s in list.as_array().into_iter().flatten() {
            if let Some(c) = s["commit"].as_str() { out.push(c.to_string()) }
            walk(&s["kids"], out);
        }
    }
    let mut out = Vec::new();
    walk(&page["plan_steps"], &mut out);
    out
}

// A line's place in its file's rows that stays while more lines open round it: its hunk and its place there, or its
// number in the file once opened.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Key {
    Hunk(usize, usize),
    Open(usize),
}

// The lines a file's hunks leave out, in the file's numbers at the step's commit: one run above each hunk, then one under
// the last, down to the file's end. A run can be empty, as above a hunk that starts on line 1.
#[derive(Clone, Copy)]
struct Run {
    from: usize,
    to: usize, // to < from when empty
}

impl Run {
    fn size(&self) -> usize {
        (self.to + 1).saturating_sub(self.from)
    }
}

fn hidden_runs(f: &FileDiff, length: usize) -> Vec<Run> {
    let mut runs = Vec::new();
    let mut end = 0;
    for h in &f.hunks {
        let nows: Vec<usize> = h.lines.iter().filter_map(|l| l.now).collect();
        runs.push(Run { from: end + 1, to: nows.first().copied().unwrap_or(end + 1) - 1 });
        end = nows.last().copied().unwrap_or(end);
    }
    runs.push(Run { from: end + 1, to: length });
    runs
}

// What is open of a run: so many lines from its top, under the hunk above, and from its bottom, over the hunk below.
#[derive(Clone, Copy, Default)]
struct Opened {
    top: usize,
    bottom: usize,
}

// A file of a step: its step's commit and its path.
type At = (String, String);

// Lines picked to comment on, in one file: from where the pick started to where it ends, either way round. drag holds
// while the mouse is down.
#[derive(Clone, Copy, PartialEq)]
struct Picked {
    s: usize,
    f: usize,
    from: Key,
    to: Key,
    drag: bool,
}

// One row of the list. The rows are worked out again from the state whenever it changes, and only those that differ are
// drawn again.
#[derive(Clone, PartialEq)]
enum Row {
    Hint,
    Step { s: usize, open: bool },
    File { s: usize, f: usize, open: bool, whole: Option<bool> }, // whole: Some(lit) where Whole file can be pressed
    Quiet { s: usize, f: usize, words: &'static str },
    Hunk { s: usize, f: usize, n: usize }, // a hunk's dim row, where no hidden line can open
    Gap { s: usize, f: usize, k: usize, last: bool, left: usize, header: Option<usize> },
    Line { s: usize, f: usize, key: Key, stretch: usize, picked: bool },
    Comment { s: usize, f: usize },
}

#[derive(Clone, PartialEq)]
struct Shown {
    row: Row,
    end: bool, // the last row of its step's card
}

pub struct Changes {
    slug: String,
    chat: WeakEntity<Chat>,
    shown: bool,
    wanted: Option<Vec<String>>, // the commits the page names now, once it came
    loaded: Vec<String>, // those the diffs were read for
    loading: bool,
    steps: Option<Vec<StepDiff>>,
    error: Option<String>,
    open: HashSet<String>,   // the steps open, by place
    known: HashSet<String>,  // the steps seen, so a new one opens once
    folds: HashMap<At, bool>, // a file opened or folded by hand
    read: HashMap<At, Rc<Vec<SharedString>>>,
    opened: HashMap<At, Vec<Opened>>,
    picked: Option<Picked>,
    hovered: Option<(usize, usize, Key)>,
    down_at: Point<Pixels>,
    focus_box: bool,
    rows: Vec<Shown>,
    list: ListState,
    focus: FocusHandle,
    comment: Entity<TextareaState>,
    _subscriptions: Vec<Subscription>,
}

struct Colours {
    strong: Hsla,
    text: Hsla,
    quiet: Hsla,
    dim: Hsla,
    edge: Hsla,
    rule: Hsla,
    raised: Hsla,
    hover: Hsla,
    active: Hsla,
    panel: Hsla,
    accent: Hsla,
    add_bg: Hsla,
    add_edge: Hsla,
    add_text: Hsla,
    del_bg: Hsla,
    del_edge: Hsla,
    del_text: Hsla,
    number: Hsla,
    pick: Hsla,
    mono: SharedString,
}

// desk.css's --diff-* tokens, with the greys the half's cards take.
fn colours(cx: &App) -> Colours {
    let theme = cx.theme();
    let t = theme::text(cx);
    let c = |hex: u32| -> Hsla { rgb(hex).into() };
    let dark = theme.mode.is_dark();
    let pick: Hsla = if dark { rgba(0x5e69d138).into() } else { rgba(0x6d78d524).into() };
    let (add_bg, add_edge, add_text, del_bg, del_edge, del_text, number, active) = if dark {
        (c(0x1b271f), c(0x41ba56), c(0x3ee362), c(0x2f1f21), c(0xff6364), c(0xff8683), c(0x5c5d5f), c(0x29292b))
    } else {
        (c(0xf4fbf5), c(0x27a644), c(0x008e09), c(0xfef4f5), c(0xda3540), c(0xe2253b), c(0xa0a0a2), c(0xe1e1e2))
    };
    Colours {
        strong: t.strong,
        text: theme.foreground,
        quiet: theme.muted_foreground,
        dim: t.dim,
        edge: theme.border,
        rule: t.divider,
        raised: t.raised,
        hover: theme.accent,
        active,
        panel: theme.background,
        accent: t.accent,
        add_bg,
        add_edge,
        add_text,
        del_bg,
        del_edge,
        del_text,
        number,
        pick,
        mono: theme.mono_font_family.clone(),
    }
}

fn counts(added: u64, deleted: u64, size: f32, c: &Colours) -> Div {
    div()
        .h_flex()
        .flex_none()
        .gap(px(4.))
        .text_size(px(size))
        .child(div().text_color(c.add_text).child(format!("+{added}")))
        .child(div().text_color(c.del_text).child(format!("−{deleted}")))
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn fold(open: bool, colour: Hsla) -> Svg {
    theme::glyph(if open { "triangle-open" } else { "triangle" }, colour)
}

// A path for desk's query string.
fn encoded(text: &str) -> String {
    text.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~/".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

impl Changes {
    pub fn new(slug: String, chat: WeakEntity<Chat>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let comment = cx.new(|cx| TextareaState::new(window, cx).auto_grow(1, 8).submit_on_enter(true).placeholder("Leave a comment…"));
        let subscriptions = vec![cx.subscribe_in(&comment, window, |changes, _, event: &InputEvent, window, cx| match event {
            InputEvent::PressEnter { shift: false, .. } => changes.send(window, cx),
            InputEvent::Change => cx.notify(),
            _ => {}
        })];
        Self {
            slug,
            chat,
            shown: false,
            wanted: None,
            loaded: Vec::new(),
            loading: false,
            steps: None,
            error: None,
            open: HashSet::new(),
            known: HashSet::new(),
            folds: HashMap::new(),
            read: HashMap::new(),
            opened: HashMap::new(),
            picked: None,
            hovered: None,
            down_at: Point::default(),
            focus_box: false,
            rows: Vec::new(),
            list: ListState::new(0, ListAlignment::Top, px(400.)),
            focus: cx.focus_handle(),
            comment,
            _subscriptions: subscriptions,
        }
    }

    // The issue's page, again: its steps' commits, read again when they changed while the half shows them.
    pub fn page(&mut self, page: &Value, cx: &mut Context<Self>) {
        self.wanted = Some(commits(page));
        self.load(cx);
    }

    // Shown or hidden with the half: the diffs are read as it opens and let go as it closes.
    pub fn show(&mut self, shown: bool, cx: &mut Context<Self>) {
        if shown == self.shown { return }
        self.shown = shown;
        if shown {
            self.load(cx);
        } else {
            self.steps = None;
            self.loaded.clear();
            self.read.clear();
            self.opened.clear();
            self.picked = None;
            self.rebuild(cx);
        }
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        let Some(wanted) = self.wanted.clone() else { return };
        if !self.shown || self.loading || (self.steps.is_some() && self.loaded == wanted) { return }
        self.loading = true;
        let path = format!("/api/page/issue/{}/changes", self.slug);
        cx.spawn(async move |this, cx| {
            let got = cx.background_spawn(async move { net::get(&path).map(|page| parse(&page)) }).await;
            let _ = this.update(cx, |changes, cx| {
                changes.loading = false;
                if !changes.shown { return }
                match got {
                    Ok(steps) => {
                        // the newest step starts open, as the one to look at before saying "next"
                        if let Some(last) = steps.last() {
                            if !changes.known.contains(&last.place) { changes.open.insert(last.place.clone()); }
                        }
                        changes.known.extend(steps.iter().map(|s| s.place.clone()));
                        changes.steps = Some(steps);
                        changes.loaded = wanted;
                        changes.error = None;
                        changes.picked = None;
                        // new data under the same rows: all of them drawn again, the scroll kept
                        let count = changes.list.item_count();
                        changes.rows = changes.rows_of();
                        changes.list.splice(0..count, changes.rows.len());
                        cx.notify();
                    }
                    Err(error) => {
                        changes.error = Some(error);
                        cx.notify();
                    }
                }
                changes.load(cx); // the commits moved on while it read
            });
        })
        .detach();
    }

    fn at(&self, s: usize, f: usize) -> Option<At> {
        let step = self.steps.as_ref()?.get(s)?;
        Some((step.commit.clone(), step.files.get(f)?.path.clone()))
    }

    fn runs(f: &FileDiff) -> Option<Vec<Run>> {
        f.length.filter(|_| !f.cut).map(|length| hidden_runs(f, length))
    }

    fn hidden_left(&self, at: &At, runs: &[Run]) -> usize {
        let o = self.read.get(at).and(self.opened.get(at));
        runs.iter()
            .enumerate()
            .map(|(k, r)| r.size().saturating_sub(o.and_then(|o| o.get(k)).map(|o| o.top + o.bottom).unwrap_or(0)))
            .sum()
    }

    // The rows, top to bottom: the hint, then each step's card, its head and, while open, its files and their lines.
    fn rows_of(&self) -> Vec<Shown> {
        let mut out = Vec::new();
        let Some(steps) = &self.steps else { return out };
        if steps.is_empty() { return out }
        out.push(Shown { row: Row::Hint, end: false });
        for (s, step) in steps.iter().enumerate() {
            let open = self.open.contains(&step.place);
            out.push(Shown { row: Row::Step { s, open }, end: false });
            if open {
                for (f, file) in step.files.iter().enumerate() {
                    let at = (step.commit.clone(), file.path.clone());
                    let runs = Self::runs(file);
                    let can_whole = runs.as_ref().is_some_and(|r| file.length.unwrap_or(0) <= WHOLE_LINES && r.iter().any(|r| r.size() > 0));
                    let whole = can_whole && self.hidden_left(&at, runs.as_deref().unwrap_or(&[])) == 0;
                    let file_open = self.folds.get(&at).copied().unwrap_or(file.added + file.deleted <= OPEN_LINES);
                    out.push(Shown { row: Row::File { s, f, open: file_open, whole: can_whole.then_some(whole) }, end: false });
                    if !file_open { continue }
                    let quiet = |words| Shown { row: Row::Quiet { s, f, words }, end: false };
                    if file.binary {
                        out.push(quiet("A binary file: no lines to show."));
                    } else if file.hunks.is_empty() && !whole {
                        out.push(quiet(if file.was.is_some() { "Moved, unchanged." } else { "No lines changed." }));
                    } else {
                        self.lines(s, f, file, &at, runs.as_deref(), &mut out);
                    }
                    if file.cut { out.push(quiet("The rest of this file is cut: it changed too many lines to draw.")) }
                }
            }
            if let Some(last) = out.last_mut() { last.end = true }
        }
        out
    }

    // A file's lines, the hunks' and those opened round them, and between them the rows that still hide lines, or, where
    // none can open, each hunk's dim row. A row between ends a stretch of lines, and a pick stays inside one.
    fn lines(&self, s: usize, f: usize, file: &FileDiff, at: &At, runs: Option<&[Run]>, out: &mut Vec<Shown>) {
        let start = out.len();
        let opened = self.read.get(at).and(self.opened.get(at));
        let mut stretch = 0;
        let line = |key, stretch| Shown { row: Row::Line { s, f, key, stretch, picked: false }, end: false };
        let hidden = |out: &mut Vec<Shown>, stretch: &mut usize, k: usize, header: Option<usize>| {
            let Some(runs) = runs else { return };
            let r = runs[k];
            let size = r.size();
            if size == 0 { return }
            let o = opened.and_then(|o| o.get(k)).copied().unwrap_or_default();
            let top = o.top.min(size);
            let bottom = o.bottom.min(size - top);
            let left = size - top - bottom;
            out.extend((r.from..r.from + top).map(|n| line(Key::Open(n), *stretch)));
            if left > 0 {
                out.push(Shown { row: Row::Gap { s, f, k, last: k == runs.len() - 1, left, header }, end: false });
                *stretch += 1;
            }
            out.extend((r.to + 1 - bottom..=r.to).filter(|_| bottom > 0).map(|n| line(Key::Open(n), *stretch)));
        };
        for (n, h) in file.hunks.iter().enumerate() {
            if runs.is_some() {
                hidden(out, &mut stretch, n, Some(n));
            } else {
                out.push(Shown { row: Row::Hunk { s, f, n }, end: false });
                stretch += 1;
            }
            out.extend((0..h.lines.len()).map(|i| line(Key::Hunk(n, i), stretch)));
        }
        if let Some(runs) = runs { hidden(out, &mut stretch, runs.len() - 1, None) }

        // the pick, lit while both its ends show in one stretch, and the box under it once the mouse is up
        let Some(p) = self.picked.filter(|p| p.s == s && p.f == f) else { return };
        let find = |key: Key| out[start..].iter().position(|r| matches!(r.row, Row::Line { key: k, .. } if k == key)).map(|i| start + i);
        let stretch_at = |i: usize| match out[i].row { Row::Line { stretch, .. } => stretch, _ => usize::MAX };
        let (Some(a), Some(b)) = (find(p.from), find(p.to)) else { return };
        if stretch_at(a) != stretch_at(b) { return }
        let (a, b) = (a.min(b), a.max(b));
        for shown in &mut out[a..=b] {
            if let Row::Line { picked, .. } = &mut shown.row { *picked = true }
        }
        if !p.drag { out.insert(b + 1, Shown { row: Row::Comment { s, f }, end: false }) }
    }

    // The rows again, after the state changed: only those that differ are measured and drawn again.
    fn rebuild(&mut self, cx: &mut Context<Self>) {
        let rows = self.rows_of();
        let old = &self.rows;
        let first = old.iter().zip(&rows).take_while(|(a, b)| a == b).count();
        let same_end = old[first..].iter().rev().zip(rows[first..].iter().rev()).take_while(|(a, b)| a == b).count();
        if first < old.len() || first < rows.len() {
            self.list.splice(first..old.len() - same_end, rows.len() - same_end - first);
        }
        self.rows = rows;
        cx.notify();
    }

    fn line(&self, s: usize, f: usize, key: Key) -> Option<(Kind, Option<usize>, SharedString, bool)> {
        let step = self.steps.as_ref()?.get(s)?;
        let file = step.files.get(f)?;
        match key {
            Key::Hunk(n, i) => {
                let l = file.hunks.get(n)?.lines.get(i)?;
                Some((l.kind, if l.kind == Kind::Deleted { l.old } else { l.now }, l.text.clone(), false))
            }
            Key::Open(n) => {
                let lines = self.read.get(&(step.commit.clone(), file.path.clone()))?;
                Some((Kind::Kept, Some(n), lines.get(n - 1).cloned().unwrap_or_default(), true))
            }
        }
    }

    // A file as the step's commit left it, read the first time one of its hidden lines opens, then what to do with it.
    fn with_file(&mut self, at: At, cx: &mut Context<Self>, then: impl FnOnce(&mut Self) + 'static) {
        if self.read.contains_key(&at) {
            then(self);
            return self.rebuild(cx);
        }
        let path = format!("/api/page/issue/{}/changes/file?commit={}&path={}", self.slug, encoded(&at.0), encoded(&at.1));
        cx.spawn(async move |this, cx| {
            let got = cx.background_spawn(async move { net::get(&path) }).await;
            let _ = this.update(cx, |changes, cx| {
                match got {
                    Ok(page) => {
                        let lines = page["lines"].as_array().into_iter().flatten().map(|l| SharedString::from(l.as_str().unwrap_or("").to_string())).collect();
                        changes.read.insert(at, Rc::new(lines));
                        then(changes);
                    }
                    Err(error) => changes.error = Some(format!("Could not read {}: {error}", at.1)),
                }
                changes.rebuild(cx);
            });
        })
        .detach();
    }

    fn open_run(&mut self, s: usize, f: usize, k: usize, more: Opened, cx: &mut Context<Self>) {
        let Some(at) = self.at(s, f) else { return };
        let key = at.clone();
        self.with_file(at, cx, move |changes| {
            let all = changes.opened.entry(key).or_default();
            if all.len() <= k { all.resize(k + 1, Opened::default()) }
            all[k].top += more.top;
            all[k].bottom += more.bottom;
        });
    }

    // Whole file opens every run at once; pressed again it folds them all back, the ones the arrows opened too.
    fn whole(&mut self, s: usize, f: usize, lit: bool, cx: &mut Context<Self>) {
        let Some(at) = self.at(s, f) else { return };
        self.folds.insert(at.clone(), true);
        if lit {
            self.opened.remove(&at);
            return self.rebuild(cx);
        }
        let Some(runs) = self.steps.as_ref().and_then(|st| st.get(s)).and_then(|st| st.files.get(f)).and_then(Self::runs) else { return };
        let key = at.clone();
        self.with_file(at, cx, move |changes| {
            changes.opened.insert(key, runs.iter().map(|r| Opened { top: r.size(), bottom: 0 }).collect());
        });
    }

    fn stretch_of(&self, s: usize, f: usize, key: Key) -> Option<usize> {
        self.rows.iter().find_map(|r| match r.row {
            Row::Line { s: rs, f: rf, key: k, stretch, .. } if rs == s && rf == f && k == key => Some(stretch),
            _ => None,
        })
    }

    // The mouse down on a line's number: the line picked, or with Shift the range from the pick to it.
    fn pick_down(&mut self, s: usize, f: usize, key: Key, stretch: usize, e: &MouseDownEvent, cx: &mut Context<Self>) {
        self.down_at = e.position;
        let extend = self.picked.filter(|p| e.modifiers.shift && p.s == s && p.f == f && self.stretch_of(s, f, p.from) == Some(stretch));
        self.picked = Some(match extend {
            Some(p) => Picked { to: key, drag: true, ..p },
            None => Picked { s, f, from: key, to: key, drag: true },
        });
        self.rebuild(cx);
    }

    // The mouse over a line: while it drags along the numbers, the pick runs to it, in the stretch it started in. A
    // mouse that has not moved since it went down does not drag, though the rows moved under it as the old box went.
    fn hover_line(&mut self, s: usize, f: usize, key: Key, stretch: usize, on: bool, window: &Window, cx: &mut Context<Self>) {
        if !on {
            if self.hovered == Some((s, f, key)) { self.hovered = None }
            return;
        }
        self.hovered = Some((s, f, key));
        let Some(p) = self.picked else { return };
        if !p.drag || p.s != s || p.f != f || p.to == key || window.mouse_position() == self.down_at { return }
        if self.stretch_of(s, f, p.from) != Some(stretch) { return }
        self.picked = Some(Picked { to: key, ..p });
        self.rebuild(cx);
    }

    fn mouse_up(&mut self, cx: &mut Context<Self>) {
        if let Some(p) = self.picked.filter(|p| p.drag) {
            self.picked = Some(Picked { drag: false, ..p });
            self.focus_box = true;
            self.rebuild(cx);
        }
    }

    // C on a line picks it and opens the box under it, as a click on its number does.
    fn pick_hovered(&mut self, cx: &mut Context<Self>) {
        let Some((s, f, key)) = self.hovered else { return };
        let lit = self.rows.iter().any(|r| matches!(r.row, Row::Line { s: rs, f: rf, key: k, picked: true, .. } if rs == s && rf == f && k == key));
        if !lit { self.picked = Some(Picked { s, f, from: key, to: key, drag: false }) }
        self.focus_box = true;
        self.rebuild(cx);
    }

    fn drop_pick(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.picked.is_none() { return false }
        self.picked = None;
        self.comment.update(cx, |c, cx| c.set_value("", window, cx));
        self.rebuild(cx);
        true
    }

    // The picked lines quoted for the chat, as the steps rule tells a session to read them (prompts.ts): "Step 2.1,
    // apps/server/src/api.ts:222", then the lines in a diff block; then the words under them.
    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let words = self.comment.read(cx).value().trim().to_string();
        if words.is_empty() { return }
        let Some(message) = self.message(&words) else { return };
        let _ = self.chat.update(cx, |chat, cx| chat.say(message, Vec::new(), cx));
        self.drop_pick(window, cx);
    }

    fn message(&self, words: &str) -> Option<String> {
        let p = self.picked?;
        let step = self.steps.as_ref()?.get(p.s)?;
        let file = step.files.get(p.f)?;
        let lines: Vec<(Kind, Option<usize>, SharedString, bool)> = self
            .rows
            .iter()
            .filter_map(|r| match r.row {
                Row::Line { s, f, key, picked: true, .. } if s == p.s && f == p.f => self.line(s, f, key),
                _ => None,
            })
            .collect();
        let (first, last) = (lines.first()?, lines.last()?);
        let (from, to) = (first.1.unwrap_or(0), last.1.unwrap_or(0));
        let range = if from == to { from.to_string() } else { format!("{from}-{to}") };
        let body: Vec<String> = lines
            .iter()
            .map(|(kind, _, text, _)| format!("{}{text}", match kind { Kind::Added => '+', Kind::Deleted => '-', Kind::Kept => ' ' }))
            .collect();
        Some(format!("Step {}, {}:{range}\n```diff\n{}\n```\n{words}", step.place, file.path, body.join("\n")))
    }

    // A row of a step's card: its share of the card's hairline and corners.
    fn slice(&self, top: bool, end: bool, hair: Pixels, c: &Colours) -> Div {
        div()
            .w_full()
            .border_l(hair)
            .border_r(hair)
            .border_color(c.edge)
            .when(top, |d| d.border_t(hair).rounded_t(px(10.)))
            .when(end, |d| d.border_b(hair).rounded_b(px(10.)))
    }

    fn row(&mut self, i: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(shown) = self.rows.get(i).cloned() else { return div().into_any_element() };
        let c = colours(cx);
        let hair = px(1. / window.scale_factor());
        let end = shown.end;
        let inner: AnyElement = match shown.row {
            Row::Hint => div()
                .pb(px(4.))
                .text_size(px(12.))
                .text_color(c.quiet)
                .child("Click a line’s number to comment on it, or drag along the numbers for a range; C picks the line you point at.")
                .into_any_element(),
            Row::Step { s, open } => self.step_head(s, open, end, hair, &c, cx),
            Row::File { s, f, open, whole } => self.file_head(s, f, open, whole, end, hair, &c, cx),
            Row::Quiet { words, .. } => self.slice(false, end, hair, &c).px(px(16.)).py(px(10.)).text_size(px(12.)).text_color(c.quiet).child(words).into_any_element(),
            Row::Hunk { s, f, n } => {
                let header = self.steps.as_ref().and_then(|st| st.get(s)?.files.get(f)?.hunks.get(n).map(|h| h.header.clone())).unwrap_or_default();
                self.slice(false, end, hair, &c)
                    .child(
                        div()
                            .border_t(hair)
                            .border_color(c.rule)
                            .pl(px(48.))
                            .pr(px(12.))
                            .py(px(4.))
                            .font_family(c.mono.clone())
                            .text_size(px(11.))
                            .text_color(c.dim)
                            .whitespace_nowrap()
                            .overflow_hidden()
                            .text_ellipsis()
                            .child(if header.is_empty() { SharedString::from(" ") } else { header }),
                    )
                    .into_any_element()
            }
            Row::Gap { s, f, k, last, left, header } => self.gap(s, f, k, last, left, header, end, hair, &c, cx),
            Row::Line { s, f, key, stretch, picked } => self.line_row(s, f, key, stretch, picked, end, hair, &c, cx),
            Row::Comment { .. } => self.comment_box(end, hair, &c, window, cx),
        };
        div()
            .w_full()
            .flex()
            .justify_center()
            .px(px(20.))
            .when(end, |d| d.pb(px(8.)))
            .child(div().w_full().max_w(px(CARDS)).child(inner))
            .into_any_element()
    }

    // A step's card head: its place, title and note, how much it changed; a click folds or opens it.
    fn step_head(&self, s: usize, open: bool, end: bool, hair: Pixels, c: &Colours, cx: &mut Context<Self>) -> AnyElement {
        let Some(step) = self.steps.as_ref().and_then(|st| st.get(s)) else { return div().into_any_element() };
        let place = step.place.clone();
        self.slice(true, end, hair, c)
            .id(("change-step", s))
            .h_flex()
            .h(px(40.))
            .pl(px(6.))
            .pr(px(12.))
            .gap(px(8.))
            .text_size(px(13.))
            .font_medium()
            .text_color(c.text)
            .cursor_pointer()
            .hover(|d| d.bg(c.hover))
            .when(open, |d| d.border_b(hair))
            .on_click(cx.listener(move |changes, _, _, cx| {
                if !changes.open.remove(&place) { changes.open.insert(place.clone()); }
                changes.rebuild(cx);
            }))
            .child(fold(open, c.dim))
            .child(theme::state_icon(&step.state, cx))
            .child(div().flex_none().font_family(c.mono.clone()).font_normal().text_size(px(12.)).text_color(c.dim).child(step.place.clone()))
            .child(div().min_w_0().max_w(relative(0.55)).truncate().text_color(c.strong).child(step.title.clone()))
            .child(div().flex_1().min_w_0().truncate().font_normal().text_size(px(12.)).text_color(c.quiet).child(step.note.clone()))
            .child(div().flex_none().font_normal().text_size(px(12.)).text_color(c.quiet).child(plural(step.files.len(), "file", "files")))
            .child(counts(step.added, step.deleted, 11., c).font_normal())
            .into_any_element()
    }

    // A file's head: its name, then its folder or where it moved from, how much changed; Whole file, where it has one.
    #[allow(clippy::too_many_arguments)]
    fn file_head(&self, s: usize, f: usize, open: bool, whole: Option<bool>, end: bool, hair: Pixels, c: &Colours, cx: &mut Context<Self>) -> AnyElement {
        let Some(step) = self.steps.as_ref().and_then(|st| st.get(s)) else { return div().into_any_element() };
        let Some(file) = step.files.get(f) else { return div().into_any_element() };
        let at: At = (step.commit.clone(), file.path.clone());
        let (dir, name) = match file.path.rfind('/') { Some(n) => (&file.path[..=n], &file.path[n + 1..]), None => ("", file.path.as_str()) };
        let dir = file.was.as_ref().map(|w| format!("from {w}")).unwrap_or_else(|| dir.to_string());
        self.slice(false, end, hair, c)
            .h_flex()
            .h(px(32.))
            .bg(c.raised)
            .text_size(px(12.))
            .text_color(c.text)
            .when(f > 0, |d| d.border_t(hair).border_color(c.rule))
            .when(whole.is_some(), |d| d.pr(px(4.)))
            .child(
                div()
                    .id(("change-file", s * 10_000 + f))
                    .h_flex()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .pl(px(22.))
                    .pr(px(if whole.is_some() { 0. } else { 12. }))
                    .gap(px(8.))
                    .cursor_pointer()
                    .on_click(cx.listener(move |changes, _, _, cx| {
                        changes.folds.insert(at.clone(), !open);
                        changes.rebuild(cx);
                    }))
                    .child(fold(open, c.dim))
                    .child(div().flex_none().text_color(c.strong).child(name.to_string()))
                    .child(div().flex_1().min_w_0().truncate().text_color(c.quiet).child(dir))
                    .child(counts(file.added, file.deleted, 11., c)),
            )
            .when_some(whole, |d, lit| {
                d.child(
                    div()
                        .id(("change-whole", s * 10_000 + f))
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .size(px(24.))
                        .rounded(px(6.))
                        .cursor_pointer()
                        .when(lit, |b| b.bg(c.active))
                        .hover(|b| b.bg(c.active))
                        .on_click(cx.listener(move |changes, _, _, cx| changes.whole(s, f, lit, cx)))
                        .child(theme::glyph("whole-file", if lit { c.strong } else { c.quiet })),
                )
            })
            .into_any_element()
    }

    // A row of hidden lines, opened as GitHub opens them: ↓ opens 20 under the hunk above, ↑ 20 over the hunk below, and
    // ↕ the rest once 20 or fewer are left; above the first hunk there is only ↑, under the last only ↓.
    #[allow(clippy::too_many_arguments)]
    fn gap(&self, s: usize, f: usize, k: usize, last: bool, left: usize, header: Option<usize>, end: bool, hair: Pixels, c: &Colours, cx: &mut Context<Self>) -> AnyElement {
        let header = header
            .and_then(|n| self.steps.as_ref()?.get(s)?.files.get(f)?.hunks.get(n).map(|h| h.header.clone()))
            .unwrap_or_default();
        let arrow = |glyph: &'static str, more: Opened, cx: &mut Context<Self>| {
            div()
                .id(SharedString::from(format!("gap-{s}-{f}-{k}-{glyph}")))
                .group("diff-arrow")
                .flex()
                .items_center()
                .justify_center()
                .w_full()
                .h(px(22.))
                .cursor_pointer()
                .hover(|d| d.bg(c.hover))
                .on_click(cx.listener(move |changes, _, _, cx| changes.open_run(s, f, k, more, cx)))
                .child(theme::glyph(glyph, c.quiet).group_hover("diff-arrow", |g| g.text_color(c.strong)))
        };
        let mut arrows = div().v_flex().flex_none().w(px(48.)).py(px(1.));
        if left <= MORE_LINES {
            let more = if k == 0 { Opened { top: 0, bottom: left } } else { Opened { top: left, bottom: 0 } };
            arrows = arrows.child(arrow("open-all", more, cx));
        } else {
            if k > 0 { arrows = arrows.child(arrow("open-down", Opened { top: MORE_LINES, bottom: 0 }, cx)) }
            if !last { arrows = arrows.child(arrow("open-up", Opened { top: 0, bottom: MORE_LINES }, cx)) }
        }
        self.slice(false, end, hair, c)
            .child(
                div()
                    .h_flex()
                    .border_t(hair)
                    .border_b(hair)
                    .border_color(c.rule)
                    .child(arrows)
                    .child(
                        div()
                            .h_flex()
                            .flex_1()
                            .min_w_0()
                            .pr(px(12.))
                            .gap(px(12.))
                            .text_size(px(11.))
                            .text_color(c.dim)
                            .child(div().flex_1().min_w_0().font_family(c.mono.clone()).whitespace_nowrap().overflow_hidden().text_ellipsis().child(header))
                            .child(div().flex_none().child(format!("{left} hidden {}", if left == 1 { "line" } else { "lines" }))),
                    ),
            )
            .into_any_element()
    }

    // A line of a file: its number, which picks it, and its code, tinted with a coloured edge where it was added or
    // deleted, lit while picked; under the mouse a + stands on its number's edge, as GitHub's does.
    #[allow(clippy::too_many_arguments)]
    fn line_row(&self, s: usize, f: usize, key: Key, stretch: usize, picked: bool, end: bool, hair: Pixels, c: &Colours, cx: &mut Context<Self>) -> AnyElement {
        let Some((kind, number, text, _)) = self.line(s, f, key) else { return div().into_any_element() };
        let (tint, edge) = match kind {
            Kind::Added => (Some(c.add_bg), c.add_edge),
            Kind::Deleted => (Some(c.del_bg), c.del_edge),
            Kind::Kept => (None, transparent_black()),
        };
        let bg = if picked { Some(tint.unwrap_or(c.panel).blend(c.pick)) } else { tint };
        let text = if text.contains('\t') { SharedString::from(text.replace('\t', "    ")) } else { text };
        let id = match key { Key::Hunk(n, i) => format!("l-{s}-{f}-h{n}.{i}"), Key::Open(n) => format!("l-{s}-{f}-o{n}") };
        let down = cx.listener(move |changes, e: &MouseDownEvent, _, cx| {
            cx.stop_propagation();
            changes.pick_down(s, f, key, stretch, e, cx)
        });
        self.slice(false, end, hair, c)
            .id(SharedString::from(id))
            .group("diff-line")
            .relative()
            .h_flex()
            .items_start()
            .font_family(c.mono.clone())
            .font_features(FontFeatures::disable_ligatures()) // -> stays two characters, as code is typed
            .text_size(px(13.))
            .line_height(px(LINE))
            .when_some(bg, |d, bg| d.bg(bg))
            .on_hover(cx.listener(move |changes, on: &bool, window, cx| changes.hover_line(s, f, key, stretch, *on, window, cx)))
            .child(
                div()
                    .flex()
                    .flex_none()
                    .justify_end()
                    .w(px(48.))
                    .pr(px(16.))
                    .border_l_1()
                    .border_color(if picked { c.accent } else { edge })
                    .text_color(if picked { c.strong } else { c.number })
                    .group_hover("diff-line", |d| d.text_color(c.strong))
                    .cursor_pointer()
                    .on_mouse_down(MouseButton::Left, down)
                    .child(number.map(|n| n.to_string()).unwrap_or_default()),
            )
            .child(div().flex_1().min_w_0().min_h(px(LINE)).pr(px(12.)).text_color(c.text).child(text))
            .child(
                div()
                    .absolute()
                    .top(px(1.))
                    .left(px(39.))
                    .size(px(18.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(4.))
                    .bg(c.accent)
                    .text_color(rgb(0xffffff))
                    .font_family(cx.theme().font_family.clone())
                    .text_size(px(14.))
                    .font_medium()
                    .opacity(0.)
                    .group_hover("diff-line", |d| d.opacity(1.))
                    .cursor_pointer()
                    .on_mouse_down(MouseButton::Left, cx.listener(move |changes, e: &MouseDownEvent, _, cx| {
                        cx.stop_propagation();
                        changes.pick_down(s, f, key, stretch, e, cx)
                    }))
                    .child("+"),
            )
            .into_any_element()
    }

    // The box under the picked lines: the chat's reply box, lined up with the code. Enter sends, Esc drops the pick.
    fn comment_box(&mut self, end: bool, hair: Pixels, c: &Colours, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let empty = self.comment.read(cx).value().trim().is_empty();
        let focused = self.comment.read(cx).focus_handle(cx).is_focused(window);
        let primary = cx.theme().primary;
        let t = theme::text(cx);
        self.slice(false, end, hair, c)
            .pl(px(48.))
            .pr(px(12.))
            .pt(px(8.))
            .pb(px(10.))
            .child(
                div()
                    .v_flex()
                    .pl_3()
                    .pr_2()
                    .pt(px(10.))
                    .pb(px(6.))
                    .rounded(px(14.))
                    .border_1()
                    .border_color(if focused { t.edge } else { c.edge })
                    .bg(c.raised)
                    .child(Textarea::new(&self.comment).appearance(false).text_size(px(13.)))
                    .child(
                        div().h_flex().justify_end().mt(px(6.)).child(
                            div()
                                .id("comment-send")
                                .flex()
                                .items_center()
                                .justify_center()
                                .size(px(28.))
                                .rounded_full()
                                .bg(primary)
                                .cursor_pointer()
                                .when(empty, |b| b.opacity(0.35))
                                .on_click(cx.listener(|changes, _, window, cx| changes.send(window, cx)))
                                .child(theme::glyph("send", t.on_primary).size(px(14.))),
                        ),
                    ),
            )
            .into_any_element()
    }
}

impl Render for Changes {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if std::mem::take(&mut self.focus_box) {
            self.comment.update(cx, |c, cx| c.focus(window, cx));
        }
        let c = colours(cx);
        let steps = self.steps.as_deref().unwrap_or(&[]);
        let files: HashSet<&str> = steps.iter().flat_map(|s| s.files.iter().map(|f| f.path.as_str())).collect();
        let added = steps.iter().map(|s| s.added).sum();
        let deleted = steps.iter().map(|s| s.deleted).sum();
        let head = div()
            .h_flex()
            .flex_none()
            .h(px(44.))
            .px(px(20.))
            .gap(px(8.))
            .font_medium()
            .text_color(c.text)
            .child("Changes")
            .when(!steps.is_empty(), |h| {
                h.child(
                    div()
                        .h_flex()
                        .ml_auto()
                        .gap(px(8.))
                        .font_normal()
                        .text_color(c.dim)
                        .child(format!("{} · {}", plural(steps.len(), "step", "steps"), plural(files.len(), "file", "files")))
                        .child(counts(added, deleted, 12., &c)),
                )
            });
        let quiet = |words: String| div().mx(px(12.)).my(px(48.)).text_center().text_color(c.quiet).child(words);
        let body = match (&self.steps, &self.error) {
            (None, Some(error)) => quiet(error.clone()).into_any_element(),
            (None, None) => quiet("Reading the changes…".into()).into_any_element(),
            (Some(steps), _) if steps.is_empty() => quiet("No step has sent its commit yet.".into()).into_any_element(),
            _ => list(self.list.clone(), cx.processor(|changes, i, window, cx| changes.row(i, window, cx))).flex_1().min_h_0().into_any_element(),
        };
        div()
            .id("changes")
            .v_flex()
            .size_full()
            .track_focus(&self.focus)
            .on_mouse_down(MouseButton::Left, cx.listener(|changes, _, window, cx| {
                if !changes.focus.contains_focused(window, cx) { window.focus(&changes.focus, cx) }
            }))
            .on_mouse_up(MouseButton::Left, cx.listener(|changes, _, _, cx| changes.mouse_up(cx)))
            .on_mouse_up_out(MouseButton::Left, cx.listener(|changes, _, _, cx| changes.mouse_up(cx)))
            .on_key_down(cx.listener(|changes, e: &KeyDownEvent, window, cx| {
                let k = &e.keystroke;
                let bare = !k.modifiers.control && !k.modifiers.alt && !k.modifiers.shift && !k.modifiers.platform;
                if k.key == "escape" && changes.drop_pick(window, cx) {
                    cx.stop_propagation();
                } else if k.key == "c" && bare && changes.focus.is_focused(window) {
                    changes.pick_hovered(cx);
                    cx.stop_propagation();
                }
            }))
            .child(head)
            .when_some(self.error.clone().filter(|_| self.steps.is_some()), |d, error| d.child(div().px(px(20.)).pb_2().text_xs().text_color(theme::text(cx).waiting).child(error)))
            .child(body)
    }
}
