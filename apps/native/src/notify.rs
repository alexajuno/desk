// The Inbox's desktop notifications, as the web's (store/inbox.ts): an unread row the window did not have becomes one,
// unless the window has the focus, where the count shows it; the rows it finds as it opens are not news. A Slack or
// mail thread's row goes by the firewall's verdict instead, its why: now pops up even with the focus, when sent in the
// last 15 minutes, and later never does.
//
// They go to the desktop's notification server (org.freedesktop.Notifications) over one D-Bus connection, kept for the
// window's life: a newer one for the same row takes the older's place, as the web's tag does, and a click opens the
// row in the Inbox and asks desk to bring the window forward, since Hyprland leaves a window's own request unanswered
// (the server's window.ts).
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use gpui_kit::*;
use serde_json::json;
use smol::stream::StreamExt;
use zbus::zvariant::Value;

use crate::sync::InboxRow;
use crate::{net, Desk};

const FRESH: f64 = 15. * 60.;
const NAME: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";

struct Note {
    tag: String, // the row's slug: a newer note for it takes this one's place
    title: String,
    body: String,
}

pub(crate) struct Notes {
    send: smol::channel::Sender<Note>,
    had: Option<HashSet<String>>, // the unread rows last seen, as "<id>:<at>", once the first rows came
}

fn key(row: &InboxRow) -> String {
    format!("{}:{}", row.id, row.at)
}

fn pops_up(row: &InboxRow, watched: bool, now: f64) -> bool {
    if row.source.is_none() || (row.why != "now" && row.why != "later") { return !watched }
    row.why == "now" && row.at > now - FRESH
}

impl Notes {
    // Connects, and hands each click back to the window as the row's slug.
    pub(crate) fn start(window: &Window, cx: &mut Context<Desk>) -> Self {
        let (send, notes) = smol::channel::unbounded();
        let (clicked, clicks) = smol::channel::unbounded();
        cx.background_spawn(async move {
            if let Err(e) = serve(notes, clicked).await { eprintln!("desk: no desktop notifications: {e}") }
        })
        .detach();
        cx.spawn_in(window, async move |desk, cx| {
            while let Ok(slug) = clicks.recv().await {
                if desk.update_in(cx, |desk, window, cx| desk.open_note(slug, window, cx)).is_err() { break }
            }
        })
        .detach();
        Self { send, had: None }
    }
}

impl Desk {
    // The unread rows the window had not seen yet, each told once (inbox_changed).
    pub(crate) fn notify_new(&mut self, window: &Window) {
        let unread: Vec<&InboxRow> = self.inbox.values().filter(|r| !r.read).collect();
        let Some(had) = self.notes.had.replace(unread.iter().map(|r| key(r)).collect()) else { return };
        let watched = window.is_window_active();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or_default();
        for row in unread.into_iter().filter(|r| !had.contains(&key(r)) && pops_up(r, watched, now)) {
            // it reads as the row: the issue's title, then what its session did, or the agent; a thread's place, then who
            // wrote and what it needs
            let title = Some(row).filter(|r| r.issue).and_then(|r| self.all.get(&r.slug)).map(|i| i.title.clone()).filter(|t| !t.is_empty());
            let body = match &row.source {
                Some(_) => row.says.clone(),
                None => format!("{} {}", if row.issue { "Session" } else { row.agent.as_deref().unwrap_or("Chat") }, row.says),
            };
            let _ = self.notes.send.try_send(Note { tag: row.slug.clone(), title: title.unwrap_or_else(|| row.title.clone()), body });
        }
    }

    // A note clicked: its row opens in the Inbox, and desk brings forward the window, which by then says it shows the
    // Inbox (window_title).
    fn open_note(&mut self, slug: String, window: &mut Window, cx: &mut Context<Self>) {
        self.show_inbox(window, cx);
        if self.inbox.values().any(|r| r.slug == slug) { self.open_row(Some(slug), window, cx) } else { self.pending_row = Some(slug) }
        cx.background_spawn(async { net::post("/raise", json!({"title": "Inbox · desk"})) }).detach();
        cx.notify();
    }
}

enum Got {
    Note(Note),
    Signal(zbus::Message),
    Gone,
}

// Each note to the notification server, and each click on one back to the window, until the window goes.
async fn serve(notes: smol::channel::Receiver<Note>, clicked: smol::channel::Sender<String>) -> zbus::Result<()> {
    let bus = zbus::Connection::session().await?;
    let rule = zbus::MatchRule::builder().msg_type(zbus::message::Type::Signal).interface(NAME)?.path(PATH)?.build();
    let mut signals = zbus::MessageStream::for_match_rule(rule, &bus, None).await?;
    let mut shown: HashMap<String, u32> = HashMap::new(); // the server's id for each row's note still shown, by its slug
    loop {
        let got = smol::future::or(async { notes.recv().await.map_or(Got::Gone, Got::Note) }, async {
            match signals.next().await {
                Some(Ok(signal)) => Got::Signal(signal),
                Some(Err(_)) | None => Got::Gone,
            }
        })
        .await;
        match got {
            Got::Note(note) => {
                let hints = HashMap::from([("desktop-entry", Value::from("desk"))]);
                let replaces = shown.get(&note.tag).copied().unwrap_or(0);
                let call = (
                    "desk", replaces, "desk", note.title.as_str(), note.body.as_str(), vec!["default", "Open"], hints, -1i32,
                );
                match bus.call_method(Some(NAME), PATH, Some(NAME), "Notify", &call).await {
                    Ok(reply) => if let Ok(id) = reply.body().deserialize::<u32>() { shown.insert(note.tag, id); },
                    Err(e) => eprintln!("desk: the notification server refused a note: {e}"),
                }
            }
            Got::Signal(signal) => {
                let header = signal.header();
                match header.member().map(|m| m.as_str()) {
                    Some("ActionInvoked") => {
                        let Ok((id, action)) = signal.body().deserialize::<(u32, String)>() else { continue };
                        let tag = shown.iter().find(|(_, shown)| **shown == id).map(|(tag, _)| tag.clone());
                        if let Some(tag) = tag.filter(|_| action == "default") { let _ = clicked.send(tag).await; }
                    }
                    Some("NotificationClosed") => {
                        let Ok((id, _)) = signal.body().deserialize::<(u32, u32)>() else { continue };
                        shown.retain(|_, shown| *shown != id);
                    }
                    _ => {}
                }
            }
            Got::Gone => return Ok(()),
        }
    }
}
