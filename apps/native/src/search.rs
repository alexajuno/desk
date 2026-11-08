// The search, one box for everything over the page you are on, as the web's (search/SearchBox.tsx; desk.css's
// .menu.command.search): 720px wide, 13% down the window, with no dimming. Under what you type, a tab per kind with how
// many it found, dimmed when it found none; Tab and Shift Tab walk them, and a kind's first letter then Tab goes to its
// tab, a for All. All shows a group per kind, Chats first, each its best 5 under a heading that opens its tab; before
// anything is typed, each tab lists what is live. The server finds every kind but the settings (pages.ts, searchPage),
// which the window finds itself; a chat's title is found here on each key, from the list of chats kept since the window
// started, and what the server finds besides joins below it, never moving the row in focus (the web's chats.ts). The
// arrows move, Enter opens the thing where it lives, and Esc or a click outside closes the box, leaving you where you
// were. / and the sidebar's Search open it on Chats with nothing typed, the kind searched most.
use std::time::{Duration, Instant};

use gpui_kit::base::StyledExt;
use gpui_kit::component::ActiveTheme;
use gpui_kit::component::input::{Enter, Escape, IndentInline, Input, InputEvent, InputState, MoveDown, MoveUp, OutdentInline};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;

use crate::filters::{colours, modal_shadow};
use crate::settings::{self, Section};
use crate::{net, picker, theme};

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Chats,
    Issues,
    Projects,
    Teams,
    Milestones,
    Settings,
}

const KINDS: [Kind; 6] = [Kind::Chats, Kind::Issues, Kind::Projects, Kind::Teams, Kind::Milestones, Kind::Settings];

impl Kind {
    fn key(self) -> &'static str {
        match self {
            Kind::Chats => "chats",
            Kind::Issues => "issues",
            Kind::Projects => "projects",
            Kind::Teams => "teams",
            Kind::Milestones => "milestones",
            Kind::Settings => "settings",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Kind::Chats => "Chats",
            Kind::Issues => "Issues",
            Kind::Projects => "Projects",
            Kind::Teams => "Teams",
            Kind::Milestones => "Milestones",
            Kind::Settings => "Settings",
        }
    }

    fn of(key: &str) -> Option<Kind> {
        KINDS.into_iter().find(|k| k.key() == key)
    }
}

const BEST: usize = 5; // each group's rows in All
const CHATS_WAIT: u64 = 300; // ms the keys must stop for before the server is asked, longest for chats, whose titles are listed
const WAIT: u64 = 100;

// --- what the window keeps between openings -------------------------------------------------------------------------

#[derive(Clone)]
struct ChatRow {
    id: String,
    title: String,
    folded: Vec<char>, // its title folded, a letter for a letter, so that a match in it marks the title
    folder: String,
    age: String,
    issue: Value,
}

// Each kind's fields as the server's fields.ts names them, and every chat as sessions.catalog lists it: asked for as the
// window starts and again as the box opens, while the box draws what it already has.
#[derive(Default)]
struct Kept {
    fields: Value,
    chats: Vec<ChatRow>,
    asking: bool,
}

impl Global for Kept {}

pub fn load(cx: &mut App) {
    let kept = cx.default_global::<Kept>();
    if kept.asking { return }
    kept.asking = true;
    cx.spawn(async move |cx| {
        let answers = cx.background_spawn(async { (net::get("/api/page/search/chats"), net::get("/api/page/search/fields")) }).await;
        cx.update(|cx| {
            let kept = cx.default_global::<Kept>();
            kept.asking = false;
            if let Ok(v) = answers.0 {
                kept.chats = v["chats"].as_array().into_iter().flatten().map(|c| {
                    let title = c["title"].as_str().unwrap_or("").to_string();
                    ChatRow { folded: fold(&title), title, id: text(c, "id"), folder: text(c, "folder"), age: text(c, "age"), issue: c["issue"].clone() }
                }).collect();
            }
            if let Ok(v) = answers.1 { kept.fields = v }
            cx.refresh_windows();
        });
    })
    .detach();
}

fn text(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or("").to_string()
}

// --- finding words, as the server does (sessiontext.ts, search.ts) ---------------------------------------------------

// One letter's fold, one for one: its case and accents taken off. đ has no decomposition, so Vietnamese needs it by hand.
fn fold_char(c: char) -> char {
    if c.is_ascii() { return c.to_ascii_lowercase() }
    if c == 'đ' || c == 'Đ' { return 'd' }
    let base = c.nfd().next().unwrap_or(c);
    base.to_lowercase().next().unwrap_or(base)
}

fn fold(text: &str) -> Vec<char> {
    text.chars().map(fold_char).collect()
}

