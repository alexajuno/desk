// The Inbox's view, as the web app's (inbox/listing.ts), worked out in the window from the rows desk pushes: Filter's
// Notification type, From, Team, Project, Folder, Issue priority and Issue status; Display's Ordering and Show unread
// first; and Show unreads only. It is kept in the web's words for its address, such as "type=plan,result&order=oldest",
// in a file of its own, so the Inbox opens on the view it was left on, as the web's keeps its last view.
use std::collections::{HashMap, HashSet};

use crate::net;
use crate::sync::{InboxRow, Issue};

pub const FILTERS: [(&str, &str); 7] = [("type", "Notification type"), ("from", "From"), ("team", "Team"), ("project", "Project"),
    ("folder", "Folder"), ("priority", "Issue priority"), ("status", "Issue status")];
pub const ORDERS: [(&str, &str); 3] = [("newest", "Newest"), ("oldest", "Oldest"), ("priority", "Priority")];

// The Notification type, by what a row asks of you, as Linear's are Assignments, Comments and replies, and Reminders
// and deadlines.
const TYPES: [(&str, &str); 9] = [("deadline", "Reminders and deadlines"), ("plan", "Plans"), ("result", "Results"), ("question", "Questions"),
    ("reply", "Replies"), ("triage", "Triage"), ("stuck", "Landing stuck"), ("now", "Messages that need you"), ("later", "Messages that wait")];
const STATES: [(&str, &str); 8] = [("triage", "Triage"), ("backlog", "Backlog"), ("running", "In progress"), ("waiting", "Waiting"),
    ("review", "In review"), ("landing", "Landing"), ("done", "Done"), ("dropped", "Dropped")];
const PRIORITIES: [(&str, &str); 5] = [("urgent", "Urgent"), ("high", "High"), ("medium", "Medium"), ("low", "Low"), ("none", "No priority")];

#[derive(Clone, PartialEq)]
pub struct Filter {
    pub name: String,
    pub not: bool,
    pub values: Vec<String>,
}

#[derive(Clone, PartialEq)]
pub struct View {
    pub order: String,
    pub first: bool,  // Show unread first
    pub unread: bool, // Show unreads only
    pub filters: Vec<Filter>, // in FILTERS' order
}

impl Default for View {
    fn default() -> Self {
        View { order: "newest".into(), first: false, unread: false, filters: Vec::new() }
    }
}

// What stays as is in a view's words, as the server's views.ts writes them (Python's quote, safe "/~,:").
fn quote(value: &str) -> String {
    value.bytes().map(|b| if b.is_ascii_alphanumeric() || b"_.-~/,:".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

impl View {
    // The view in the address's words; what it does not know is left out.
    pub fn parse(words: &str) -> View {
        let mut view = View::default();
        for pair in words.split('&') {
            let Some((name, value)) = pair.split_once('=') else { continue };
            let value = net::decode(value);
            if value.is_empty() { continue }
            if FILTERS.iter().any(|(n, _)| *n == name) {
                let not = value.starts_with("not:");
                let values: Vec<String> = value.trim_start_matches("not:").split(',').filter(|v| !v.is_empty()).map(str::to_string).collect();
                if !values.is_empty() { view.filters.push(Filter { name: name.into(), not, values }) }
            } else if name == "order" && ORDERS.iter().any(|(o, _)| *o == value) {
                view.order = value;
            } else if name == "first" && value == "1" {
                view.first = true;
            } else if name == "unread" && value == "1" {
                view.unread = true;
            }
        }
        view.sort();
        view
    }

    // The view in words, leaving out what is the default.
    pub fn words(&self) -> String {
        let mut parts: Vec<String> = self.filters.iter().map(|f| format!("{}={}", f.name, quote(&format!("{}{}", if f.not { "not:" } else { "" }, f.values.join(","))))).collect();
        if self.order != "newest" { parts.push(format!("order={}", self.order)) }
        if self.first { parts.push("first=1".into()) }
        if self.unread { parts.push("unread=1".into()) }
        parts.join("&")
    }

    // Display's dot: the display differs from its default.
    pub fn is_default(&self) -> bool {
        self.order == "newest" && !self.first
    }

    pub fn filter(&self, name: &str) -> Option<&Filter> {
        self.filters.iter().find(|f| f.name == name)
    }

    fn sort(&mut self) {
        let rank = |name: &str| FILTERS.iter().position(|(n, _)| *n == name).unwrap_or(FILTERS.len());
        self.filters.sort_by_key(|f| rank(&f.name));
    }

    // A value picked or taken back; a property with none left has no filter.
    pub fn toggle(&mut self, name: &str, value: &str) {
        match self.filters.iter_mut().find(|f| f.name == name) {
            Some(f) => {
                if let Some(at) = f.values.iter().position(|v| v == value) { f.values.remove(at); } else { f.values.push(value.into()) }
            }
            None => self.filters.push(Filter { name: name.into(), not: false, values: vec![value.into()] }),
        }
        self.filters.retain(|f| !f.values.is_empty());
        self.sort();
    }

    pub fn flip(&mut self, name: &str) {
        if let Some(f) = self.filters.iter_mut().find(|f| f.name == name) { f.not = !f.not }
    }

    pub fn remove(&mut self, name: &str) {
        self.filters.retain(|f| f.name != name);
    }

    fn file() -> Option<std::path::PathBuf> {
        let state = std::env::var_os("XDG_STATE_HOME").map(std::path::PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".local/state")))?;
        Some(state.join("desk").join("native-inbox-view"))
    }

    pub fn load() -> View {
        View::file().and_then(|f| std::fs::read_to_string(f).ok()).map(|words| View::parse(words.trim())).unwrap_or_default()
    }

    pub fn save(&self) {
        let Some(file) = View::file() else { return };
        if let Some(dir) = file.parent() { let _ = std::fs::create_dir_all(dir); }
        let _ = std::fs::write(file, self.words());
    }
}

