// desk's live sync (apps/server/src/sync.ts), read on a thread of its own: the snapshot of every issue, then each
// change as it is written, and the page of the issue the window shows, again each time it changes. When desk restarts,
// it connects again with no log, gets a fresh snapshot, and names the issue it shows again.
use std::{thread, time::Duration};

use serde_json::{json, Value};
use smol::channel::{Receiver, Sender};
use tungstenite::Message;

use crate::net;

#[derive(Clone, Default)]
pub struct Issue {
    pub slug: String,
    pub title: String,
    pub state: String,
}

pub enum Event {
    Snapshot(Vec<Issue>),
    Issue { slug: String, row: Option<Issue> },
    // the issue shown, as its page draws it (pages.ts, issuePageJson)
    Page { slug: String, page: Value },
}

fn issue(row: &Value) -> Option<Issue> {
    let text = |k: &str| row.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    row.is_object().then(|| Issue { slug: text("slug"), title: text("title"), state: text("state") })
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
                events.send_blocking(Event::Snapshot(rows.iter().filter_map(issue).collect()))?;
            }
            Some("changes") => {
                for change in message["changes"].as_array().into_iter().flatten() {
                    if change["kind"] == "issues" {
                        let slug = change["key"].as_str().unwrap_or("").to_string();
                        events.send_blocking(Event::Issue { slug, row: issue(&change["row"]) })?;
                    }
                }
            }
            Some("page") => {
                let slug = message["slug"].as_str().unwrap_or("").to_string();
                events.send_blocking(Event::Page { slug, page: message["page"].clone() })?;
            }
            _ => {}
        }
    }
}