// The words to find: each run of letters and digits, folded.
fn words_of(text: &str) -> Vec<Vec<char>> {
    fold(text).split(|c| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(<[char]>::to_vec).collect()
}

// Where every word is found where a word starts, in letters, or None when one is missing.
fn spans(folded: &[char], words: &[Vec<char>]) -> Option<Vec<(usize, usize)>> {
    let mut out = Vec::new();
    for w in words {
        let n = w.len();
        if n > folded.len() { return None }
        let before = out.len();
        for i in 0..=folded.len() - n {
            let starts = i == 0 || !(folded[i - 1].is_alphanumeric() || folded[i - 1] == '_');
            if starts && folded[i..i + n] == w[..] { out.push((i, i + n)) }
        }
        if out.len() == before { return None }
    }
    out.sort();
    Some(out)
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&#34;").replace('\'', "&#39;")
}

// The text as HTML with the spans found marked, as the server's hits are.
fn marked(text: &str, found: &[(usize, usize)]) -> String {
    let chars: Vec<char> = text.chars().collect();
    let piece = |a: usize, b: usize| escape(&chars[a..b].iter().collect::<String>());
    let (mut out, mut at) = (String::new(), 0);
    for &(start, end) in found {
        if end <= at { continue }
        let from = start.max(at);
        out += &piece(at, from);
        out += &format!("<mark>{}</mark>", piece(from, end));
        at = end;
    }
    out + &piece(at, chars.len())
}

// A hit's HTML as text, and the byte ranges of its marked words.
fn unmark(html: &str) -> (String, Vec<std::ops::Range<usize>>) {
    let (mut text, mut marks, mut start, mut rest) = (String::new(), Vec::new(), None, html);
    while let Some(c) = rest.chars().next() {
        if let Some(r) = rest.strip_prefix("<mark>") { start = Some(text.len()); rest = r; continue }
        if let Some(r) = rest.strip_prefix("</mark>") {
            if let Some(s) = start.take() { marks.push(s..text.len()) }
            rest = r;
            continue;
        }
        if c == '&' {
            if let Some(end) = rest.find(';').filter(|e| *e <= 8) {
                let name = &rest[1..end];
                let decoded = match name {
                    "amp" => Some('&'), "lt" => Some('<'), "gt" => Some('>'), "quot" => Some('"'), "apos" => Some('\''),
                    _ => name.strip_prefix('#').and_then(|n| n.parse::<u32>().ok()).and_then(char::from_u32),
                };
                if let Some(d) = decoded {
                    text.push(d);
                    rest = &rest[end + 1..];
                    continue;
                }
            }
        }
        text.push(c);
        rest = &rest[c.len_utf8()..];
    }
    (text, marks)
}

// The first `limit` chats whose title holds every word, in the order the server lists them, and how many in all; with no
// word, all of them.
fn find_chats(rows: &[ChatRow], words: &str, limit: usize) -> (usize, Vec<Value>) {
    let words = words_of(words);
    let found: Vec<(&ChatRow, Vec<(usize, usize)>)> = rows.iter().filter_map(|c| spans(&c.folded, &words).map(|s| (c, s))).collect();
    let hits = found.iter().take(limit).map(|(c, s)| json!({
        "kind": "chat", "here": true, "key": format!("chat/{}", c.id), "session": c.id, "title": marked(&c.title, s), "snippet": "",
        "folder": c.folder, "age": c.age, "issue": c.issue,
    })).collect();
    (found.len(), hits)
}

// Settings, which the window finds itself, since their names are its own: a setting is found when its name, what its row
// says, its card's heading or its page's name holds every word, those whose name holds them all first. A filter leaves
// them all out, since a setting has no fields.
fn find_settings(words: &str, filtered: bool) -> Vec<Value> {
    if filtered { return Vec::new() }
    let words = words_of(words);
    let (mut named, mut rest) = (Vec::new(), Vec::new());
    for (section, heading, id) in settings::SETTINGS {
        let (title, about) = settings::about(id);
        let page = section.title();
        let (in_title, in_about, around) = (fold(title), fold(about), fold(&format!("{about} {heading} {page}")));
        let missing: Vec<&Vec<char>> = words.iter().filter(|w| spans(&in_title, std::slice::from_ref(*w)).is_none()).collect();
        if !missing.iter().all(|w| spans(&around, std::slice::from_ref(*w)).is_some()) { continue }
        let title_spans: Vec<(usize, usize)> = words.iter().filter_map(|w| spans(&in_title, std::slice::from_ref(w))).flatten().collect();
        let about_spans: Vec<(usize, usize)> = words.iter().filter_map(|w| spans(&in_about, std::slice::from_ref(w))).flatten().collect();
        let snippet = if missing.iter().any(|w| spans(&in_about, std::slice::from_ref(*w)).is_some()) { marked(about, &sorted(about_spans)) } else { String::new() };
        let page_key = if section == Section::Preferences { "preferences" } else { "workflow" };
        let hit = json!({ "kind": "setting", "key": format!("setting/{id}"), "title": marked(title, &sorted(title_spans)), "snippet": snippet,
            "section": page, "page": page_key });
        if missing.is_empty() { named.push(hit) } else { rest.push(hit) }
    }
    named.extend(rest);
    named
}

fn sorted(mut v: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    v.sort();
    v
}

// --- filters typed as key:value (fields.ts) ---------------------------------------------------------------------------

// A filter as typed: `-` before it is "is not", and a comma between values "either".
#[derive(Clone, PartialEq)]
pub struct Filter {
    pub not: bool,
    pub key: String,
    pub values: Vec<String>,
}

fn filter_of(text: &str) -> Option<Filter> {
    let token = regex::Regex::new(r"(?i)^(-?)([a-z_]+(?:\.[a-z_]+)?):(.*)$").expect("a fixed pattern");
    let m = token.captures(text)?;
    let values: Vec<String> = m[3].split(',').filter(|v| !v.is_empty()).map(str::to_string).collect();
    (!values.is_empty()).then(|| Filter { not: !m[1].is_empty(), key: m[2].to_lowercase(), values })
}

fn text_of(f: &Filter) -> String {
    format!("{}{}:{}", if f.not { "-" } else { "" }, f.key, f.values.join(","))
}

// A key's field: the tab's kind's, or in All any kind's.
fn field_of<'a>(fields: &'a Value, kind: Option<Kind>, key: &str) -> Option<&'a Value> {
    let kinds: Vec<Kind> = kind.map(|k| vec![k]).unwrap_or(KINDS.to_vec());
    kinds.iter().flat_map(|k| fields[k.key()].as_array().into_iter().flatten()).find(|f| f["name"] == key)
}

// Every kind's fields of that name, the tab's kind's first: state is an issue's, a chat's and a team's.
fn fields_named(fields: &Value, kind: Option<Kind>, key: &str) -> Vec<Value> {
    let mut kinds = KINDS.to_vec();
    kinds.sort_by_key(|k| Some(*k) != kind);
    kinds.iter().flat_map(|k| fields[k.key()].as_array().cloned().unwrap_or_default()).filter(|f| f["name"] == key).collect()
}

// The first of each name, in order: in All, state is Chats' before Teams'.
fn first_by(all: Vec<Value>, name: impl Fn(&Value) -> String) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    all.into_iter().filter(|v| seen.insert(name(v))).collect()
}

fn name(f: &Value) -> String {
    text(f, "name")
}

// What a field's row says at its right: its first values, or the kind of value it takes.
fn hint(f: &Value) -> String {
    match f["type"].as_str().unwrap_or("set") {
        "date" => "a day".into(),
        "number" => "a number".into(),
        _ => {
            let values = f["values"].as_array().cloned().unwrap_or_default();
            let first: Vec<String> = values.iter().take(4).map(|v| text(v, "value")).collect();
            first.join(", ") + if values.len() > 4 { ", …" } else { "" }
        }
    }
}

// What the menu under the caret offers: the fields a word's first two letters start, the tab's kind's or in All every
// kind's, with issue. for a chat's issue's own; after issue., those; after a colon, the field's values the letters after it
// start, then those that hold them, the ones typed already left out. A date offers today, before it and after it. Each
// offer is the whole filter it leaves typed: a field's name and its colon, or the filter with its value.
struct Offer {
    take: String,
    name: String,
    label: String,
    icon: Option<String>,
    value: bool,
}

struct Menu {
    start: usize, // where the word starts, in bytes
    typed: String,
    heading: String,
    offers: Vec<Offer>,
}

const DATES: [(&str, &str); 3] = [("today", "today"), ("<today", "before today"), (">today", "after today")];