// What the view reads its rows' values from.
pub struct Store<'a> {
    pub inbox: &'a HashMap<String, InboxRow>,
    pub issues: &'a HashMap<String, Issue>,
    pub teams: &'a HashMap<String, String>,
    pub projects: &'a HashMap<String, String>,
}

fn type_of(r: &InboxRow) -> &'static str {
    let why = r.why.as_str();
    if r.source.is_some() && (why == "now" || why == "later") { return if why == "now" { "now" } else { "later" } } // a thread's message
    match why {
        "plan ready" => "plan",
        "check it" => "result",
        "asks you" | "waiting for you" => "question",
        "no chat" => "triage",
        "due soon" | "overdue" => "deadline",
        "landing stuck" => "stuck",
        _ => "reply",
    }
}

// How a folder reads, as the server's views.ts writes it: a repo under ~/projects by its path there, as muse or genai/api.
fn folder_name(path: Option<&str>) -> String {
    match path {
        Some(p) => { let p = p.trim_end_matches('/'); p.strip_prefix("~/projects/").unwrap_or(p).to_string() }
        None => "none".into(),
    }
}

// An icon by what it shows: a status, a priority, or one of the window's glyphs.
#[derive(Clone, PartialEq)]
pub enum Icon {
    State(String),
    Priority(String),
    Glyph(&'static str),
}

// A value's icon, or the property's own when v is None. Notification type and From have none.
pub fn icon_of(name: &str, v: Option<&str>) -> Option<Icon> {
    match (name, v) {
        ("type" | "from", _) => None,
        ("status", Some("none")) => Some(Icon::Glyph("none")),
        ("status", v) => Some(Icon::State(v.unwrap_or("backlog").into())),
        ("priority", v) => Some(Icon::Priority(v.unwrap_or("high").into())),
        ("team", _) => Some(Icon::Glyph("team")),
        ("project", _) => Some(Icon::Glyph("project")),
        _ => Some(Icon::Glyph("folder")),
    }
}

pub struct Chip {
    pub name: String,
    pub label: &'static str,
    pub not: bool,
    pub values: Vec<(String, String, Option<Icon>)>, // value, label, icon
}

pub struct Choice {
    pub value: String,
    pub label: String,
    pub icon: Option<Icon>,
    pub count: usize,
}

pub struct Field {
    pub name: &'static str,
    pub label: &'static str,
    pub icon: Option<Icon>,
    pub values: Vec<Choice>,
}

impl Store<'_> {
    // A row's value of one of the filters, as the address writes it. A chat with no issue has no folder, team, priority
    // or status, and comes From its agent, or from "chat".
    fn value(&self, r: &InboxRow, name: &str) -> String {
        if name == "type" { return type_of(r).into() }
        if name == "from" {
            if r.issue { return "issue".into() }
            if r.session.is_none() { if let Some(source) = &r.source { return source.clone() } }
            return r.agent.clone().unwrap_or_else(|| "chat".into());
        }
        let Some(i) = r.issue.then(|| self.issues.get(&r.slug)).flatten() else { return "none".into() };
        match name {
            "status" => i.state.clone(),
            "priority" => if i.priority.is_empty() { "none".into() } else { i.priority.clone() },
            "folder" => folder_name(i.folder.as_deref()),
            "team" => i.team.clone().unwrap_or_else(|| "none".into()),
            _ => i.project.clone().unwrap_or_else(|| "none".into()),
        }
    }

