// A chat's Browser, a view of the right half, as the web app's (sessions/Browser.tsx): the tabs its session has open in
// desk's headless Chrome (the server's chrome.ts and relay.ts), as a strip, each with a × that closes it for real, then
// back, forward, reload and the open tab's address, then the page. The strip has no new tab, as the session opens its
// tabs, and closing one is yours alone ("models are unreliable", "i'll manually close that tab", the user, 5 Nov).
//
// The page is a picture of the tab, which desk sends each time it changes over the tab's socket (the server's cast.ts),
// laid out at the half's size and drawn at the screen's scale, so it is sharp. Your mouse, the wheel and your keys go
// back to the tab, and so does what the input method writes, Vietnamese included, which the page shows underlined where
// you type until it is written, as Chrome shows it. Headless Chrome has no clipboard of yours: Ctrl C and Ctrl X put
// what is selected in the page on yours, and Ctrl V types yours into the page. What Chrome would draw outside the page,
// an alert box, a confirm, a prompt, "Leave site?" and a file chooser, is drawn here as a card over it.
use std::cell::Cell;
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;
use std::sync::Arc;
use std::{thread, time::Duration};

use gpui_kit::base::StyledExt;
use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::{json, Value};
use smol::channel::{Receiver, Sender};
use tungstenite::Message;

use crate::sync::Tab;
use crate::{net, theme};

const BIGGEST: u64 = 100 * 1024 * 1024; // bytes in one file given a page: one message on desk's socket, as ws takes at most

enum Out {
    Said(Value),
    File(Vec<u8>),
}

enum In {
    On,
    Picture(Arc<RenderImage>),
    Said(Value),
    Closed(u16),
}

// A picture as GPUI draws it: desk sends JPEGs, which GPUI takes in BGRA.
fn picture(jpeg: &[u8]) -> Option<Arc<RenderImage>> {
    let mut pixels = image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg).ok()?.into_rgba8();
    for px in pixels.chunks_exact_mut(4) { px.swap(0, 2) }
    Some(Arc::new(RenderImage::new(vec![image::Frame::new(pixels)])))
}

// The tab's socket, on a thread of its own, which also makes each picture drawable: what you do goes out, the pictures
// and what desk tells come in. It ends with the socket, or once the page is gone.
fn watch(target: String, (w, h, scale): (u32, u32, f32), out: Receiver<Out>, came: Sender<In>) {
    thread::spawn(move || {
        let run = || -> Result<(), Box<dyn std::error::Error>> {
            let mut socket = net::socket(&format!("/api/tabs/{target}/screen?w={w}&h={h}&scale={scale}"), Duration::from_millis(15))?;
            came.send_blocking(In::On)?;
            loop {
                while let Ok(said) = out.try_recv() {
                    socket.send(match said { Out::Said(said) => Message::text(said.to_string()), Out::File(bytes) => Message::binary(bytes) })?;
                }
                match socket.read() {
                    Ok(Message::Binary(jpeg)) => { if let Some(p) = picture(&jpeg) { came.send_blocking(In::Picture(p))? } }
                    Ok(Message::Text(text)) => { if let Ok(said) = serde_json::from_str(&text) { came.send_blocking(In::Said(said))? } }
                    Ok(Message::Close(frame)) => {
                        came.send_blocking(In::Closed(frame.map(|f| u16::from(f.code)).unwrap_or(1005)))?;
                        return Ok(());
                    }
                    Ok(_) => {}
                    Err(e) if net::timed_out(&e) => {
                        if out.is_closed() || came.is_closed() {
                            let _ = socket.close(None);
                            return Ok(());
                        }
                    }
                    Err(e) => return Err(e.into()),
                }
            }
        };
        if let Err(error) = run() {
            eprintln!("desk tab {target}: {error}");
            let _ = came.send_blocking(In::Closed(1006));
        }
    });
}

