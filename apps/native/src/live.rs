// One session's conversation, as the server's live.ts tells it over /api/live/<session>: a hello with its items, new
// items as the transcript gains them, the reply streaming now in pieces, and whether a turn runs. The thread connects
// again a second after the socket drops, as when desk restarts, and the hello brings back the whole conversation.
use std::{thread, time::Duration};

use serde_json::{json, Value};
use smol::channel::Sender;
use tungstenite::Message;

use crate::net;

// An item of transcript.ts: "you", "text", "tool", "note" or "came"; results and thoughts are left out.
#[derive(Clone)]
pub struct Item {
    pub kind: String,
    pub text: String,
    pub msg: String, // the API message a reply's block belongs to, which ends its streaming
}

pub enum Event {
    Hello { items: Vec<Item>, working: bool },
    Items(Vec<Item>),
    // a piece of the reply streaming now: the message and block it belongs to, its kind, its text
    Stream { msg: String, index: u64, kind: String, text: String },
    Working(bool),
}

fn items(list: &Value) -> Vec<Item> {
    list.as_array().into_iter().flatten().filter_map(|i| {
        let kind = i["t"].as_str()?.to_string();
        if kind == "result" || kind == "thinking" { return None }
        let field = |k: &str| i[k].as_str().filter(|s| !s.is_empty()).map(str::to_string);
        let text = match kind.as_str() {
            "tool" => field("summary").or_else(|| field("command")).unwrap_or_else(|| i["name"].as_str().unwrap_or("").to_string()),
            "came" => format!("From {}: {}", i["came"]["source"].as_str().unwrap_or(""), i["came"]["name"].as_str().unwrap_or("")),
            _ => field("text")?,
        };
        Some(Item { kind, text, msg: i["msg"].as_str().unwrap_or("").to_string() })
    }).collect()
}

pub fn follow(session: String, events: Sender<Event>) {
    thread::spawn(move || loop {
        if let Err(error) = read(&session, &events) {
            eprintln!("desk live {session}: {error}");
        }
        if events.is_closed() { return }
        thread::sleep(Duration::from_secs(1));
    });
}

fn read(session: &str, events: &Sender<Event>) -> Result<(), Box<dyn std::error::Error>> {
    let mut socket = net::socket(&format!("/api/live/{session}"))?;
    socket.send(Message::text(json!({"type": "visible", "visible": true}).to_string()))?;
    loop {
        let text = match socket.read() {
            Ok(Message::Text(text)) => text,
            Ok(_) => continue,
            Err(e) if net::timed_out(&e) => {
                if events.is_closed() { return Ok(()) }
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        let e: Value = serde_json::from_str(&text)?;
        let event = match e["type"].as_str() {
            Some("hello") => Event::Hello { items: items(&e["items"]), working: e["working"].as_bool().unwrap_or(false) },
            Some("items") => Event::Items(items(&e["items"])),
            Some("stream") => Event::Stream {
                msg: e["msg"].as_str().unwrap_or("").into(),
                index: e["index"].as_u64().unwrap_or(0),
                kind: e["kind"].as_str().unwrap_or("").into(),
                text: e["text"].as_str().unwrap_or("").into(),
            },
            Some("working") => Event::Working(e["working"].as_bool().unwrap_or(false)),
            _ => continue,
        };
        events.send_blocking(event)?;
    }
}

pub fn send(session: &str, text: &str) -> Result<Value, String> {
    let uuid = uuid::Uuid::new_v4().to_string();
    net::post(&format!("/api/live/{session}/send"), json!({"text": text, "uuid": uuid}))
}
