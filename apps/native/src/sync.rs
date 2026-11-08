// desk's live sync (apps/server/src/sync.ts), read on a thread of its own: the snapshot of every issue, then each
// change as it is written. The socket answers only a loopback peer whose Origin is desk itself, as the page's is.
// When desk restarts, it connects again with no log, and gets a fresh snapshot.
use std::{thread, time::Duration};

use serde_json::Value;
use smol::channel::Sender;
use tungstenite::{client::IntoClientRequest, Message};

#[derive(Clone)]
pub struct Issue {
    pub slug: String,
    pub title: String,
    pub state: String,
    pub priority: String,
}

pub enum Event {
    Snapshot(Vec<Issue>),
    Issue { slug: String, row: Option<Issue> },
}

fn issue(row: &Value) -> Option<Issue> {
    let text = |k: &str| row.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    row.is_object().then(|| Issue { slug: text("slug"), title: text("title"), state: text("state"), priority: text("priority") })
}

pub fn start(host: String, events: Sender<Event>) {
    thread::spawn(move || loop {
        if let Err(error) = follow(&host, &events) {
            eprintln!("desk sync: {error}");
        }
        if events.is_closed() {
            return;
        }
        thread::sleep(Duration::from_secs(2));
    });
}

fn follow(host: &str, events: &Sender<Event>) -> Result<(), Box<dyn std::error::Error>> {
    let mut request = format!("ws://{host}/api/sync?log=&since=").into_client_request()?;
    request.headers_mut().insert("Origin", format!("http://{host}").parse()?);
    let (mut socket, _) = tungstenite::connect(request)?;
    loop {
        let Message::Text(text) = socket.read()? else { continue };
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
            _ => {}
        }
    }
}