// A key as the page's DOM names it: its key, its code and its old keyCode, as Chrome's DevTools protocol takes them,
// on a US keyboard, which is the user's.
fn dom_key(k: &Keystroke) -> Option<(String, String, u32)> {
    let named = |key: &str, code: &str, kc: u32| Some((key.to_string(), code.to_string(), kc));
    let key = k.key.as_str();
    match key {
        "enter" => named("Enter", "Enter", 13),
        "escape" => named("Escape", "Escape", 27),
        "backspace" => named("Backspace", "Backspace", 8),
        "tab" => named("Tab", "Tab", 9),
        "space" => named(" ", "Space", 32),
        "left" => named("ArrowLeft", "ArrowLeft", 37),
        "up" => named("ArrowUp", "ArrowUp", 38),
        "right" => named("ArrowRight", "ArrowRight", 39),
        "down" => named("ArrowDown", "ArrowDown", 40),
        "home" => named("Home", "Home", 36),
        "end" => named("End", "End", 35),
        "pageup" => named("PageUp", "PageUp", 33),
        "pagedown" => named("PageDown", "PageDown", 34),
        "delete" => named("Delete", "Delete", 46),
        "insert" => named("Insert", "Insert", 45),
        _ if key.len() > 1 && key.starts_with('f') && key[1..].parse::<u32>().is_ok_and(|n| (1..=12).contains(&n)) => {
            let n = key[1..].parse::<u32>().ok()?;
            Some((format!("F{n}"), format!("F{n}"), 111 + n))
        }
        _ if key.chars().count() == 1 => {
            let c = key.chars().next()?;
            let typed = k.key_char.clone().filter(|t| t.chars().count() == 1).unwrap_or_else(|| c.to_string());
            let (code, kc) = match c.to_ascii_lowercase() {
                l @ 'a'..='z' => (format!("Key{}", l.to_ascii_uppercase()), l.to_ascii_uppercase() as u32),
                d @ '0'..='9' => (format!("Digit{d}"), d as u32),
                ')' => ("Digit0".into(), 48), '!' => ("Digit1".into(), 49), '@' => ("Digit2".into(), 50), '#' => ("Digit3".into(), 51),
                '$' => ("Digit4".into(), 52), '%' => ("Digit5".into(), 53), '^' => ("Digit6".into(), 54), '&' => ("Digit7".into(), 55),
                '*' => ("Digit8".into(), 56), '(' => ("Digit9".into(), 57),
                ';' | ':' => ("Semicolon".into(), 186), '=' | '+' => ("Equal".into(), 187), ',' | '<' => ("Comma".into(), 188),
                '-' | '_' => ("Minus".into(), 189), '.' | '>' => ("Period".into(), 190), '/' | '?' => ("Slash".into(), 191),
                '`' | '~' => ("Backquote".into(), 192), '[' | '{' => ("BracketLeft".into(), 219), '\\' | '|' => ("Backslash".into(), 220),
                ']' | '}' => ("BracketRight".into(), 221), '\'' | '"' => ("Quote".into(), 222),
                _ => (String::new(), 0),
            };
            Some((typed, code, kc))
        }
        _ => None,
    }
}

// Chrome's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8.
fn mods(m: &Modifiers) -> u32 {
    m.alt as u32 | (m.control as u32) << 1 | (m.platform as u32) << 2 | (m.shift as u32) << 3
}

// What you typed in the address, as Chrome's bar takes it: an address as it is, a site with no scheme over https, one
// on this laptop or your network over http, and anything else a Google search.
fn address(typed: &str) -> String {
    let s = typed.trim();
    let lower = s.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower == "about:blank" { return s.to_string() }
    let host = s.split(['/', '?', '#']).next().unwrap_or("");
    let bare = host.split(':').next().unwrap_or("");
    let local = bare == "localhost" || bare.split('.').count() == 4 && bare.split('.').all(|p| p.parse::<u8>().is_ok()) || host.starts_with('[');
    if local { return format!("http://{s}") }
    let tld = bare.rsplit_once('.').map(|(_, t)| t.len() >= 2 && t.chars().all(|c| c.is_ascii_alphabetic())).unwrap_or(false);
    if !s.contains(char::is_whitespace) && tld { return format!("https://{s}") }
    let query: String = s.bytes().map(|b| match b {
        b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
        _ => format!("%{b:02X}"),
    }).collect();
    format!("https://www.google.com/search?q={query}")
}

// An address's host and the rest, as Chrome's bar shows it, the host brighter; any other address, such as data: or
// about:blank, has none.
fn split(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let at = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (host, tail) = rest.split_at(at);
    Some((host.to_string(), if tail == "/" { String::new() } else { tail.to_string() }))
}

fn site(url: &str) -> Option<String> {
    let scheme = if url.starts_with("https://") { "https://" } else if url.starts_with("http://") { "http://" } else { return None };
    split(url).map(|(host, _)| format!("{scheme}{host}"))
}

#[derive(PartialEq)]
enum Stand {
    Waiting,
    On,
    Away,
    Failed(String),
}

#[derive(Clone)]
struct Dialog {
    kind: String, // alert, confirm, prompt or beforeunload
    message: String,
}