fn menu_at(typed_all: &str, caret: Option<usize>, fields: &Value, kind: Option<Kind>) -> Option<Menu> {
    let all = typed_all;
    let caret = caret.filter(|c| *c <= all.len() && all.is_char_boundary(*c))?;
    if all[caret..].chars().next().is_some_and(|c| !c.is_whitespace()) { return None } // inside a word
    let start = all[..caret].char_indices().rev().find(|(_, c)| c.is_whitespace()).map(|(i, c)| i + c.len_utf8()).unwrap_or(0);
    let typed = &all[start..caret];
    let m = regex::Regex::new(r"(?i)^(-?)([a-z_]*(?:\.[a-z_]*)?)(?::(.*))?$").expect("a fixed pattern").captures(typed)?;
    let (not, key) = (m[1].to_string(), m[2].to_lowercase());
    let menu = |heading: String, offers: Vec<Offer>| (!offers.is_empty()).then(|| Menu { start, typed: typed.to_string(), heading, offers });
    let Some(after) = m.get(3) else {
        if key.len() < 2 { return None } // one letter picks a kind
        let kinds = kind.map(|k| vec![k]).unwrap_or(KINDS.to_vec());
        let own = first_by(kinds.iter().flat_map(|k| fields[k.key()].as_array().cloned().unwrap_or_default()).collect(), name);
        let dot = key.find('.');
        let mut offers: Vec<Offer> = own.iter().filter(|f| name(f).starts_with(&key) && name(f).contains('.') == dot.is_some())
            .map(|f| Offer { take: format!("{not}{}:", name(f)), name: format!("{}:", &name(f)[dot.map(|d| d + 1).unwrap_or(0)..]), label: hint(f), icon: None, value: false })
            .collect();
        let its: Vec<String> = own.iter().map(name).filter(|n| n.starts_with("issue.")).map(|n| n[6..].to_string()).collect();
        if dot.is_none() && !its.is_empty() && "issue.".starts_with(&key) {
            offers.push(Offer { take: format!("{not}issue."), name: "issue.".into(), label: its.join(", "), icon: None, value: false });
        }
        return menu(match dot { None => kind.map(Kind::name).unwrap_or("All").into(), Some(d) => key[..d].to_string() }, offers);
    };
    let named = match kind { Some(_) => field_of(fields, kind, &key).cloned().into_iter().collect(), None => fields_named(fields, kind, &key) };
    let first = named.first()?; // none: red once a chip, since the kind has no such field
    let values: Vec<(String, String, Option<String>)> = if first["type"] == "date" {
        DATES.iter().map(|(v, l)| (v.to_string(), l.to_string(), Some("glyph-calendar".to_string()))).collect()
    } else {
        first_by(named.iter().flat_map(|f| f["values"].as_array().cloned().unwrap_or_default()).collect(), |v| text(v, "value"))
            .iter().map(|v| (text(v, "value"), text(v, "label"), v["icon"].as_str().map(str::to_string))).collect()
    };
    let mut parts: Vec<String> = after.as_str().split(',').map(str::to_string).collect();
    let part = parts.pop().unwrap_or_default().to_lowercase();
    let had: std::collections::HashSet<String> = parts.iter().map(|p| p.to_lowercase()).collect();
    let left: Vec<&(String, String, Option<String>)> = values.iter().filter(|v| !had.contains(&v.0.to_lowercase())).collect();
    let starts = |v: &&(String, String, Option<String>)| [&v.0, &v.1].iter().any(|s| s.to_lowercase().starts_with(&part));
    let holds = |v: &&(String, String, Option<String>)| !starts(v) && [&v.0, &v.1].iter().any(|s| s.to_lowercase().contains(&part));
    let field = name(first);
    let offers = left.iter().filter(|v| starts(v)).chain(left.iter().filter(|v| holds(v))).map(|v| Offer {
        take: format!("{not}{field}:{}", parts.iter().cloned().chain(std::iter::once(v.0.clone())).collect::<Vec<_>>().join(",")),
        name: v.0.clone(), label: if v.1.to_lowercase() == v.0.to_lowercase() { String::new() } else { v.1.clone() }, icon: v.2.clone(), value: true,
    }).collect();
    menu(field, offers)
}

// What a chip says: the field; is, or is not; before or after for a date, < or > for a number; then its values by their
// labels, joined by "or", with the first one's icon. A value is labelled by the first of the fields that has it.
fn chip_words(f: &Filter, named: &[Value]) -> (String, String, Option<String>) {
    let op_of = |v: &str| ["<=", ">=", "<", ">"].into_iter().find(|o| v.starts_with(o)).unwrap_or("");
    let ops: Vec<&str> = f.values.iter().map(|v| op_of(v)).collect();
    let field = named.first();
    let op = match field { Some(fd) if fd["type"] != "set" && ops.iter().all(|o| *o == ops[0]) => ops[0], _ => "" };
    let value = |v: &str| named.iter().flat_map(|n| n["values"].as_array().cloned().unwrap_or_default()).find(|x| text(x, "value").to_lowercase() == v.to_lowercase());
    let said = match op {
        "" => "is".to_string(),
        _ if field.is_some_and(|fd| fd["type"] == "date") => match op { "<" => "before", ">" => "after", "<=" => "on or before", _ => "on or after" }.to_string(),
        _ => op.to_string(),
    };
    let op_words = if !f.not { said } else if !op.is_empty() { format!("not {said}") } else { "is not".into() };
    let values = f.values.iter().map(|v| value(v).map(|x| text(&x, "label")).unwrap_or_else(|| v[op.len()..].to_string())).collect::<Vec<_>>().join(" or ");
    let icon = (f.values.len() < 3).then(|| value(&f.values[0]).and_then(|x| x["icon"].as_str().map(str::to_string))).flatten();
    (op_words, values, icon)
}

// A field's value's icon, by the name fields.ts gives it: a status, a priority, a project's status, a chat's state as
// its dot, or one of the glyphs.
fn value_icon(key: &str, size: f32, cx: &App) -> Option<AnyElement> {
    let (kind, v) = key.split_once('-')?;
    let dark = cx.theme().mode.is_dark();
    Some(match kind {
        "state" => theme::state_icon_sized(v, size, cx).into_any_element(),
        "priority" => crate::issue::priority_icon(v, cx).size(px(size)).into_any_element(),
        "project" => theme::project_icon(v, 50, cx).size(px(size)).into_any_element(),
        "chat" => {
            let colour: u32 = match (v, dark) { ("working", _) => 0xf0bf00, ("waiting", _) => 0xf2994a, ("open", true) => 0x4cb782, ("open", false) => 0x43bc58, (_, true) => 0x5f6062, _ => 0xb4b4b6 };
            div().size(px(size)).flex().items_center().justify_center().child(div().size(px(8.)).rounded_full().bg(rgb(colour))).into_any_element()
        }
        "glyph" => theme::glyph(v, colours(cx).tip_text).size(px(size)).into_any_element(),
        _ => return None,
    })
}

// The width of text in the bar's font, which places the menu under the word typed and the completion after it.
fn width_of(text: &str, window: &Window, cx: &App) -> Pixels {
    if text.is_empty() { return px(0.) }
    let run = TextRun { len: text.len(), font: font(cx.theme().font_family.clone()), color: black(), background_color: None, underline: None, strikethrough: None };
    window.text_system().shape_line(SharedString::from(text.to_string()), px(13.), &[run], None).width
}

