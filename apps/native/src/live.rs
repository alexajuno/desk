// One session's conversation, as the server's live.ts tells it over /api/live/<session>: a hello with its items, new
// items as the transcript gains them, the reply streaming now in pieces, whether a turn runs, the questions waiting on
// the user, what runs beside the conversation, what holds the turn up, and the chat's own facts (its model, its mode,
// how full its context is). The thread connects again a second after the socket drops, as when desk restarts, and the
// hello brings back the whole conversation. The calls under it are the web app's (apps/web/src/sessions/live.ts).
use std::{thread, time::Duration};

use serde_json::{json, Value};
use smol::channel::Sender;
use tungstenite::Message;

use crate::net;

// An item of the server's transcript.ts: "you", "text", "thinking", "tool", "result", "note" or "came".
#[derive(Clone, Default, PartialEq, Hash)]
pub struct Item {
    pub kind: String,
    pub key: String,
    pub msg: String, // the API message a reply's block belongs to, which ends its streaming
    pub text: String,
    pub id: String, // a tool call's, which its result carries too
    pub name: String,
    pub summary: String,
    pub input: String,
    pub command: String, // a Bash call's command, whole
    pub at: u64,         // when it was made, in milliseconds
    pub more: u64,       // a command's output cut to its end: how many of its lines came before
    pub error: bool,
}

// A piece of the reply streaming now.
#[derive(Clone, Default, PartialEq, Hash)]
pub struct Block {
    pub msg: String,
    pub index: u64,
    pub kind: String, // text, thinking or tool_use
    pub name: String,
    pub text: String,
}

// A permission Claude asks for, or its questions (AskUserQuestion).
#[derive(Clone, PartialEq)]
pub struct Ask {
    pub id: String,
    pub tool: String,
    pub input: Value,
}

// Something Claude Code runs beside the conversation: a subagent, a background command, a watch.
#[derive(Clone, PartialEq)]
pub struct Running {
    pub tool: String,
    pub kind: String,
    pub description: String,
    pub agent: String,
    pub since: u64,
    pub doing: String,
    pub steps: u64,
}

pub enum Event {
    Hello { items: Vec<Item>, working: bool, asks: Vec<Ask>, partial: Vec<Block>, meta: Value },
    Items(Vec<Item>),
    Stream(Block),
    Working { working: bool, since: Option<u64>, asks: Option<Vec<Ask>>, tasks: Option<Vec<Running>>, status: Option<Value>, partial: Option<Vec<Block>> },
    Asks(Vec<Ask>),
    Tasks(Vec<Running>),
    Status(Value),
    Meta(Value),
}

fn string(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or("").to_string()
}

fn items(list: &Value) -> Vec<Item> {
    list.as_array().into_iter().flatten().map(|i| {
        let mut item = Item {
            kind: string(i, "t"),
            key: string(i, "key"),
            msg: string(i, "msg"),
            text: string(i, "text"),
            id: string(i, "id"),
            name: string(i, "name"),
            summary: string(i, "summary"),
            input: string(i, "input"),
            command: string(i, "command"),
            at: i["at"].as_u64().unwrap_or(0),
            more: i["more"].as_u64().unwrap_or(0),
            error: i["error"].as_bool().unwrap_or(false),
        };
        if item.kind == "came" {
            item.text = format!("From {}: {}", i["came"]["source"].as_str().unwrap_or(""), i["came"]["name"].as_str().unwrap_or(""));
        }
        item
    }).collect()
}

fn blocks(list: &Value) -> Vec<Block> {
    list.as_array().into_iter().flatten().map(block).collect()
}

fn block(b: &Value) -> Block {
    Block { msg: string(b, "msg"), index: b["index"].as_u64().unwrap_or(0), kind: string(b, "kind"), name: string(b, "name"), text: string(b, "text") }
}

fn asks(list: &Value) -> Vec<Ask> {
    list.as_array().into_iter().flatten().map(|a| Ask { id: string(a, "id"), tool: string(a, "tool"), input: a["input"].clone() }).collect()
}