// The tab shown: its toolbar, its picture, and its socket.
pub struct TabPage {
    tab: Tab,
    out: Option<Sender<Out>>,
    stand: Stand,
    picture: Option<Arc<RenderImage>>,
    stale: Vec<Arc<RenderImage>>, // pictures drawn before, for the window to let go of
    moves: (bool, bool),           // where the tab can go in its history: back, forward
    dialog: Option<Dialog>,
    prompt: Option<Entity<InputState>>, // a prompt's answer, while one asks
    prompt_text: Option<String>,        // a prompt's text at first, until its box is made
    held: bool,                         // a box open in the page since before desk looked, which it cannot read
    chooser: Option<bool>,              // a file chooser your click opened: whether it takes many
    giving: String,                     // what is being given the page, while it goes
    address: Option<Entity<InputState>>, // the address, while you edit it
    pub focus: FocusHandle,
    card: FocusHandle,
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>, // the page's box, as laid out
    size: Option<(u32, u32, f32)>,             // what desk was told: the box's size and the screen's scale
    button: Option<&'static str>,              // the mouse button held, for a drag
    marked: Option<String>,                    // what the input method holds before it writes it
    caret: Point<Pixels>,                      // where you last clicked, for the input method's list of words
    tries: u32,
    _read: Option<Task<()>>,
    _retry: Option<Task<()>>,
    _resize: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl TabPage {
    fn new(tab: Tab, cx: &mut Context<Self>) -> Self {
        Self {
            tab,
            out: None,
            stand: Stand::Waiting,
            picture: None,
            stale: Vec::new(),
            moves: (false, false),
            dialog: None,
            prompt: None,
            prompt_text: None,
            held: false,
            chooser: None,
            giving: String::new(),
            address: None,
            focus: cx.focus_handle(),
            card: cx.focus_handle(),
            bounds: Rc::new(Cell::new(None)),
            size: None,
            button: None,
            marked: None,
            caret: point(px(0.), px(0.)),
            tries: 0,
            _read: None,
            _retry: None,
            _resize: None,
            _subscriptions: Vec::new(),
        }
    }

    // Watch the tab once the box has its size.
    fn connect(&mut self, cx: &mut Context<Self>) {
        let Some(size) = self.size else { return };
        if self.out.is_some() { return }
        let (out, out_rx) = smol::channel::unbounded();
        let (came_tx, came) = smol::channel::unbounded();
        watch(self.tab.target.clone(), size, out_rx, came_tx);
        self.out = Some(out);
        self._read = Some(cx.spawn(async move |this, cx| {
            while let Ok(first) = came.recv().await {
                let mut batch = vec![first];
                while let Ok(more) = came.try_recv() { batch.push(more) }
                // of the pictures that came at once, only the last is drawn
                let last = batch.iter().rposition(|e| matches!(e, In::Picture(_)));
                let batch: Vec<In> = batch.into_iter().enumerate().filter(|(n, e)| !matches!(e, In::Picture(_)) || Some(*n) == last).map(|(_, e)| e).collect();
                if this.update(cx, |page, cx| { for event in batch { page.took(event, cx) } cx.notify() }).is_err() { return }
            }
        }));
    }

    fn took(&mut self, event: In, cx: &mut Context<Self>) {
        match event {
            In::On => { self.tries = 0; self.stand = Stand::On }
            In::Picture(p) => { if let Some(old) = self.picture.replace(p) { self.stale.push(old) } }
            In::Said(said) => self.told(said, cx),
            // desk restarting drops the socket: watch again, once a second for a minute
            In::Closed(code) => {
                self.out = None;
                if code == 4404 { self.stand = Stand::Failed("The tab closed.".into()); return }
                self.tries += 1;
                if self.tries > 60 { self.stand = Stand::Failed("desk does not answer.".into()); return }
                self.stand = Stand::Away;
                self._retry = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_secs(1)).await;
                    let _ = this.update(cx, |page, cx| page.connect(cx));
                }));
            }
        }
    }

    // What desk tells besides pictures (cast.ts): where the tab can go, what the page asks of you, and what you copied.
    fn told(&mut self, said: Value, cx: &mut Context<Self>) {
        if let Some(dialog) = said.get("dialog") {
            self.prompt = None;
            self.dialog = dialog.is_object().then(|| Dialog {
                kind: dialog["type"].as_str().unwrap_or("alert").to_string(),
                message: dialog["message"].as_str().unwrap_or("").to_string(),
            });
            if let Some(d) = &self.dialog { if d.kind == "prompt" { self.prompt_text = Some(dialog["prompt"].as_str().unwrap_or("").to_string()) } }
        } else if let Some(held) = said.get("held") {
            self.held = held.as_bool().unwrap_or(false);
        } else if let Some(chooser) = said.get("chooser") {
            self.giving.clear();
            self.chooser = chooser.is_object().then(|| chooser["multiple"].as_bool().unwrap_or(false));
            if self.chooser.is_some() { self.choose(cx) }
        } else if let Some(text) = said.get("copied").and_then(Value::as_str) {
            cx.write_to_clipboard(ClipboardItem::new_string(text.to_string()));
        } else {
            self.moves = (said["back"].as_bool().unwrap_or(false), said["forward"].as_bool().unwrap_or(false));
        }
    }

    fn say(&self, said: Value) {
        if let Some(out) = &self.out { let _ = out.try_send(Out::Said(said)); }
    }

    // The box's size, and the screen's scale: the tab takes it, a moment after the last change while you drag.
    fn fit(&mut self, bounds: Bounds<Pixels>, scale: f32, cx: &mut Context<Self>) {
        let size = (bounds.size.width.as_f32().round().max(64.) as u32, bounds.size.height.as_f32().round().max(64.) as u32, scale);
        if self.size == Some(size) { return }
        let first = self.size.is_none();
        self.size = Some(size);
        if first { return self.connect(cx) }
        self._resize = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(300)).await;
            let _ = this.update(cx, |page, _| page.say(json!({"w": size.0, "h": size.1, "scale": size.2})));
        }));
    }

    // Where the picture is drawn: fit into the box at its top, at its own size in the box's pixels.
    fn drawn(&self) -> Option<Bounds<Pixels>> {
        let b = self.bounds.get()?;
        let p = self.picture.as_ref()?;
        let scale = self.size.map(|s| s.2).unwrap_or(1.);
        let px_size = p.size(0);
        let (w, h) = (px_size.width.0 as f32 / scale, px_size.height.0 as f32 / scale);
        if w <= 0. || h <= 0. { return None }
        let k = (b.size.width.as_f32() / w).min(b.size.height.as_f32() / h);
        let (w, h) = (w * k, h * k);
        Some(Bounds::new(point(b.left() + px((b.size.width.as_f32() - w) / 2.), b.top()), size(px(w), px(h))))
    }

    // A place on the picture as a fraction of it, and whether it is on it.
    fn spot(&self, at: Point<Pixels>) -> Option<(f32, f32, bool)> {
        let d = self.drawn()?;
        let (x, y) = ((at.x - d.left()).as_f32() / d.size.width.as_f32(), (at.y - d.top()).as_f32() / d.size.height.as_f32());
        Some((x, y, (0. ..=1.).contains(&x) && (0. ..=1.).contains(&y)))
    }

    fn mouse_down(&mut self, button: &'static str, e: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some((x, y, true)) = self.spot(e.position) else { return };
        window.focus(&self.focus, cx);
        self.address = None;
        self.caret = e.position;
        self.button = Some(button);
        self.say(json!({"mouse": "down", "button": button, "x": x, "y": y, "n": e.click_count, "mods": mods(&e.modifiers)}));
        cx.stop_propagation();
    }

    fn mouse_up(&mut self, e: &MouseUpEvent) {
        let Some(button) = self.button.take() else { return };
        let Some((x, y, _)) = self.spot(e.position) else { return };
        self.say(json!({"mouse": "up", "button": button, "x": x.clamp(0., 1.), "y": y.clamp(0., 1.), "n": e.click_count, "mods": mods(&e.modifiers)}));
    }

    fn mouse_move(&mut self, at: Point<Pixels>, modifiers: &Modifiers, hovering: bool) {
        let Some((x, y, on)) = self.spot(at) else { return };
        match self.button {
            Some(button) => self.say(json!({"mouse": "move", "held": true, "button": button, "x": x.clamp(0., 1.), "y": y.clamp(0., 1.), "mods": mods(modifiers)})),
            None if hovering && on => self.say(json!({"mouse": "move", "x": x, "y": y, "mods": mods(modifiers)})),
            None => {}
        }
    }

    fn wheel(&mut self, e: &ScrollEvent, cx: &mut Context<Self>) {
        let (Some((x, y, true)), Some(d)) = (self.spot(e.position), self.drawn()) else { return };
        if e.modifiers.control { return } // Ctrl and the wheel is the window's, as elsewhere
        // GPUI's wheel counts up as more; the page's counts down
        let (dx, dy) = match e.delta {
            ScrollDelta::Pixels(p) => (-p.x.as_f32(), -p.y.as_f32()),
            ScrollDelta::Lines(l) => (-l.x * 40., -l.y * 40.),
        };
        self.say(json!({"wheel": [dx / d.size.width.as_f32(), dy / d.size.height.as_f32()], "x": x, "y": y, "mods": mods(&e.modifiers)}));
        cx.stop_propagation();
    }

    // Your keys to the tab: each but desk's own (Ctrl `, Ctrl Shift with S, B or G, Ctrl ,), the toolbar's as Chrome's
    // (Alt ← and Alt → back and forward, Ctrl R and F5 reload, Ctrl L the address), and the clipboard's through yours.
    // Letters typed with no Ctrl or Alt go as the page's keys, and what the input method writes as text (below).
    fn key(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let k = &e.keystroke;
        let m = &k.modifiers;
        let key = k.key.to_lowercase();
        let ctrl = m.control && !m.alt && !m.platform;
        if ctrl && (key == "`" || key == "," || (m.shift && ["s", "b", "g"].contains(&key.as_str()))) { return }
        let alone = !m.control && !m.alt && !m.platform && !m.shift;
        if m.alt && !m.control && !m.shift && (key == "left" || key == "right") {
            if !e.is_held { self.say(json!({"nav": if key == "left" { "back" } else { "forward" }})) }
            return cx.stop_propagation();
        }
        if (ctrl && !m.shift && key == "r") || (alone && key == "f5") {
            if !e.is_held { self.say(json!({"nav": "reload"})) }
            return cx.stop_propagation();
        }
        if ctrl && !m.shift && key == "l" {
            self.edit_address(window, cx);
            return cx.stop_propagation();
        }
        if ctrl && key == "v" {
            if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) { self.say(json!({"insert": text})) }
            return cx.stop_propagation();
        }
        if ctrl && !m.shift && (key == "c" || key == "x") { self.say(json!({"copy": true})) }
        let Some((dom, code, kc)) = dom_key(k) else { return };
        let plain = !m.control && !m.alt && !m.platform;
        let text = if !plain { String::new() } else if key == "enter" { "\r".into() } else if dom.chars().count() == 1 { dom.clone() } else { String::new() };
        self.say(json!({"key": "down", "k": dom, "code": code, "kc": kc, "text": text, "mods": mods(m)}));
        cx.stop_propagation();
    }

    fn key_up(&mut self, e: &KeyUpEvent, cx: &mut Context<Self>) {
        let k = &e.keystroke;
        let Some((dom, code, kc)) = dom_key(k) else { return };
        self.say(json!({"key": "up", "k": dom, "code": code, "kc": kc, "text": "", "mods": mods(&k.modifiers)}));
        cx.stop_propagation();
    }

    // Ctrl L or a click on the address edits it, all of it selected; Enter takes the tab there, Esc or leaving it puts it back.
    fn edit_address(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let input = cx.new(|cx| InputState::new(window, cx).default_value(self.tab.url.clone()));
        input.update(cx, |i, cx| { i.focus(window, cx); i.select_all(window, cx) });
        let typed = cx.subscribe_in(&input, window, |page, input, event: &InputEvent, window, cx| match event {
            InputEvent::PressEnter { .. } => {
                let typed = input.read(cx).value().to_string();
                if !typed.trim().is_empty() { page.say(json!({"open": address(&typed)})) }
                page.address = None;
                window.focus(&page.focus, cx);
                cx.notify();
            }
            InputEvent::Blur => { page.address = None; cx.notify() }
            _ => {}
        });
        self._subscriptions = vec![typed];
        self.address = Some(input);
        cx.notify();
    }

    // A page's file chooser your click opened opens yours at once; what you pick goes to the page, a file at a time.
    fn choose(&mut self, cx: &mut Context<Self>) {
        let Some(multiple) = self.chooser else { return };
        let paths = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple, prompt: None });
        cx.spawn(async move |this, cx| {
            let picked = paths.await.ok().and_then(Result::ok).flatten().unwrap_or_default();
            let _ = this.update(cx, |page, cx| page.give(picked, cx));
        })
        .detach();
    }

    fn give(&mut self, paths: Vec<std::path::PathBuf>, cx: &mut Context<Self>) {
        if paths.is_empty() {
            self.say(json!({"files": []}));
            self.chooser = None;
            return cx.notify();
        }
        if let Some(big) = paths.iter().find(|p| std::fs::metadata(p).is_ok_and(|m| m.len() > BIGGEST)) {
            self.giving = format!("{} is over 100 MB, more than desk gives a page.", big.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
            return cx.notify();
        }
        let names: Vec<String> = paths.iter().map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into())).collect();
        self.giving = if names.len() == 1 { format!("Giving the page {}…", names[0]) } else { format!("Giving the page {} files…", names.len()) };
        let Some(out) = self.out.clone() else { return };
        let _ = out.try_send(Out::Said(json!({"files": names})));
        cx.background_spawn(async move {
            for path in paths { let _ = out.send(Out::File(std::fs::read(path).unwrap_or_default())).await; }
        })
        .detach();
        cx.notify();
    }

    fn answer(&mut self, yes: bool, cx: &mut Context<Self>) {
        let text = self.prompt.as_ref().map(|p| p.read(cx).value().to_string());
        let mut said = json!({"answer": yes});
        if let (Some(text), true) = (text, yes) { said["text"] = json!(text) }
        self.say(said);
        self.dialog = None;
        self.prompt = None;
        cx.notify();
    }

    // A circle of the toolbar, with its glyph, which leaves your keys where they were.
    fn tool(&self, id: &'static str, glyph: &'static str, can: bool, cx: &mut Context<Self>) -> Stateful<Div> {
        let can = can && self.stand == Stand::On;
        let (hover, muted, dim) = (theme::text(cx).hover, cx.theme().muted_foreground, theme::text(cx).dim);
        div()
            .id(id)
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(28.))
            .rounded_full()
            .when(can, |b| b.hover(|s| s.bg(hover)))
            .child(theme::glyph(glyph, if can { muted } else { dim }))
    }

    // A card over the page, as the chat's question card: what waits on you, which takes your keys while it waits.
    fn card(&self, header: String, what: String, cx: &mut Context<Self>) -> Div {
        let theme = cx.theme();
        let text = theme::text(cx);
        div()
            .v_flex()
            .w(px(440.))
            .max_w(relative(0.92))
            .gap_2()
            .p_4()
            .rounded(px(12.))
            .border_1()
            .border_color(theme.border)
            .bg(text.raised)
            .shadow_lg()
            .child(div().text_size(px(12.)).font_medium().text_color(theme.muted_foreground).child(header))
            .child(div().text_size(px(13.)).line_height(relative(1.45)).text_color(text.strong).child(what))
    }

    fn cards(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let host = split(&self.tab.url).map(|(h, _)| h).filter(|h| !h.is_empty()).unwrap_or_else(|| "This page".into());
        let card = if let Some(d) = self.dialog.clone() {
            let leave = d.kind == "beforeunload";
            if d.kind == "prompt" && self.prompt.is_none() {
                let start = self.prompt_text.take().unwrap_or_default();
                let input = cx.new(|cx| InputState::new(window, cx).default_value(start));
                let sub = cx.subscribe(&input, |page, _, event: &InputEvent, cx| if let InputEvent::PressEnter { .. } = event { page.answer(true, cx) });
                self._subscriptions.push(sub);
                self.prompt = Some(input);
            }
            let alert = d.kind == "alert";
            let mut card = self.card(if leave { "Leave site?".into() } else { format!("{host} says") }, if leave { "Changes you made may not be saved.".into() } else { d.message.clone() }, cx);
            if let Some(input) = &self.prompt { card = card.child(Input::new(input).text_size(px(13.))) }
            card.child(
                div().h_flex().justify_end().gap_2().mt_1()
                    .when(!alert, |b| b.child(Button::new("cancel").ghost().label("Cancel").on_click(cx.listener(|page, _, _, cx| page.answer(false, cx)))))
                    .child(Button::new("ok").primary().label(if leave { "Leave" } else { "OK" }).on_click(cx.listener(|page, _, _, cx| page.answer(true, cx)))),
            )
        } else if self.held {
            self.card(host, "The page waits on a box that opened before desk looked at it, which desk cannot read. Claude may answer it; a reload closes it.".into(), cx)
                .child(div().h_flex().justify_end().mt_1().child(Button::new("reload").primary().label("Reload page").on_click(cx.listener(|page, _, _, cx| {
                    page.held = false;
                    page.say(json!({"nav": "reload"}));
                    cx.notify();
                }))))
        } else if let Some(multiple) = self.chooser {
            let what = if !self.giving.is_empty() { self.giving.clone() } else if multiple { "The page asks for files.".into() } else { "The page asks for a file.".into() };
            let giving = self.giving.starts_with("Giving");
            self.card(host, what, cx).child(
                div().h_flex().justify_end().gap_2().mt_1()
                    .child(Button::new("cancel").ghost().label("Cancel").on_click(cx.listener(|page, _, _, cx| page.give(Vec::new(), cx))))
                    .when(!giving, |b| b.child(Button::new("choose").primary().label(if multiple { "Choose files…" } else { "Choose file…" }).on_click(cx.listener(|page, _, _, cx| page.choose(cx))))),
            )
        } else {
            return None;
        };
        let overlay = if cx.theme().mode.is_dark() { hsla(0., 0., 0., 0.4) } else { hsla(0., 0., 0., 0.25) }; // desk.css's --overlay
        Some(
            div()
                .id("browser-card")
                .absolute()
                .inset_0()
                .flex()
                .justify_center()
                .items_start()
                .pt_4()
                .bg(overlay)
                .occlude()
                .track_focus(&self.card)
                // the card's keys are its own: Enter is OK, Esc Cancel
                .on_key_down(cx.listener(|page, e: &KeyDownEvent, _, cx| {
                    let key = e.keystroke.key.as_str();
                    if page.dialog.is_some() && (key == "enter" || key == "escape") {
                        let alert = page.dialog.as_ref().is_some_and(|d| d.kind == "alert");
                        page.answer(key == "enter" || alert, cx);
                    } else if page.chooser.is_some() && key == "escape" {
                        page.give(Vec::new(), cx);
                    }
                    cx.stop_propagation();
                }))
                .child(card)
                .into_any_element(),
        )
    }
}

