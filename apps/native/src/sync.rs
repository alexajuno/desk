// desk's live sync (apps/server/src/sync.ts), read on a thread of its own: the snapshot of every issue, then each
// change as it is written, and the page of the issue the window shows, again each time it changes. When desk restarts,
// it connects again with no log, gets a fresh snapshot, and names the issue it shows again.
use std::{collections::HashMap, thread, time::Duration};

use serde_json::{json, Value};
use smol::channel::{Receiver, Sender};
use tungstenite::Message;

use crate::net;

#[derive(Clone, Default)]
pub struct Issue {
    pub slug: String,
    pub title: String,
    pub state: String,
    pub priority: String,
    pub team: Option<String>,
    pub project: Option<String>,
    pub folder: Option<String>,
}

// A row of the Inbox (the server's inbox.ts): what a session last did for you, a chat with no issue, an issue to
// settle, or a Slack or mail thread the firewall let through.
#[derive(Clone, Default, PartialEq)]
pub struct InboxRow {
    pub id: String,
    pub slug: String, // what the row opens: an issue's slug, a chat's id, or a thread's
    pub issue: bool,
    pub session: Option<String>,
    pub title: String,
    pub agent: Option<String>,
    pub why: String,
    pub says: String,
    pub kind: String, // "needs", or "review" where Go or Approve decides it
    pub waits: bool,  // listed, read or not, until answered
    pub at: f64,      // when it happened, in seconds
    pub read: bool,
    pub gone: bool,
    pub source: Option<String>, // "slack" or "mail"
    pub who: Option<String>,
}

// A tab a chat's session has open in desk's Chrome (the server's tabs.ts), which its Browser shows.
#[derive(Clone, Default, PartialEq)]
pub struct Tab {
    pub target: String, // Chrome's id for it
    pub session: String,
    pub url: String,
    pub title: String,
    pub opened: String, // when desk first heard of it, which orders the strip
}

// The rows of the other tables desk holds (the server's db.ts, HELD), as desk sends them, by their key: teams, projects,
// milestones, a project's activity and the chats.
pub type Rows = HashMap<String, HashMap<String, Value>>;
pub const OTHERS: [&str; 5] = ["teams", "projects", "milestones", "activity", "chats"];

pub enum Event {
    Snapshot(Vec<Issue>, Vec<InboxRow>, Rows, Vec<Tab>),
    Tab { target: String, row: Option<Tab> },
    // Claude opened a tab, or works in one: the chat's Browser shows it (the server's tabs.ts, used)
    Browser { session: String, target: String },
    // the session closed its last tab: its Browser closes
    BrowserClosed(String),
    // a row of another table changed, or went (None)
    Row { table: String, key: String, row: Option<Value> },
    // the sidebar's sessions and where each open issue's stands (pages.ts, framePage), on connect and when it changed
    Frame(Value),
    Issue { slug: String, row: Option<Issue> },
    Inbox { id: String, row: Option<InboxRow> },
    // the issue shown, as its page draws it (pages.ts, issuePageJson)
    Page { slug: String, page: Value },
    // Claude opened a chat's terminal: the window shows it beside that chat (the server's sync.ts, showTerminal)
    Terminal(String),
}

fn issue(row: &Value) -> Option<Issue> {
    let text = |k: &str| row.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let some = |k: &str| row.get(k).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_string);
    row.is_object().then(|| Issue { slug: text("slug"), title: text("title"), state: text("state"), priority: text("priority"),
        team: some("team"), project: some("project"), folder: some("folder") })
}

// A key as text, a number's too (milestones and activity are keyed by their id).
fn text_of(v: &Value) -> String {
    v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())
}

fn tab(row: &Value) -> Option<Tab> {
    let text = |k: &str| row.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    row.is_object().then(|| Tab { target: text("target"), session: text("session"), url: text("url"), title: text("title"), opened: text("opened") })
}