// --- the box ----------------------------------------------------------------------------------------------------------

struct Group {
    kind: Kind,
    count: usize,
    hits: Vec<Value>,
}

enum Entry {
    Heading(Kind, usize, usize), // a kind's heading in All: how many it shows, and found
    Hit(Value),
    Empty(&'static str),
}

pub enum SearchEvent {
    Open(Value),
    Closed,
}

pub struct Search {
    query: Entity<InputState>,
    chips: Vec<Filter>,
    tab: Option<Kind>,                                // None: All
    answer: Option<(String, Option<Kind>, Vec<Group>)>, // the server's latest, for what was asked and in which tab
    at: Option<String>,                               // the row in focus, by its key
    asked: u64,
    scroll: ScrollHandle,
    // this opening, told to the server's search log as it closes (searchlog.ts)
    opened: Instant,
    keys: u32,
    server_ms: Option<f64>,
    picked: Value,
    placeholder: String,
    lit: (String, usize), // the menu's offer in focus, for the word it offers for
    shut: String,          // the word whose menu Esc closed
    input_at: std::rc::Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
    menu_at: std::rc::Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
    states: std::collections::HashMap<String, String>, // the issues' states as the window last heard them, newer than a hit's
    _typed: Subscription,
}

impl EventEmitter<SearchEvent> for Search {}

impl Search {
    pub fn new(states: std::collections::HashMap<String, String>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        load(cx);
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("Search chats…"));
        query.update(cx, |q, cx| q.focus(window, cx));
        let typed = cx.subscribe(&query, |search, _, event: &InputEvent, cx| {
            if let InputEvent::Change = event {
                search.shut.clear();
                search.keys += 1;
                search.ask(cx);
                cx.notify();
            }
        });
        let mut search = Self {
            query, chips: Vec::new(), tab: Some(Kind::Chats), answer: None, at: None, asked: 0, scroll: ScrollHandle::new(),
            opened: Instant::now(), keys: 0, server_ms: None, picked: json!({}), placeholder: "Search chats…".into(), lit: (String::new(), 0), shut: String::new(),
            input_at: Default::default(), menu_at: Default::default(), states, _typed: typed,
        };
        search.ask(cx);
        search
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        self.query.update(cx, |q, cx| q.focus(window, cx));
    }

    fn typed(&self, cx: &App) -> String {
        self.query.read(cx).value().to_string()
    }

    // The search: the chips, then what is typed, filters typed but not yet chips among it.
    fn q(&self, cx: &App) -> String {
        let typed = self.typed(cx);
        self.chips.iter().map(text_of).chain(std::iter::once(typed.trim().to_string())).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
    }

    // A key:value whose key some kind has is a filter; any other, as a link's http:, is a word.
    fn is_filter(&self, text: &str, cx: &App) -> bool {
        let Some(kept) = cx.try_global::<Kept>() else { return false };
        filter_of(text).is_some_and(|f| field_of(&kept.fields, None, &f.key).is_some())
    }

    // The words typed, and whether any filter is.
    fn words(&self, cx: &App) -> (String, bool) {
        let typed = self.typed(cx);
        let tokens: Vec<&str> = typed.split_whitespace().collect();
        let words = tokens.iter().filter(|t| !self.is_filter(t, cx)).copied().collect::<Vec<_>>().join(" ");
        (words, !self.chips.is_empty() || tokens.iter().any(|t| self.is_filter(t, cx)))
    }

    // Chats are found here, in Chats and All with no filter, since the window holds no chat's fields.
    fn local(&self, cx: &App) -> bool {
        !self.words(cx).1 && matches!(self.tab, Some(Kind::Chats) | None)
    }

    // The server is asked once the keys stop, and an older question's answer dropped.
    fn ask(&mut self, cx: &mut Context<Self>) {
        self.asked += 1;
        let (asked, q, tab) = (self.asked, self.q(cx), self.tab);
        let wait = if self.local(cx) { CHATS_WAIT } else if q.trim().is_empty() { 0 } else { WAIT };
        let path = format!("/api/page/search?q={}&kind={}", picker::encode(&q), tab.map(Kind::key).unwrap_or(""));
        cx.spawn(async move |this, cx| {
            if wait > 0 { cx.background_executor().timer(Duration::from_millis(wait)).await }
            if this.update(cx, |s, _| s.asked != asked).unwrap_or(true) { return }
            let started = Instant::now();
            let answer = cx.background_spawn(async move { net::get(&path) }).await;
            let _ = this.update(cx, |s, cx| {
                if s.asked != asked { return }
                s.server_ms = Some(started.elapsed().as_secs_f64() * 1000.);
                if let Ok(v) = answer {
                    let groups = v["kinds"].as_array().into_iter().flatten().filter_map(|g| Some(Group {
                        kind: Kind::of(g["kind"].as_str()?)?,
                        count: g["count"].as_u64().unwrap_or(0) as usize,
                        hits: g["hits"].as_array().cloned().unwrap_or_default(),
                    })).collect();
                    s.answer = Some((q, tab, groups));
                }
                cx.notify();
            });
        })
        .detach();
    }

    // Where the caret is, or None while text is selected.
    fn caret(&self, cx: &App) -> Option<usize> {
        let q = self.query.read(cx);
        q.selected_range().is_empty().then(|| q.cursor())
    }

    // The menu under the caret, unless Esc closed it for this word, and its offer in focus, the first for a new word.
    fn menu(&self, cx: &App) -> Option<(Menu, usize)> {
        let kept = cx.try_global::<Kept>()?;
        let menu = menu_at(&self.typed(cx), self.caret(cx), &kept.fields, self.tab)?;
        let word = format!("{}:{}", menu.start, menu.typed);
        if word == self.shut { return None }
        let lit = if self.lit.0 == word { self.lit.1.min(menu.offers.len() - 1) } else { 0 };
        Some((menu, lit))
    }

    fn light(&mut self, step: isize, cx: &mut Context<Self>) {
        let Some((menu, lit)) = self.menu(cx) else { return };
        let n = menu.offers.len() as isize;
        self.lit = (format!("{}:{}", menu.start, menu.typed), (lit as isize + step).rem_euclid(n) as usize);
        cx.notify();
    }

    // Text a chip or an offer leaves or puts back, with the caret where it belongs.
    fn retype(&mut self, text: String, caret: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.query.update(cx, |q, cx| {
            q.set_value(text, window, cx);
            q.set_selected_range(caret..caret, cx);
        });
        self.ask(cx);
        cx.notify();
    }

    // The filter text holds from start to end becomes a chip: it leaves the text, and the caret stays where it began.
    fn chip_of(&mut self, text: &str, start: usize, end: usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(f) = filter_of(&text[start..end]).filter(|_| self.is_filter(&text[start..end], cx)) else { return false };
        self.chips.push(f);
        let rest = format!("{}{}", &text[..start], text[end..].trim_start());
        self.retype(rest, start, window, cx);
        true
    }