impl Render for TabPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        for old in self.stale.drain(..) { let _ = window.drop_image(old); }
        // a card that waits on you takes your keys, when they were in the Browser
        if (self.dialog.is_some() || self.held || self.chooser.is_some()) && self.focus.is_focused(window) {
            if let Some(prompt) = &self.prompt { prompt.update(cx, |p, cx| p.focus(window, cx)) } else { window.focus(&self.card, cx) }
        }
        let theme = cx.theme();
        let text = theme::text(cx);
        let (muted, border, ground) = (theme.muted_foreground, theme.border, theme.background);
        let accent = text.accent;
        let address = match &self.address {
            Some(input) => div().flex_1().min_w_0().h(px(28.)).ml_1().rounded_full().border_1().border_color(accent).px_2()
                .child(Input::new(input).appearance(false).text_size(px(13.))).into_any_element(),
            None => {
                let (host, rest) = split(&self.tab.url).unwrap_or_default();
                div()
                    .id("address")
                    .flex_1()
                    .min_w_0()
                    .h(px(28.))
                    .ml_1()
                    .px_3()
                    .h_flex()
                    .rounded_full()
                    .bg(text.raised)
                    .border_1()
                    .border_color(border)
                    .cursor_text()
                    .text_size(px(13.))
                    .text_color(muted)
                    .on_click(cx.listener(|page, _, window, cx| page.edit_address(window, cx)))
                    .child(div().min_w_0().truncate().when(host.is_empty(), |d| d.child(self.tab.url.chars().take(300).collect::<String>()))
                        .when(!host.is_empty(), |d| d.child(div().h_flex().child(div().flex_none().text_color(theme.foreground).child(host)).child(div().min_w_0().truncate().child(rest)))))
                    .into_any_element()
            }
        };
        let nav = div()
            .h_flex()
            .flex_none()
            .h(px(40.))
            .px_2()
            .gap_1()
            .border_b_1()
            .border_color(text.divider)
            .child(self.tool("back", "back", self.moves.0, cx).on_click(cx.listener(|page, _, _, _| page.say(json!({"nav": "back"})))))
            .child(self.tool("forward", "forward", self.moves.1, cx).on_click(cx.listener(|page, _, _, _| page.say(json!({"nav": "forward"})))))
            .child(self.tool("reload", "reload", true, cx).on_click(cx.listener(|page, _, _, _| page.say(json!({"nav": "reload"})))))
            .child(address);
        let note = match &self.stand {
            Stand::Away => Some("Reconnecting…".to_string()),
            Stand::Failed(why) => Some(why.clone()),
            _ => None,
        };
        let drawn = self.drawn();
        let picture = self.picture.clone().zip(drawn.zip(self.bounds.get())).map(|(p, (d, b))| {
            img(ImageSource::Render(p)).absolute().left(d.left() - b.left()).top(d.top() - b.top()).w(d.size.width).h(d.size.height)
        });
        let cards = self.cards(window, cx);
        let (weak, slot, focus, entity) = (cx.entity().downgrade(), self.bounds.clone(), self.focus.clone(), cx.entity());
        let drag = cx.entity().downgrade();
        let page = div()
            .id("browser-page")
            .relative()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .bg(ground)
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|page, e: &KeyDownEvent, window, cx| page.key(e, window, cx)))
            .on_key_up(cx.listener(|page, e: &KeyUpEvent, _, cx| page.key_up(e, cx)))
            .on_mouse_down(MouseButton::Left, cx.listener(|page, e: &MouseDownEvent, window, cx| page.mouse_down("left", e, window, cx)))
            .on_mouse_down(MouseButton::Right, cx.listener(|page, e: &MouseDownEvent, window, cx| page.mouse_down("right", e, window, cx)))
            .on_mouse_down(MouseButton::Middle, cx.listener(|page, e: &MouseDownEvent, window, cx| page.mouse_down("middle", e, window, cx)))
            .on_mouse_move(cx.listener(|page, e: &MouseMoveEvent, _, _| if page.button.is_none() { page.mouse_move(e.position, &e.modifiers, true) }))
            .on_scroll(cx.listener(|page, e: &ScrollEvent, _, cx| page.wheel(e, cx)))
            // where it is laid out: the tab takes the box's size, the input method types into it, and a drag goes on
            // past its edge until the button is let go
            .child(
                canvas(
                    move |bounds, window, cx| {
                        let scale = window.scale_factor();
                        if slot.get() != Some(bounds) {
                            slot.set(Some(bounds));
                        }
                        let weak = weak.clone();
                        cx.defer(move |cx| { let _ = weak.update(cx, |page, cx| page.fit(bounds, scale, cx)); });
                    },
                    move |bounds, _, window, cx| {
                        window.handle_input(&focus, ElementInputHandler::new(bounds, entity.clone()), cx);
                        let (moving, up) = (drag.clone(), drag.clone());
                        window.on_mouse_event(move |e: &MouseMoveEvent, phase, _, cx| {
                            if phase != DispatchPhase::Bubble { return }
                            let _ = moving.update(cx, |page, _| if page.button.is_some() { page.mouse_move(e.position, &e.modifiers, false) });
                        });
                        window.on_mouse_event(move |e: &MouseUpEvent, phase, _, cx| {
                            if phase != DispatchPhase::Bubble { return }
                            let _ = up.update(cx, |page, _| page.mouse_up(e));
                        });
                    },
                )
                .absolute()
                .size_full(),
            )
            .children(picture)
            .children(note.map(|n| div().absolute().left(px(16.)).bottom(px(12.)).text_size(px(12.)).text_color(muted).child(n)))
            .children(cards);
        div().v_flex().size_full().child(nav).child(page)
    }
}