    pub fn label(&self, name: &str, v: &str) -> String {
        let of = |list: &[(&str, &str)]| list.iter().find(|(k, _)| *k == v).map(|(_, l)| l.to_string());
        match name {
            "type" => of(&TYPES).unwrap_or_else(|| v.into()),
            "from" => match v { "issue" => "Issue sessions".into(), "chat" => "Chats".into(), "slack" => "Slack".into(), "mail" => "Mail".into(), _ => v.into() },
            "status" if v == "none" => "No status".into(),
            "status" => of(&STATES).unwrap_or_else(|| v.into()),
            "priority" => of(&PRIORITIES).unwrap_or_else(|| v.into()),
            _ if v == "none" => format!("No {name}"),
            "team" => self.teams.get(v).cloned().unwrap_or_else(|| v.into()),
            "project" => self.projects.get(v).cloned().unwrap_or_else(|| v.into()),
            _ => v.into(),
        }
    }

    // Every row but the deleted ones, save the one open, newest first.
    fn base(&self, open: Option<&str>) -> Vec<&InboxRow> {
        let mut rows: Vec<&InboxRow> = self.inbox.values().filter(|r| !r.gone || Some(r.slug.as_str()) == open).collect();
        rows.sort_by(|a, b| b.at.total_cmp(&a.at));
        rows
    }

    // The rows as the view shows them: Filter's picks; Show unreads only, which keeps the one open and those you read
    // in this visit (stay), so that reading never moves the list; Ordering; and Show unread first, where a row you read
    // in this visit keeps its place too.
    pub fn rows(&self, view: &View, open: Option<&str>, stay: &HashSet<String>) -> Vec<InboxRow> {
        let mut rows: Vec<&InboxRow> = self.base(open).into_iter()
            .filter(|r| view.filters.iter().all(|f| f.values.contains(&self.value(r, &f.name)) != f.not))
            .collect();
        let unread = |r: &InboxRow| !r.read || stay.contains(&r.id);
        if view.unread { rows.retain(|r| unread(r) || Some(r.slug.as_str()) == open) }
        let priority = |r: &InboxRow| {
            let level = r.issue.then(|| self.issues.get(&r.slug)).flatten().map(|i| i.priority.as_str());
            level.and_then(|l| PRIORITIES.iter().position(|(p, _)| *p == l)).unwrap_or(PRIORITIES.len())
        };
        match view.order.as_str() {
            "oldest" => rows.reverse(),
            "priority" => rows.sort_by_key(|r| priority(r)), // stable: newest first within a priority
            _ => {}
        }
        if view.first { rows.sort_by_key(|r| !unread(r)) }
        rows.into_iter().cloned().collect()
    }

    pub fn chips(&self, view: &View) -> Vec<Chip> {
        view.filters.iter().map(|f| Chip {
            name: f.name.clone(),
            label: FILTERS.iter().find(|(n, _)| *n == f.name).map(|(_, l)| *l).unwrap_or(""),
            not: f.not,
            values: f.values.iter().map(|v| (v.clone(), self.label(&f.name, v), icon_of(&f.name, Some(v)))).collect(),
        }).collect()
    }

    // Filter's menus: each property with its values, each with how many of the Inbox's rows have it.
    pub fn fields(&self, view: &View, open: Option<&str>) -> Vec<Field> {
        let base = self.base(open);
        FILTERS.iter().map(|(name, label)| {
            let mut values: Vec<String> = match *name {
                "type" => TYPES.iter().map(|(v, _)| v.to_string()).collect(),
                "priority" => ["none", "urgent", "high", "medium", "low"].iter().map(|v| v.to_string()).collect(),
                "status" => STATES.iter().map(|(v, _)| v.to_string()).chain(["none".to_string()]).collect(),
                _ => {
                    let mut found: Vec<String> = Vec::new();
                    for r in &base { let v = self.value(r, name); if !found.contains(&v) { found.push(v) } }
                    if *name == "from" {
                        let mut middle: Vec<String> = found.iter().filter(|v| *v != "issue" && *v != "chat").cloned().collect();
                        middle.sort();
                        found.contains(&"issue".to_string()).then(|| "issue".to_string()).into_iter().chain(middle)
                            .chain(found.contains(&"chat".to_string()).then(|| "chat".to_string())).collect()
                    } else {
                        let mut named: Vec<String> = found.into_iter().filter(|v| v != "none").collect();
                        named.sort_by_key(|v| self.label(name, v).to_lowercase());
                        std::iter::once("none".to_string()).chain(named).collect()
                    }
                }
            };
            for v in view.filter(name).map(|f| f.values.clone()).unwrap_or_default() { if !values.contains(&v) { values.push(v) } }
            Field {
                name,
                label,
                icon: icon_of(name, None),
                values: values.into_iter().map(|v| Choice {
                    label: self.label(name, &v),
                    icon: icon_of(name, Some(&v)),
                    count: base.iter().filter(|r| self.value(r, name) == v).count(),
                    value: v,
                }).collect(),
            }
        }).collect()
    }
}