    // Space or Enter at the end of a filter turns it into a chip.
    fn chip_at(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let (text, Some(end)) = (self.typed(cx), self.caret(cx)) else { return false };
        if text[end..].chars().next().is_some_and(|c| !c.is_whitespace()) { return false }
        let start = text[..end].char_indices().rev().find(|(_, c)| c.is_whitespace()).map(|(i, c)| i + c.len_utf8()).unwrap_or(0);
        self.chip_of(&text, start, end, window, cx)
    }

    // An offer taken, by Tab, Enter among values, or a click: a field's name and colon, typed for its value to follow; a
    // value, the filter made a chip.
    fn take_offer(&mut self, i: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some((menu, _)) = self.menu(cx) else { return };
        let Some(o) = menu.offers.get(i) else { return };
        let text = self.typed(cx);
        let end = menu.start + menu.typed.len();
        let next = format!("{}{}{}", &text[..menu.start], o.take, &text[end..]);
        let to = menu.start + o.take.len();
        if !o.value || !self.chip_of(&next, menu.start, to, window, cx) { self.retype(next, to, window, cx) }
    }

    // A chip back into text, at its start, to change it: Backspace right after the chips, or a click on its values.
    fn unchip(&mut self, i: usize, window: &mut Window, cx: &mut Context<Self>) {
        if i >= self.chips.len() { return }
        let chip = text_of(&self.chips.remove(i));
        let typed = self.typed(cx);
        let next = if typed.trim().is_empty() { chip.clone() } else { format!("{chip} {}", typed.trim_start()) };
        self.retype(next, chip.len(), window, cx);
        self.focus(window, cx);
    }

    fn set_tab(&mut self, tab: Option<Kind>, cx: &mut Context<Self>) {
        self.tab = tab;
        self.at = None;
        self.scroll.set_offset(point(px(0.), px(0.))); // a new tab starts at its top
        self.ask(cx);
        cx.notify();
    }

    fn answered(&self, cx: &App) -> bool {
        self.answer.as_ref().is_some_and(|(q, tab, _)| *q == self.q(cx) && *tab == self.tab)
    }

    // The groups shown: the chats' titles found here, then what the server found that they lack once it answers this
    // search; the server's other kinds, its last answer while the next is on its way; the settings found here. All lists
    // the chats alone before anything is typed, and each kind's best 5 after.
    fn groups(&self, cx: &App) -> Option<Vec<Group>> {
        let (words, filtered) = self.words(cx);
        let has_words = !words.trim().is_empty();
        let limit = if self.tab.is_none() && has_words { BEST } else { 100 };
        let titled = self.local(cx).then(|| find_chats(cx.try_global::<Kept>().map(|k| k.chats.as_slice()).unwrap_or(&[]), &words, limit));
        if self.answer.is_none() && titled.is_none() { return None }
        let settings = find_settings(&words, filtered);
        let listed = match self.tab {
            Some(Kind::Settings) => settings.clone(),
            None if has_words => settings.iter().take(BEST).cloned().collect(),
            _ => Vec::new(),
        };
        let settings = Group { kind: Kind::Settings, count: settings.len(), hits: listed };
        let theirs = self.answer.as_ref().map(|(_, _, g)| g.as_slice()).unwrap_or(&[]);
        let mine_too = titled.is_some();
        let others = theirs.iter().filter(|g| !mine_too || g.kind != Kind::Chats).map(|g| Group { kind: g.kind, count: g.count, hits: g.hits.clone() });
        let Some((count, mine)) = titled else { return Some(others.chain(std::iter::once(settings)).collect()) };
        let them = self.answered(cx).then(|| theirs.iter().find(|g| g.kind == Kind::Chats)).flatten();
        let keys: std::collections::HashSet<String> = mine.iter().map(|h| text(h, "key")).collect();
        let mut hits = mine;
        hits.extend(them.map(|g| g.hits.iter().filter(|h| !keys.contains(&text(h, "key"))).cloned().collect::<Vec<_>>()).unwrap_or_default());
        hits.truncate(limit);
        let count = count.max(them.map(|g| g.count).unwrap_or(0)).max(hits.len());
        Some(std::iter::once(Group { kind: Kind::Chats, count, hits }).chain(others).chain(std::iter::once(settings)).collect())
    }

    // What the list shows, heading by heading and row by row.
    fn entries(&self, groups: &Option<Vec<Group>>, cx: &App) -> Vec<Entry> {
        let mut out = Vec::new();
        let Some(groups) = groups else { return out };
        for g in groups.iter().filter(|g| !g.hits.is_empty()) {
            if self.tab.is_none() { out.push(Entry::Heading(g.kind, g.hits.len(), g.count)) }
            out.extend(g.hits.iter().cloned().map(Entry::Hit));
        }
        if out.is_empty() {
            out.push(Entry::Empty(if !self.answered(cx) { "Searching…" } else if self.words(cx).1 { "No results with these filters" } else { "No results" }));
        }
        out
    }

    fn focused(&self, entries: &[Entry]) -> Option<(usize, Value)> {
        let hits = entries.iter().enumerate().filter_map(|(i, e)| match e { Entry::Hit(h) => Some((i, h)), _ => None });
        let mut first = None;
        for (i, h) in hits {
            if first.is_none() { first = Some((i, h.clone())) }
            if self.at.as_deref() == Some(text(h, "key").as_str()) { return Some((i, h.clone())) }
        }
        first
    }

    fn walk(&mut self, step: isize, cx: &mut Context<Self>) {
        let groups = self.groups(cx);
        let entries = self.entries(&groups, cx);
        let Some((at, _)) = self.focused(&entries) else { return };
        let hits: Vec<usize> = entries.iter().enumerate().filter(|(_, e)| matches!(e, Entry::Hit(_))).map(|(i, _)| i).collect();
        let Some(n) = hits.iter().position(|i| *i == at) else { return };
        let Some(next) = hits.get((n as isize + step).max(0) as usize).filter(|_| n as isize + step >= 0) else { return };
        if let Entry::Hit(h) = &entries[*next] { self.at = Some(text(h, "key")) }
        // the heading over the first row comes into view with it
        let shown = if hits.first() == Some(next) { 0 } else { *next };
        self.scroll.scroll_to_item(shown);
        cx.notify();
    }

    // Tab: a kind's first letter alone, then Tab, goes to its tab, and the letter goes, since it named the kind; else the
    // next kind, or the one before with Shift.
    fn tab_key(&mut self, back: bool, window: &mut Window, cx: &mut Context<Self>) {
        let typed = self.typed(cx).trim().to_lowercase();
        if !back && typed.chars().count() == 1 {
            let named = if typed == "a" { Some(None) } else { KINDS.into_iter().find(|k| k.name()[..1].to_lowercase() == typed).map(Some) };
            if let Some(tab) = named {
                self.query.update(cx, |q, cx| q.set_value("", window, cx));
                return self.set_tab(tab, cx);
            }
        }
        let all: Vec<Option<Kind>> = std::iter::once(None).chain(KINDS.into_iter().map(Some)).collect();
        let now = all.iter().position(|t| *t == self.tab).unwrap_or(0) as isize;
        let next = all[(now + if back { -1 } else { 1 }).rem_euclid(all.len() as isize) as usize];
        self.set_tab(next, cx);
    }