// The input method's end: what it writes goes to the page as text, and what it composes shows in the page, underlined
// where you type, until then.
impl EntityInputHandler for TabPage {
    fn text_for_range(&mut self, _: Range<usize>, _: &mut Option<Range<usize>>, _: &mut Window, _: &mut Context<Self>) -> Option<String> {
        None
    }

    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        Some(UTF16Selection { range: 0..0, reversed: false })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.as_ref().map(|m| 0..m.encode_utf16().count())
    }

    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        if self.marked.take().is_some() { self.say(json!({"compose": ""})) }
    }

    fn replace_text_in_range(&mut self, _: Option<Range<usize>>, text: &str, _: &mut Window, _: &mut Context<Self>) {
        self.marked = None;
        self.say(json!({"insert": text}));
    }

    fn replace_and_mark_text_in_range(&mut self, _: Option<Range<usize>>, text: &str, _: Option<Range<usize>>, _: &mut Window, _: &mut Context<Self>) {
        self.marked = (!text.is_empty()).then(|| text.to_string());
        self.say(json!({"compose": text}));
    }

    fn bounds_for_range(&mut self, _: Range<usize>, _: Bounds<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<Bounds<Pixels>> {
        Some(Bounds::new(self.caret, size(px(1.), px(18.))))
    }

    fn character_index_for_point(&mut self, _: Point<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        None
    }
}