fn inbox_row(row: &Value) -> Option<InboxRow> {
    let text = |k: &str| row.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let some = |k: &str| row.get(k).and_then(Value::as_str).map(str::to_string);
    let set = |k: &str| row.get(k).is_some_and(|v| !v.is_null());
    row.is_object().then(|| InboxRow {
        id: text("id"),
        slug: text("slug"),
        issue: row["issue"].as_bool().unwrap_or(false),
        session: some("session"),
        title: text("title"),
        agent: some("agent"),
        why: text("why"),
        says: text("says"),
        kind: text("kind"),
        waits: row["waits"].as_bool().unwrap_or(false),
        at: row["at"].as_f64().unwrap_or(0.),
        read: set("read"),
        gone: set("gone"),
        source: some("source"),
        who: some("who"),
    })
}

// `shows` names the issue the window shows, whose page desk then sends.
pub fn start(events: Sender<Event>, shows: Receiver<String>) {
    thread::spawn(move || {
        let mut shown: Option<String> = None;
        loop {
            if let Err(error) = follow(&events, &shows, &mut shown) {
                eprintln!("desk sync: {error}");
            }
            if events.is_closed() { return }
            thread::sleep(Duration::from_secs(2));
        }
    });
}

fn follow(events: &Sender<Event>, shows: &Receiver<String>, shown: &mut Option<String>) -> Result<(), Box<dyn std::error::Error>> {
    let mut socket = net::socket("/api/sync?log=&since=", Duration::from_millis(150))?;
    let show = |socket: &mut net::Socket, slug: &str| socket.send(Message::text(json!({"type": "show", "slug": slug}).to_string()));
    if let Some(slug) = shown.as_deref() { show(&mut socket, slug)? }
    loop {
        while let Ok(slug) = shows.try_recv() {
            show(&mut socket, &slug)?;
            *shown = Some(slug);
        }
        let text = match socket.read() {
            Ok(Message::Text(text)) => text,
            Ok(_) => continue,
            Err(e) if net::timed_out(&e) => {
                if events.is_closed() { return Ok(()) }
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        let message: Value = serde_json::from_str(&text)?;
        match message["type"].as_str() {
            Some("snapshot") => {
                let rows = message["rows"]["issues"].as_array().cloned().unwrap_or_default();
                let inbox = message["rows"]["inbox"].as_array().cloned().unwrap_or_default();
                let others: Rows = OTHERS.iter().map(|table| {
                    let key = if matches!(*table, "teams" | "projects") { "slug" } else { "id" };
                    let rows = message["rows"][*table].as_array().into_iter().flatten();
                    (table.to_string(), rows.map(|row| (text_of(&row[key]), row.clone())).collect())
                }).collect();
                let tabs = message["rows"]["tabs"].as_array().into_iter().flatten().filter_map(tab).collect();
                events.send_blocking(Event::Snapshot(rows.iter().filter_map(issue).collect(), inbox.iter().filter_map(inbox_row).collect(), others, tabs))?;
            }
            Some("changes") => {
                for change in message["changes"].as_array().into_iter().flatten() {
                    let key = text_of(&change["key"]);
                    if change["kind"] == "issues" {
                        events.send_blocking(Event::Issue { slug: key, row: issue(&change["row"]) })?;
                    } else if change["kind"] == "tabs" {
                        events.send_blocking(Event::Tab { target: key, row: tab(&change["row"]) })?;
                    } else if change["kind"] == "inbox" {
                        events.send_blocking(Event::Inbox { id: key, row: inbox_row(&change["row"]) })?;
                    } else if let Some(table) = OTHERS.iter().find(|t| change["kind"] == **t) {
                        let row = Some(change["row"].clone()).filter(Value::is_object);
                        events.send_blocking(Event::Row { table: table.to_string(), key, row })?;
                    }
                }
            }
            Some("frame") => events.send_blocking(Event::Frame(message["frame"].clone()))?,
            Some("terminal") => {
                events.send_blocking(Event::Terminal(message["session"].as_str().unwrap_or("").to_string()))?;
            }
            Some("browser") => {
                let text = |k: &str| message[k].as_str().unwrap_or("").to_string();
                events.send_blocking(Event::Browser { session: text("session"), target: text("target") })?;
            }
            Some("browser-closed") => {
                events.send_blocking(Event::BrowserClosed(message["session"].as_str().unwrap_or("").to_string()))?;
            }
            Some("page") => {
                let slug = message["slug"].as_str().unwrap_or("").to_string();
                events.send_blocking(Event::Page { slug, page: message["page"].clone() })?;
            }
            _ => {}
        }
    }
}