    fn open(&mut self, hit: Value, rank: usize, cx: &mut Context<Self>) {
        self.picked = json!({ "picked_kind": hit["kind"], "picked": hit["key"], "picked_title": unmark(&text(&hit, "title")).0,
            "picked_from": if hit["here"].as_bool().unwrap_or(false) || hit["kind"] == "setting" { "browser" } else { "server" },
            "rank": rank, "took_ms": self.opened.elapsed().as_secs_f64() * 1000. });
        cx.emit(SearchEvent::Open(hit));
    }

    fn enter(&mut self, cx: &mut Context<Self>) {
        let groups = self.groups(cx);
        let entries = self.entries(&groups, cx);
        let Some((at, hit)) = self.focused(&entries) else { return };
        let rank = entries[..at].iter().filter(|e| matches!(e, Entry::Hit(_))).count();
        self.open(hit, rank, cx);
    }

    // What this opening ends on, for the server's search log, as the box closes.
    pub fn tell(&self, cx: &App) {
        let mut visit = json!({ "tab": self.tab.map(Kind::key).unwrap_or(""), "query": self.q(cx), "took_ms": self.opened.elapsed().as_secs_f64() * 1000.,
            "keys": self.keys, "server_ms": self.server_ms });
        if let (Some(visit), Some(picked)) = (visit.as_object_mut(), self.picked.as_object()) {
            for (k, v) in picked { visit.insert(k.clone(), v.clone()); }
        }
        cx.background_spawn(async move { let _ = net::post("/api/page/search/log", visit); }).detach();
    }
}

// What a row says at its right: where and when for a chat, an issue and a project, a team's open issues, a milestone's
// project and target, a setting's page.
fn where_of(h: &Value) -> String {
    let join = |parts: [String; 2]| parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" · ");
    match h["kind"].as_str().unwrap_or("") {
        "chat" => join([text(h, "folder"), text(h, "age")]),
        "issue" | "project" => join([text(&h["team"], "title"), text(h, "date")]),
        "team" => match h["open"].as_u64().unwrap_or(0) {
            0 => "No open issues".into(),
            1 => "1 open issue".into(),
            n => format!("{n} open issues"),
        },
        "milestone" => join([text(&h["project"], "title"), text(&h["milestone"], "target_label")]),
        _ => text(h, "section"),
    }
}

fn icon_of(h: &Value, states: &dyn Fn(&str) -> Option<String>, cx: &App) -> AnyElement {
    let state = |issue: &Value| states(issue["slug"].as_str().unwrap_or("")).unwrap_or_else(|| text(issue, "state"));
    match h["kind"].as_str().unwrap_or("") {
        "chat" if h["issue"].is_object() => theme::state_icon(&state(&h["issue"]), cx).into_any_element(),
        "chat" => theme::state_icon("chat", cx).into_any_element(),
        "issue" => theme::state_icon(&state(&h["issue"]), cx).into_any_element(),
        "project" => theme::project_icon(h["project"]["status"].as_str().unwrap_or(""), h["project"]["progress"].as_u64().unwrap_or(0) as u32, cx).into_any_element(),
        "milestone" => theme::milestone_icon(h["milestone"]["progress"].as_u64().unwrap_or(0) as u32, h["milestone"]["current"].as_bool().unwrap_or(false), cx).into_any_element(),
        kind => theme::glyph(if kind == "team" { "team" } else { "sliders" }, colours(cx).tip_text).into_any_element(),
    }
}

// A hit's title or line, its words found in bold.
fn marked_text(html: &str) -> StyledText {
    let (text, marks) = unmark(html);
    let bold = HighlightStyle { font_weight: Some(FontWeight::BOLD), ..Default::default() };
    StyledText::new(text).with_highlights(marks.into_iter().map(move |r| (r, bold)))
}

impl Render for Search {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = colours(cx);
        let groups = self.groups(cx);
        let entries = self.entries(&groups, cx);
        let focused = self.focused(&entries).map(|(i, _)| i);
        let count = |kind: Kind| groups.as_ref().and_then(|g| g.iter().find(|g| g.kind == kind)).map(|g| g.count);
        let states = self.states.clone();
        let state_of = move |slug: &str| states.get(slug).cloned();
        let placeholder = match self.tab {
            _ if !self.chips.is_empty() => String::new(),
            Some(kind) => format!("Search {}…", kind.name().to_lowercase()),
            None => "Search chats, issues, projects…".into(),
        };
        if self.placeholder != placeholder {
            self.placeholder = placeholder.clone();
            self.query.update(cx, |q, cx| q.set_placeholder(placeholder, window, cx));
        }

        // a tab per kind, All first: a quiet pill, the open one filled, its count dimmer, a kind with none dimmed
        let tab = |id: &'static str, label: &'static str, here: bool, n: Option<usize>, cx: &mut Context<Self>, to: Option<Kind>| {
            let none = n == Some(0);
            div().id(id).h_flex().flex_none().h(px(28.)).px(px(10.)).gap(px(6.)).rounded_full().text_size(px(12.)).font_medium().cursor_pointer()
                .text_color(if here { c.cmd_on_text } else if none { c.cmd_hint } else { c.tip_key })
                .when(here, |t| t.bg(c.cmd_on).border(px(0.5)).border_color(c.tip_edge))
                .when(!here && !none, |t| t.hover(|s| s.text_color(c.tip_text)))
                .child(label)
                .when_some(n.filter(|n| *n > 0), |t, n| t.child(div().font_weight(FontWeight(450.)).text_color(if here { c.tip_key } else { c.cmd_hint }).child(many(n))))
                .on_click(cx.listener(move |s, _, _, cx| s.set_tab(to, cx)))
        };
        let mut tabs = div().h_flex().gap(px(4.)).px(px(12.)).pt(px(6.)).pb(px(4.)).child(tab("tab-all", "All", self.tab.is_none(), None, cx, None));
        for kind in KINDS {
            tabs = tabs.child(tab(kind.key(), kind.name(), self.tab == Some(kind), count(kind), cx, Some(kind)));
        }