fn tasks(list: &Value) -> Vec<Running> {
    list.as_array().into_iter().flatten().map(|t| Running {
        tool: string(t, "tool"),
        kind: string(t, "kind"),
        description: string(t, "description"),
        agent: string(t, "agent"),
        since: t["since"].as_u64().unwrap_or(0),
        doing: string(t, "doing"),
        steps: t["steps"].as_u64().unwrap_or(0),
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
    let mut socket = net::socket(&format!("/api/live/{session}"), Duration::from_secs(3))?;
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
        let some = |k: &str| e.get(k).filter(|v| !v.is_null());
        let event = match e["type"].as_str() {
            Some("hello") => Event::Hello {
                items: items(&e["items"]),
                working: e["working"].as_bool().unwrap_or(false),
                asks: asks(&e["asks"]),
                partial: blocks(&e["partial"]),
                meta: e["meta"].clone(),
            },
            Some("items") => Event::Items(items(&e["items"])),
            Some("stream") => Event::Stream(block(&e)),
            Some("working") => Event::Working {
                working: e["working"].as_bool().unwrap_or(false),
                since: e["since"].as_u64(),
                asks: some("asks").map(asks),
                tasks: some("tasks").map(tasks),
                status: e.get("status").cloned(),
                partial: some("partial").map(blocks),
            },
            Some("asks") => Event::Asks(asks(&e["asks"])),
            Some("tasks") => Event::Tasks(tasks(&e["tasks"])),
            Some("status") => Event::Status(e["status"].clone()),
            Some("meta") => Event::Meta(e["meta"].clone()),
            _ => continue,
        };
        events.send_blocking(event)?;
    }
}

// A file attached in the composer: an image Claude takes inline goes in the message, any other file desk keeps on
// disk and the message names by its path (the server's uploads.ts).
#[derive(Clone)]
pub struct Attachment {
    pub name: String,
    pub path: std::path::PathBuf,
    pub media_type: Option<&'static str>, // an image's, which goes inline
    pub data: String,                      // base64
}

pub fn send(session: &str, uuid: &str, text: &str, attached: &[Attachment]) -> Result<Value, String> {
    let images: Vec<Value> = attached.iter().filter_map(|a| a.media_type.map(|m| json!({"media_type": m, "data": a.data}))).collect();
    let files: Vec<Value> = attached.iter().filter(|a| a.media_type.is_none()).map(|a| json!({"name": a.name, "data": a.data})).collect();
    let mut body = json!({"text": text, "images": images, "uuid": uuid});
    if !files.is_empty() { body["files"] = json!(files) }
    net::post(&format!("/api/live/{session}/send"), body)
}

pub fn interrupt(session: &str) -> Result<Value, String> {
    net::post(&format!("/api/live/{session}/interrupt"), json!({}))
}

pub fn answer(session: &str, ask: &str, result: Value) -> Result<Value, String> {
    net::post(&format!("/api/live/{session}/answer"), json!({"ask": ask, "result": result}))
}

pub fn set_auto(session: &str, auto: bool) -> Result<Value, String> {
    net::post(&format!("/api/live/{session}/auto"), json!({"auto": auto}))
}

pub fn pick(session: &str, set: Value) -> Result<Value, String> {
    net::post(&format!("/api/live/{session}/model"), set)
}

// A command's whole output, of which the chat holds only the end.
pub fn result(session: &str, tool: &str) -> Result<String, String> {
    net::get(&format!("/api/live/{session}/result/{tool}")).map(|v| string(&v, "text"))
}

// The models to pick from, each with the efforts it takes (the server's models.ts, menu).
#[derive(Clone)]
pub struct Model {
    pub value: String,
    pub name: String,
    pub efforts: Vec<String>,
}

pub fn models() -> Result<Vec<Model>, String> {
    let list = net::get("/api/models")?;
    Ok(list.as_array().into_iter().flatten().map(|m| Model {
        value: string(m, "value"),
        name: string(m, "name"),
        efforts: m["efforts"].as_array().into_iter().flatten().filter_map(|e| e.as_str().map(str::to_string)).collect(),
    }).collect())
}

pub const EFFORTS: [(&str, &str); 5] = [("low", "Low"), ("medium", "Medium"), ("high", "High"), ("xhigh", "Extra high"), ("max", "Max")];

pub fn effort_name(effort: &str) -> &str {
    EFFORTS.iter().find(|(v, _)| *v == effort).map(|(_, n)| *n).unwrap_or(effort)
}