pub enum BrowserEvent {
    // the tab shown, picked in the strip, which the window remembers for the chat
    Picked(String),
}

impl EventEmitter<BrowserEvent> for Browser {}

// The chat's Browser: its tabs' strip, and the tab shown, the one you picked while it is open, else the one opened last,
// where Claude most likely works.
pub struct Browser {
    tabs: Vec<Tab>,
    picked: Option<String>,
    page: Option<Entity<TabPage>>,
    icons: HashMap<String, Option<Arc<Image>>>, // each site's icon, once desk gave it or said it has none
}

impl Browser {
    pub fn new(tabs: Vec<Tab>, picked: Option<String>, cx: &mut Context<Self>) -> Self {
        let mut browser = Self { tabs: Vec::new(), picked, page: None, icons: HashMap::new() };
        browser.set_tabs(tabs, cx);
        browser
    }

    fn shown(&self) -> Option<&Tab> {
        self.tabs.iter().find(|t| Some(&t.target) == self.picked.as_ref()).or_else(|| self.tabs.last())
    }

    // The session's tabs as desk now has them, the first opened first.
    pub fn set_tabs(&mut self, mut tabs: Vec<Tab>, cx: &mut Context<Self>) {
        tabs.sort_by(|a, b| a.opened.cmp(&b.opened));
        self.tabs = tabs;
        for tab in self.tabs.clone() { self.icon(&tab, cx) }
        match self.shown().cloned() {
            Some(tab) if self.page.as_ref().is_some_and(|p| p.read(cx).tab.target == tab.target) => {
                if let Some(page) = &self.page { page.update(cx, |p, cx| if p.tab != tab { p.tab = tab; cx.notify() }) }
            }
            Some(tab) => self.page = Some(cx.new(|cx| TabPage::new(tab, cx))),
            None => self.page = None,
        }
        cx.notify();
    }