        let mut list = div().id("search-list").v_flex().max_h(px((window.viewport_size().height.as_f32() * 0.87 - 140.).min(560.).max(120.)))
            .overflow_y_scroll().track_scroll(&self.scroll).pt(px(6.)).pr(px(9.)).pb(px(5.)).pl(px(6.));
        let mut rank = 0;
        for (i, entry) in entries.into_iter().enumerate() {
            list = list.child(match entry {
                Entry::Heading(kind, shown, found) => div().id(("heading", i)).h_flex().flex_none().justify_between().h(px(30.)).px(px(12.)).text_size(px(12.)).font_medium()
                    .text_color(c.tip_key).cursor_pointer().hover(|s| s.text_color(c.tip_text))
                    .child(kind.name())
                    .child(div().font_weight(FontWeight(450.)).text_color(c.cmd_hint).child(if found > shown { format!("{} of {}", many(shown), many(found)) } else { many(found) }))
                    .on_mouse_down(MouseButton::Left, cx.listener(move |s, _, _, cx| s.set_tab(Some(kind), cx)))
                    .into_any_element(),
                Entry::Empty(said) => div().h_flex().flex_none().h(px(46.)).px(px(12.)).text_color(c.cmd_hint).child(said).into_any_element(),
                Entry::Hit(h) => {
                    let on = focused == Some(i);
                    let (key, snippet, here_rank) = (text(&h, "key"), text(&h, "snippet"), rank);
                    rank += 1;
                    let hit = h.clone();
                    div().id(("hit", i)).h_flex().flex_none().h(px(46.)).py(px(2.)).child(
                        div().h_flex().size_full().px(px(12.)).gap(px(8.)).rounded(px(8.)).font_weight(FontWeight(450.))
                            .text_color(if on { c.cmd_on_text } else { c.tip_text })
                            .when(on, |r| r.bg(c.cmd_on))
                            .child(div().flex_none().size(px(16.)).flex().items_center().justify_center().child(icon_of(&h, &state_of, cx)))
                            .child(div().flex_shrink(1.).min_w_0().truncate().child(marked_text(&text(&h, "title"))))
                            .when(!snippet.is_empty(), |r| r.child(div().flex_1().min_w(px(40.)).truncate().text_color(c.tip_key).child(marked_text(&snippet))))
                            .child(div().flex_none().ml_auto().pl(px(12.)).text_size(px(12.)).text_color(c.tip_key).child(where_of(&h))),
                    )
                    .on_mouse_move(cx.listener(move |s, _, _, cx| if s.at.as_deref() != Some(key.as_str()) { s.at = Some(key.clone()); cx.notify() }))
                    .on_mouse_down(MouseButton::Left, cx.listener(move |s, _, _, cx| s.open(hit.clone(), here_rank, cx)))
                    .into_any_element()
                }
            });
        }

        let kbd = |k: &'static str| div().px(px(2.)).py(px(2.)).rounded(px(4.)).border(px(0.5)).border_color(c.key_edge).text_size(px(11.)).font_medium().text_color(c.tip_key).child(k);
        let foot = div().h_flex().flex_none().h(px(35.)).px(px(4.)).gap(px(2.)).border_t(px(0.5)).border_color(c.tip_edge).text_size(px(12.)).font_medium()
            .child(div().id("search-open").h_flex().h(px(24.)).px(px(8.)).gap(px(6.)).rounded_full().text_color(c.tip_text).cursor_pointer().hover(|s| s.bg(c.cmd_on))
                .child(kbd("↵")).child("Open")
                .on_click(cx.listener(|s, _, _, cx| s.enter(cx))))
            .child(div().h_flex().h(px(24.)).px(px(8.)).gap(px(6.)).text_color(c.tip_key).child(kbd("Tab")).child("Complete, or next kind"));

        // the chips, in the box's palette, red where the tab's kind has no such field, which searches it as words
        let red: Hsla = if c.dark { rgb(0xff6364).into() } else { rgb(0xe2253b).into() };
        let fields = cx.try_global::<Kept>().map(|k| k.fields.clone()).unwrap_or(Value::Null);
        let chips: Vec<AnyElement> = self.chips.clone().into_iter().enumerate().map(|(i, f)| {
            let foreign = self.tab.is_some() && fields.is_object() && field_of(&fields, self.tab, &f.key).is_none();
            let (op, values, icon) = chip_words(&f, &fields_named(&fields, self.tab, &f.key));
            let (edge, ink, dim) = if foreign { (red, red, red) } else { (c.tip_edge, c.tip_text, c.tip_key) };
            let part = |id: &'static str| div().id((id, i)).h_flex().h_full().px(px(6.)).gap(px(4.)).border_l(px(0.5)).border_color(edge);
            div().h_flex().flex_none().h(px(24.)).rounded(px(6.)).border(px(0.5)).border_color(edge).overflow_hidden().text_size(px(12.)).font_medium().text_color(ink)
                .child(div().h_flex().h_full().px(px(6.)).child(f.key.clone()))
                .child(part("chip-op").font_weight(FontWeight(450.)).text_color(dim).cursor_pointer().hover(|s| s.bg(c.cmd_on).text_color(c.cmd_on_text)).child(op)
                    .on_click(cx.listener(move |s, _, _, cx| { if let Some(f) = s.chips.get_mut(i) { f.not = !f.not } s.ask(cx); cx.notify() })))
                .child(part("chip-values").max_w(px(240.)).cursor_pointer().hover(|s| s.bg(c.cmd_on).text_color(c.cmd_on_text))
                    .children(icon.and_then(|k| value_icon(&k, 14., cx)))
                    .child(div().min_w_0().truncate().child(values))
                    .on_click(cx.listener(move |s, _, window, cx| s.unchip(i, window, cx))))
                .child(part("chip-remove").text_color(dim).cursor_pointer().hover(|s| s.bg(c.cmd_on).text_color(c.cmd_on_text)).child(theme::glyph("close", dim).size(px(12.)))
                    .on_click(cx.listener(move |s, _, _, cx| { if i < s.chips.len() { s.chips.remove(i); } s.ask(cx); cx.notify() })))
                .into_any_element()
        }).collect();

        // the menu under the word typed, in the @ menu's look, lined up with it and kept in the window; the completion
        // greyed after the caret while the text fits the bar
        let mut over: Vec<AnyElement> = Vec::new();
        if let (Some((menu, lit)), Some(input)) = (self.menu(cx), self.input_at.get()) {
            let typed = self.typed(cx);
            let x = input.left() + width_of(&typed[..menu.start], window, cx) - px(14.);
            let x = x.max(px(8.)).min(window.viewport_size().width - px(358.));
            let mut rows = div().id("search-menu-rows").v_flex().max_h(px((window.viewport_size().height.as_f32() - 200.).min(420.))).overflow_y_scroll();
            for (n, o) in menu.offers.iter().enumerate() {
                let on = n == lit;
                let word = format!("{}:{}", menu.start, menu.typed);
                rows = rows.child(
                    div().id(("offer", n)).h_flex().flex_none().h(px(34.)).mx(px(4.)).px(px(10.)).gap(px(12.)).rounded(px(6.)).cursor_pointer().when(on, |r| r.bg(c.cmd_on))
                        .when(o.value, |r| r.child(div().flex_none().size(px(16.)).flex().items_center().justify_center().children(o.icon.as_deref().and_then(|k| value_icon(k, 16., cx)))))
                        .child(div().when(o.value, |n| n.flex_shrink(1.).min_w_0().truncate()).when(!o.value, |n| n.flex_none()).child(o.name.clone()))
                        .when(!o.label.is_empty(), |r| r.child(
                            div().min_w_0().truncate().text_color(c.tip_key)
                                .when(o.value, |l| l.ml(px(-4.)))
                                .when(!o.value, |l| l.ml_auto().pl(px(12.)).text_size(px(12.)))
                                .child(o.label.clone()),
                        ))
                        .on_mouse_move(cx.listener(move |s, _, _, cx| if s.lit != (word.clone(), n) { s.lit = (word.clone(), n); cx.notify() }))
                        .on_mouse_down(MouseButton::Left, cx.listener(move |s, _, window, cx| s.take_offer(n, window, cx))),
                );
            }
            let at = self.menu_at.clone();
            over.push(
                anchored().position(point(x, input.bottom() + px(8.))).snap_to_window_with_margin(px(8.)).child(
                    div().id("search-menu").occlude().relative().w(px(350.)).py(px(4.)).rounded(px(10.)).border(px(0.5)).border_color(c.tip_edge).bg(c.tip)
                        .shadow(crate::filters::panel_shadow(c.dark)).text_size(px(13.)).font_weight(FontWeight(450.)).text_color(c.cmd_on_text)
                        .child(div().h_flex().h(px(28.)).px(px(14.)).pb(px(2.)).text_size(px(12.)).font_medium().text_color(c.tip_key).child(menu.heading.clone()))
                        .child(rows)
                        .child(canvas(move |bounds, _, _| at.set(Some(bounds)), |_, _, _, _| {}).absolute().top_0().left_0().size_full()),
                ).into_any_element(),
            );
            let take = &menu.offers[lit].take;
            let at_end = self.caret(cx) == Some(typed.len());
            if at_end && take.to_lowercase().starts_with(&menu.typed.to_lowercase()) && take.len() > menu.typed.len() {
                let wide = width_of(&typed, window, cx);
                if wide < input.size.width {
                    over.push(anchored().position(point(input.left() + wide, input.top())).child(
                        div().h(input.size.height).flex().items_center().text_size(px(13.)).text_color(c.cmd_hint).whitespace_nowrap().child(take[menu.typed.len()..].to_string()),
                    ).into_any_element());
                }
            }
        } else {
            self.menu_at.set(None);
        }

        let width = (window.viewport_size().width.as_f32() - 32.).min(720.);
        div().child(div()
            .id("search")
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
            // the menu first, then the list; Esc closes the menu, then the box. An action caught on its way down goes on
            // to the input and the window unless stopped, so each stops it.
            .capture_action(cx.listener(|s, _: &MoveDown, _, cx| { cx.stop_propagation(); if s.menu(cx).is_some() { s.light(1, cx) } else { s.walk(1, cx) } }))
            .capture_action(cx.listener(|s, _: &MoveUp, _, cx| { cx.stop_propagation(); if s.menu(cx).is_some() { s.light(-1, cx) } else { s.walk(-1, cx) } }))
            // Enter takes a value; letters that start a field may be words searched for, so there it opens the hit
            .capture_action(cx.listener(|s, _: &Enter, window, cx| {
                cx.stop_propagation();
                match s.menu(cx) {
                    Some((menu, lit)) if menu.offers[lit].value => s.take_offer(lit, window, cx),
                    _ => if !s.chip_at(window, cx) { s.enter(cx) },
                }
            }))
            .capture_action(cx.listener(|s, _: &IndentInline, window, cx| {
                cx.stop_propagation(); // else the window's Tab moves the keys to the next box, the composer
                match s.menu(cx) {
                    Some((_, lit)) => s.take_offer(lit, window, cx),
                    None => s.tab_key(false, window, cx),
                }
            }))
            .capture_action(cx.listener(|s, _: &OutdentInline, window, cx| { cx.stop_propagation(); s.tab_key(true, window, cx) }))
            .capture_action(cx.listener(|s, _: &Escape, _, cx| {
                cx.stop_propagation();
                match s.menu(cx) {
                    Some((menu, _)) => { s.shut = format!("{}:{}", menu.start, menu.typed); cx.notify() }
                    None => cx.emit(SearchEvent::Closed),
                }
            }))
            .capture_key_down(cx.listener(|s, e: &KeyDownEvent, window, cx| {
                let k = &e.keystroke;
                let bare = !(k.modifiers.control || k.modifiers.alt || k.modifiers.shift || k.modifiers.platform);
                if k.modifiers.control && !k.modifiers.shift && !k.modifiers.alt && (k.key == "n" || k.key == "p") {
                    s.walk(if k.key == "n" { 1 } else { -1 }, cx);
                    cx.stop_propagation();
                } else if bare && k.key == "space" && s.chip_at(window, cx) {
                    cx.stop_propagation();
                } else if bare && k.key == "backspace" && !s.chips.is_empty() && s.query.read(cx).selected_range() == (0..0) {
                    let last = s.chips.len() - 1;
                    s.unchip(last, window, cx);
                    cx.stop_propagation();
                }
            }))
            // a click outside closes it; the menu, drawn over the page, is inside
            .on_mouse_down_out(cx.listener(|s, e: &MouseDownEvent, _, cx| {
                if s.menu(cx).is_some() && s.menu_at.get().is_some_and(|b| b.contains(&e.position)) { return }
                cx.emit(SearchEvent::Closed)
            }))
            // the box's own: the search glyph 12px in, what is typed after it
            .child(
                div().relative().pt(px(6.)).px(px(6.)).child(
                    div().flex().flex_wrap().items_center().gap_x(px(6.)).gap_y(px(4.)).min_h(px(40.)).py(px(8.)).pl(px(30.)).pr(px(6.))
                        .child(div().absolute().left(px(12.)).top(px(12.)).child(theme::glyph("search", c.tip_text)))
                        .children(chips)
                        .child(
                            div().relative().flex_1().min_w(px(80.)).h(px(24.)).flex().items_center()
                                // no padding of its own, so that its text starts 36px in, as the web's, where the menu and the completion are measured from
                                .child(Input::new(&self.query).appearance(false).text_size(px(13.)).px_0().py_0().h(px(24.)))
                                .child({
                                    let at = self.input_at.clone();
                                    canvas(move |bounds, _, _| at.set(Some(bounds)), |_, _, _, _| {}).absolute().top_0().left_0().size_full()
                                }),
                        ),
                ),
            )
            .child(tabs)
            .child(list)
            .child(foot))
            .children(over) // after the box, so drawn over it
    }
}

fn many(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, d) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 { out.push(',') }
        out.push(d);
    }
    out
}