    pub fn show(&mut self, target: &str, cx: &mut Context<Self>) {
        self.picked = Some(target.to_string());
        cx.emit(BrowserEvent::Picked(target.to_string()));
        let tabs = self.tabs.clone();
        self.set_tabs(tabs, cx);
    }

    // The site's own icon, which desk fetches (the server's tabs.ts), or a globe where it has none.
    fn icon(&mut self, tab: &Tab, cx: &mut Context<Self>) {
        let Some(site) = site(&tab.url) else { return };
        if self.icons.contains_key(&site) { return }
        self.icons.insert(site.clone(), None);
        let path = format!("/api/tabs/{}/icon?site={}", tab.target, site.bytes().map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>());
        cx.spawn(async move |this, cx| {
            let got = cx.background_spawn(async move { net::bytes(&path) }).await;
            let image = got.ok().and_then(|(kind, bytes)| {
                let format = if kind.contains("icon") { Some(ImageFormat::Ico) } else if kind.contains("svg") { Some(ImageFormat::Svg) } else { ImageFormat::from_mime_type(kind.split(';').next().unwrap_or("").trim()) };
                format.map(|f| Arc::new(Image::from_bytes(f, bytes)))
            });
            let _ = this.update(cx, |b, cx| { b.icons.insert(site, image); cx.notify() });
        })
        .detach();
    }
}

impl Render for Browser {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let text = theme::text(cx);
        let (muted, strong, hover, border) = (theme.muted_foreground, text.strong, text.hover, theme.border);
        let active = theme.list_active;
        let Some(shown) = self.shown().map(|t| t.target.clone()) else {
            return div().size_full().flex().justify_center().pt(px(48.)).text_size(px(13.)).text_color(text.dim).child("No tabs yet").into_any_element();
        };
        let mut strip = div().id("browser-tabs").h_flex().flex_none().h(px(44.)).px_2().gap_1().border_b_1().border_color(text.divider).overflow_x_scroll();
        for tab in &self.tabs {
            let here = tab.target == shown;
            let name = if !tab.title.is_empty() { tab.title.clone() } else { split(&tab.url).map(|(h, _)| h).filter(|h| !h.is_empty()).unwrap_or_else(|| tab.url.clone()) };
            let icon = site(&tab.url).and_then(|s| self.icons.get(&s).cloned().flatten());
            let (pick, close) = (tab.target.clone(), tab.target.clone());
            let group = SharedString::from(format!("tab-{}", tab.target));
            strip = strip.child(
                div()
                    .id(SharedString::from(format!("tab-{}", tab.target)))
                    .group(group.clone())
                    .h_flex()
                    .flex_shrink(1.)
                    .min_w(px(88.))
                    .max_w(px(190.))
                    .h(px(28.))
                    .rounded_full()
                    .text_color(if here { strong } else { muted })
                    .when(here, |t| t.bg(active).border_1().border_color(border))
                    .when(!here, |t| t.hover(|s| s.bg(hover)))
                    .on_click(cx.listener(move |b, _, _, cx| b.show(&pick, cx)))
                    .child(
                        div().h_flex().flex_1().min_w_0().gap(px(6.)).pl_2().pr(px(2.))
                            .child(match icon {
                                Some(image) => img(image).flex_none().size(px(14.)).rounded(px(3.)).into_any_element(),
                                None => theme::glyph("globe", muted).size(px(14.)).into_any_element(),
                            })
                            .child(div().min_w_0().truncate().text_size(px(13.)).child(name)),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!("close-{}", tab.target)))
                            .flex()
                            .flex_none()
                            .items_center()
                            .justify_center()
                            .size(px(20.))
                            .mr_1()
                            .rounded_full()
                            .when(!here, |c| c.opacity(0.).group_hover(group, |s| s.opacity(1.)))
                            .hover(|s| s.bg(hover))
                            .on_click(cx.listener(move |_, _, _, cx| {
                                let target = close.clone();
                                cx.background_spawn(async move { let _ = net::post(&format!("/api/tabs/{target}/close"), json!({})); }).detach();
                                cx.stop_propagation();
                            }))
                            .child(theme::glyph("close", muted).size(px(14.))),
                    ),
            );
        }
        div().v_flex().size_full().child(strip).children(self.page.clone()).into_any_element()
    }
}
