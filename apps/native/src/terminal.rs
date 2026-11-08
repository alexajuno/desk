// A chat's terminal, the right half's Terminal, as the web app's (sessions/Terminal.tsx): the chat's tmux session,
// which desk's server starts when you open it, or Claude does, and attaches to through a PTY (the server's
// terminal.ts), its output coming over a socket as text. vt100 reads that into a screen of cells, drawn here a row at a
// time in JetBrains Mono with desk's sixteen colours (dock.css's --term-0 to --term-15). What you type goes to the
// shell: keys as a terminal sends them, and letters through the input method, so fcitx5 types here as anywhere. tmux
// keeps the history: the wheel and a drag go to tmux once it asks for the mouse, which scrolls, and copies to the
// clipboard (OSC 52). Ctrl ` and Ctrl Shift with S, B or G stay desk's.
use std::cell::Cell;
use std::ops::Range;
use std::rc::Rc;
use std::{thread, time::Duration};

use base64::Engine;
use gpui_kit::component::ActiveTheme;
use gpui_kit::base::StyledExt;
use gpui_kit::*;
use serde_json::json;
use smol::channel::{Receiver, Sender};
use tungstenite::Message;

use crate::{net, theme};

const FONT: &str = "JetBrains Mono";
const SIZE: f32 = 13.;
const LINE: f32 = 16.; // xterm.js's line height of 1.2, whole
const PAD: (f32, f32, f32, f32) = (14., 8., 8., 16.); // dock.css's .term: top, right, bottom, left

enum Out {
    Keys(String),
    Size(u16, u16),
}

enum In {
    On,
    Bytes(Vec<u8>),
    Closed { code: u16, reason: String },
}

// The socket, on a thread of its own: what you type and the size go out, tmux's output comes in. It ends with the
// socket, or once the terminal is gone.
fn attach(session: String, rows: u16, cols: u16, out: Receiver<Out>, came: Sender<In>) {
    thread::spawn(move || {
        let run = || -> Result<(), Box<dyn std::error::Error>> {
            let mut socket = net::socket(&format!("/api/live/{session}/terminal/screen?cols={cols}&rows={rows}"), Duration::from_millis(15))?;
            came.send_blocking(In::On)?;
            loop {
                while let Ok(said) = out.try_recv() {
                    let said = match said { Out::Keys(keys) => json!({"in": keys}), Out::Size(rows, cols) => json!({"cols": cols, "rows": rows}) };
                    socket.send(Message::text(said.to_string()))?;
                }
                match socket.read() {
                    Ok(Message::Text(text)) => came.send_blocking(In::Bytes(text.as_bytes().to_vec()))?,
                    Ok(Message::Binary(bytes)) => came.send_blocking(In::Bytes(bytes.to_vec()))?,
                    Ok(Message::Close(frame)) => {
                        let (code, reason) = frame.map(|f| (u16::from(f.code), f.reason.to_string())).unwrap_or((1005, String::new()));
                        came.send_blocking(In::Closed { code, reason })?;
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
            let _ = came.send_blocking(In::Closed { code: 1006, reason: error.to_string() });
        }
    });
}

// A key as a terminal sends it (xterm's), or None for one left to desk or to the input method.
fn keys_for(k: &Keystroke, app: bool) -> Option<String> {
    let m = &k.modifiers;
    let key = k.key.as_str();
    let n = 1 + m.shift as u8 + 2 * m.alt as u8 + 4 * m.control as u8; // xterm's modifier number
    let esc = if m.alt { "\x1b" } else { "" };
    let letter = |l: char| Some(if n > 1 { format!("\x1b[1;{n}{l}") } else if app { format!("\x1bO{l}") } else { format!("\x1b[{l}") });
    let tilde = |code: u8| Some(if n > 1 { format!("\x1b[{code};{n}~") } else { format!("\x1b[{code}~") });
    match key {
        "enter" => Some(format!("{esc}\r")),
        "backspace" => Some(format!("{esc}{}", if m.control { "\x08" } else { "\x7f" })),
        "tab" => Some(if m.shift { "\x1b[Z".into() } else { "\t".into() }),
        "escape" => Some("\x1b".into()),
        "up" => letter('A'),
        "down" => letter('B'),
        "right" => letter('C'),
        "left" => letter('D'),
        "home" => letter('H'),
        "end" => letter('F'),
        "insert" => tilde(2),
        "delete" => tilde(3),
        "pageup" => tilde(5),
        "pagedown" => tilde(6),
        "f1" | "f2" | "f3" | "f4" => {
            let l = ['P', 'Q', 'R', 'S'][key[1..].parse::<usize>().unwrap_or(1) - 1];
            Some(if n > 1 { format!("\x1b[1;{n}{l}") } else { format!("\x1bO{l}") })
        }
        "f5" | "f6" | "f7" | "f8" | "f9" | "f10" | "f11" | "f12" => tilde([15, 17, 18, 19, 20, 21, 23, 24][key[1..].parse::<usize>().unwrap_or(5) - 5]),
        "space" if m.control => Some(format!("{esc}\0")),
        "space" if m.alt => Some("\x1b ".into()),
        _ if m.control && key.chars().count() == 1 => {
            let c = key.chars().next()?.to_ascii_lowercase();
            let byte = match c {
                'a'..='z' => c as u8 - b'a' + 1,
                '@' | '2' => 0,
                '[' | '3' => 0x1b,
                '\\' | '4' => 0x1c,
                ']' | '5' => 0x1d,
                '^' | '6' => 0x1e,
                '_' | '-' | '7' | '/' => 0x1f,
                '8' | '?' => 0x7f,
                _ => return None,
            };
            Some(format!("{esc}{}", byte as char))
        }
        _ if m.alt && !m.control => k.key_char.clone().or_else(|| (key.chars().count() == 1).then(|| key.to_string())).map(|c| format!("\x1b{c}")),
        _ => None,
    }
}

// What tmux copies, for the clipboard: tmux names no clipboard in what it sends (OSC 52 ";;"), so any is taken.
#[derive(Default)]
struct Copied(Vec<String>);

impl vt100::Callbacks for Copied {
    fn copy_to_clipboard(&mut self, _: &mut vt100::Screen, _ty: &[u8], data: &[u8]) {
        if let Some(text) = base64::engine::general_purpose::STANDARD.decode(data).ok().and_then(|b| String::from_utf8(b).ok()) {
            self.0.push(text);
        }
    }
}

#[derive(PartialEq)]
enum Stand {
    Starting,
    On,
    Away,
    Failed(String),
}

pub enum TerminalEvent {
    // its shell exited, or its issue closed: the half hides
    Ended,
}

pub struct Terminal {
    session: String,
    parser: vt100::Parser<Copied>,
    out: Option<Sender<Out>>,
    stand: Stand,
    pub focus: FocusHandle,
    grid: (u16, u16), // rows, cols
    sized: bool,      // the grid is the half's, as laid out
    ready: bool,      // the session runs: attach
    cell: f32,        // a cell's width
    marked: Option<String>, // what the input method holds before it commits it
    tries: u32,
    held: Option<u8>,       // the mouse button held, for a drag
    at: (u16, u16),         // the cell the mouse was last reported at
    wheel: f32,             // pixels scrolled short of a line
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    _read: Option<Task<()>>,
    _retry: Option<Task<()>>,
}

impl EventEmitter<TerminalEvent> for Terminal {}

impl Terminal {
    // You opening it starts the session; Claude started it before opening it, so the page only attaches.
    pub fn new(session: String, yours: bool, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        if yours { window.focus(&focus, cx) }
        let size = |n: u16| core::num::NonZeroU16::new(n).unwrap_or(core::num::NonZeroU16::MIN);
        let mut terminal = Self {
            session: session.clone(),
            parser: vt100::Parser::new_with_callbacks(size(40), size(120), 0, Copied::default()),
            out: None,
            stand: Stand::Starting,
            focus,
            grid: (40, 120),
            sized: false,
            ready: !yours,
            cell: 7.8,
            marked: None,
            tries: 0,
            held: None,
            at: (0, 0),
            wheel: 0.,
            bounds: Rc::new(Cell::new(None)),
            _read: None,
            _retry: None,
        };
        if yours {
            terminal._retry = Some(cx.spawn(async move |this, cx| {
                let started = cx.background_spawn(async move { net::post(&format!("/api/live/{session}/terminal"), json!({})) }).await;
                let _ = this.update(cx, |t, cx| match started {
                    Ok(_) => { t.ready = true; t.connect(cx) }
                    Err(error) => { t.stand = Stand::Failed(error); cx.notify() }
                });
            }));
        }
        terminal
    }

    // Attach once the session runs and the grid has the half's size.
    fn connect(&mut self, cx: &mut Context<Self>) {
        if !self.ready || !self.sized || self.out.is_some() { return }
        let (out, out_rx) = smol::channel::unbounded();
        let (came_tx, came) = smol::channel::unbounded();
        attach(self.session.clone(), self.grid.0, self.grid.1, out_rx, came_tx);
        self.out = Some(out);
        self._read = Some(cx.spawn(async move |this, cx| {
            while let Ok(first) = came.recv().await {
                let mut batch = vec![first];
                while let Ok(more) = came.try_recv() { batch.push(more) }
                if this.update(cx, |t, cx| { for event in batch { t.took(event, cx) } cx.notify() }).is_err() { return }
            }
        }));
    }

    fn took(&mut self, event: In, cx: &mut Context<Self>) {
        match event {
            In::On => { self.tries = 0; self.stand = Stand::On }
            In::Bytes(bytes) => {
                self.parser.process(&bytes);
                for text in self.parser.callbacks_mut().0.drain(..) { cx.write_to_clipboard(ClipboardItem::new_string(text)) }
            }
            // desk restarting drops the socket while tmux keeps the session: attach again, once a second for a minute
            In::Closed { code, reason } => {
                self.out = None;
                if reason == "ended" { return cx.emit(TerminalEvent::Ended) }
                if code == 4404 { self.stand = Stand::Failed(reason); return }
                self.tries += 1;
                if self.tries > 60 { self.stand = Stand::Failed("desk does not answer.".into()); return }
                self.stand = Stand::Away;
                self._retry = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_secs(1)).await;
                    let _ = this.update(cx, |t, cx| t.connect(cx));
                }));
            }
        }
    }

    fn send(&mut self, keys: impl Into<String>) {
        if let Some(out) = &self.out { let _ = out.try_send(Out::Keys(keys.into())); }
    }

    // The half's size, in whole cells.
    fn fit(&mut self, bounds: Bounds<Pixels>, cx: &mut Context<Self>) {
        let width = bounds.size.width.as_f32() - PAD.1 - PAD.3;
        let height = bounds.size.height.as_f32() - PAD.0 - PAD.2;
        let grid = ((height / LINE).floor().max(2.) as u16, (width / self.cell).floor().max(2.) as u16);
        if self.sized && grid == self.grid { return }
        self.grid = grid;
        self.sized = true;
        let size = |n: u16| core::num::NonZeroU16::new(n).unwrap_or(core::num::NonZeroU16::MIN);
        self.parser.set_size(size(grid.0), size(grid.1));
        if let Some(out) = &self.out { let _ = out.try_send(Out::Size(grid.0, grid.1)); }
        self.connect(cx);
        cx.notify();
    }

    fn key_down(&mut self, e: &KeyDownEvent, cx: &mut Context<Self>) {
        let k = &e.keystroke;
        let m = &k.modifiers;
        let key = k.key.to_lowercase();
        // desk's own: Ctrl ` hides the half, and Ctrl Shift S, B and G show another
        if m.control && !m.alt && (key == "`" || (m.shift && ["s", "b", "g"].contains(&key.as_str()))) { return }
        if m.control && m.shift && (key == "v" || key == "c") {
            if key == "v" { if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) { self.paste(&text) } }
            return cx.stop_propagation();
        }
        if let Some(keys) = keys_for(k, self.parser.screen().application_cursor()) {
            self.send(keys);
            cx.stop_propagation();
        }
    }

    // A paste, bracketed when the program asked for it, so a shell takes it whole rather than running each line.
    fn paste(&mut self, text: &str) {
        let text = text.replace("\r\n", "\r").replace('\n', "\r");
        if self.parser.screen().bracketed_paste() { self.send(format!("\x1b[200~{text}\x1b[201~")) } else { self.send(text) }
    }

    // The cell under the mouse, 1-based, as the mouse protocols count.
    fn cell_at(&self, at: Point<Pixels>) -> (u16, u16) {
        let Some(b) = self.bounds.get() else { return (1, 1) };
        let col = ((at.x - b.left()).as_f32() - PAD.3) / self.cell;
        let row = ((at.y - b.top()).as_f32() - PAD.0) / LINE;
        ((row.max(0.) as u16).min(self.grid.0 - 1) + 1, (col.max(0.) as u16).min(self.grid.1 - 1) + 1)
    }

    // A mouse event for tmux, once it asked for the mouse: button, cell, and whether it is a press.
    fn mouse(&mut self, button: u8, (row, col): (u16, u16), press: bool) -> bool {
        let screen = self.parser.screen();
        if screen.mouse_protocol_mode() == vt100::MouseProtocolMode::None { return false }
        let keys = if screen.mouse_protocol_encoding() == vt100::MouseProtocolEncoding::Sgr {
            format!("\x1b[<{button};{col};{row}{}", if press { 'M' } else { 'm' })
        } else {
            let b = if press { button } else { 3 };
            let byte = |n: u16| char::from_u32(32 + n.min(223) as u32).unwrap_or(' ');
            format!("\x1b[M{}{}{}", byte(b as u16), byte(col), byte(row))
        };
        self.send(keys);
        true
    }

    // xterm's colours by number: desk's sixteen, then the 6×6×6 cube and the greys.
    fn colour(&self, c: vt100::Color, fg: bool, bold: bool, palette: &[u32; 16], cx: &App) -> Option<Hsla> {
        let rgb_of = |hex: u32| -> Hsla { rgb(hex).into() };
        match c {
            vt100::Color::Default => fg.then(|| cx.theme().foreground),
            vt100::Color::Idx(n) if n < 16 => Some(rgb_of(palette[if fg && bold && n < 8 { n as usize + 8 } else { n as usize }])),
            vt100::Color::Idx(n) if n < 232 => {
                let n = n - 16;
                let level = |v: u8| if v == 0 { 0 } else { 55 + 40 * v as u32 };
                Some(rgb_of(level(n / 36) << 16 | level(n / 6 % 6) << 8 | level(n % 6)))
            }
            vt100::Color::Idx(n) => { let g = 8 + 10 * (n as u32 - 232); Some(rgb_of(g << 16 | g << 8 | g)) }
            vt100::Color::Rgb(r, g, b) => Some(rgb_of((r as u32) << 16 | (g as u32) << 8 | b as u32)),
        }
    }

    // A row of the screen as one text, a run for each stretch of cells drawn alike.
    fn row(&self, r: u16, palette: &[u32; 16], cursor: Option<(u16, Hsla, Hsla)>, cx: &App) -> StyledText {
        let screen = self.parser.screen();
        let mut text = String::new();
        let mut runs: Vec<TextRun> = Vec::new();
        let mut last: Option<(Hsla, Option<Hsla>, bool, bool, bool)> = None;
        for c in 0..self.grid.1 {
            let Some(cell) = screen.cell(r, c) else { break };
            if cell.is_wide_continuation() { continue }
            let s = if cell.has_contents() { cell.contents() } else { " " };
            let mut fg = self.colour(cell.fgcolor(), true, cell.bold(), palette, cx).unwrap_or(cx.theme().foreground);
            let mut bg = self.colour(cell.bgcolor(), false, false, palette, cx);
            if cell.inverse() {
                let was = fg;
                fg = bg.unwrap_or(cx.theme().background);
                bg = Some(was);
            }
            if cell.dim() { fg.a *= 0.5 }
            if let Some((at, ink, ground)) = cursor { if at == c { fg = ink; bg = Some(ground) } }
            let look = (fg, bg, cell.bold(), cell.italic(), cell.underline());
            text.push_str(s);
            if last == Some(look) {
                if let Some(run) = runs.last_mut() { run.len += s.len() }
            } else {
                let mut f = font(FONT);
                if cell.bold() { f.weight = FontWeight::BOLD }
                if cell.italic() { f.style = FontStyle::Italic }
                runs.push(TextRun {
                    len: s.len(),
                    font: f,
                    color: fg,
                    background_color: bg,
                    underline: cell.underline().then(|| UnderlineStyle { thickness: px(1.), color: Some(fg), wavy: false }),
                    strikethrough: None,
                });
                last = Some(look);
            }
        }
        StyledText::new(text).with_runs(runs)
    }
}

// desk's --term-0 to --term-15, dark and light (dock.css).
const DARK: [u32; 16] = [0x000000, 0xcd3131, 0x0dbc79, 0xe5e510, 0x2472c8, 0xbc3fbc, 0x11a8cd, 0xe5e5e5, 0x666666, 0xf14c4c, 0x23d18b, 0xf5f543, 0x3b8eea, 0xd670d6, 0x29b8db, 0xe5e5e5];
const LIGHT: [u32; 16] = [0x000000, 0xcd3131, 0x107c10, 0x949800, 0x0451a5, 0xbc05bc, 0x0598bc, 0x555555, 0x666666, 0xf14c4c, 0x14ce14, 0xb5ba00, 0x3b8eea, 0xd670d6, 0x29b8db, 0xa5a5a5];

impl Render for Terminal {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let id = window.text_system().resolve_font(&font(FONT));
        if let Ok(advance) = window.text_system().advance(id, px(SIZE), 'M') { self.cell = advance.width.as_f32() }
        let palette = if cx.theme().mode.is_dark() { &DARK } else { &LIGHT };
        let (ground, strong, muted) = (cx.theme().background, theme::text(cx).strong, cx.theme().muted_foreground);
        let focused = self.focus.is_focused(window);
        let screen = self.parser.screen();
        let (cr, cc) = screen.cursor_position();
        let show_cursor = !screen.hide_cursor() && self.stand == Stand::On && self.marked.is_none();
        let mut rows = div().absolute().top(px(PAD.0)).left(px(PAD.3)).v_flex();
        for r in 0..self.grid.0 {
            let cursor = (show_cursor && focused && r == cr).then_some((cc, ground, strong));
            rows = rows.child(div().h(px(LINE)).whitespace_nowrap().child(self.row(r, palette, cursor, cx)));
        }
        let at = point(px(PAD.3 + cc as f32 * self.cell), px(PAD.0 + cr as f32 * LINE));
        // away from it, the cursor is an outline; the input method's text waits on it, underlined
        let hollow = (show_cursor && !focused).then(|| div().absolute().left(at.x).top(at.y).w(px(self.cell)).h(px(LINE)).border_1().border_color(strong));
        let marked = self.marked.clone().map(|m| div().absolute().left(at.x).top(at.y).h(px(LINE)).bg(ground).text_color(strong).underline().whitespace_nowrap().child(m));
        let note = match &self.stand {
            Stand::Away => Some("Reconnecting…".to_string()),
            Stand::Failed(why) => Some(if why.is_empty() { "The terminal did not start.".into() } else { why.clone() }),
            _ => None,
        };
        let (weak, slot, focus) = (cx.entity().downgrade(), self.bounds.clone(), self.focus.clone());
        let entity = cx.entity();
        div()
            .id("terminal")
            .relative()
            .size_full()
            .overflow_hidden()
            .bg(ground)
            .font_family(FONT)
            .text_size(px(SIZE))
            .line_height(px(LINE))
            .text_color(cx.theme().foreground)
            .track_focus(&self.focus)
            .cursor_text()
            .on_key_down(cx.listener(|t, e: &KeyDownEvent, _, cx| t.key_down(e, cx)))
            .on_mouse_down(MouseButton::Left, cx.listener(|t, e: &MouseDownEvent, window, cx| {
                window.focus(&t.focus, cx);
                let at = t.cell_at(e.position);
                if t.mouse(0, at, true) { t.held = Some(0); t.at = at }
            }))
            .on_mouse_up(MouseButton::Left, cx.listener(|t, e: &MouseUpEvent, _, _| {
                if t.held.take().is_some() { let at = t.cell_at(e.position); t.mouse(0, at, false); }
            }))
            .on_mouse_move(cx.listener(|t, e: &MouseMoveEvent, _, _| {
                let Some(button) = t.held else { return };
                let at = t.cell_at(e.position);
                let motion = matches!(t.parser.screen().mouse_protocol_mode(), vt100::MouseProtocolMode::ButtonMotion | vt100::MouseProtocolMode::AnyMotion);
                if motion && at != t.at { t.at = at; t.mouse(button + 32, at, true); }
            }))
            .on_scroll(cx.listener(|t, e: &ScrollEvent, _, cx| {
                let lines = match e.delta {
                    ScrollDelta::Lines(l) => l.y,
                    ScrollDelta::Pixels(p) => { t.wheel += p.y.as_f32() / LINE; let whole = t.wheel.trunc(); t.wheel -= whole; whole }
                };
                let at = t.cell_at(e.position);
                for _ in 0..(lines.abs().round() as usize).min(20) {
                    if !t.mouse(if lines > 0. { 64 } else { 65 }, at, true) { return }
                }
                cx.stop_propagation();
            }))
            // where it is laid out: the grid follows the half's size, and the input method types into it
            .child(
                canvas(
                    move |bounds, _, cx| {
                        if slot.get() != Some(bounds) {
                            slot.set(Some(bounds));
                            let weak = weak.clone();
                            cx.defer(move |cx| { let _ = weak.update(cx, |t, cx| t.fit(bounds, cx)); });
                        }
                    },
                    move |bounds, _, window, cx| window.handle_input(&focus, ElementInputHandler::new(bounds, entity.clone()), cx),
                )
                .absolute()
                .size_full(),
            )
            .child(rows)
            .children(hollow)
            .children(marked)
            .children(note.map(|n| div().absolute().left(px(16.)).right(px(16.)).bottom(px(12.)).font_family(cx.theme().font_family.clone()).text_size(px(12.)).text_color(muted).child(n)))
    }
}

// The input method's end: what it commits goes to the shell, and what it composes shows at the cursor until then.
impl EntityInputHandler for Terminal {
    fn text_for_range(&mut self, _: Range<usize>, _: &mut Option<Range<usize>>, _: &mut Window, _: &mut Context<Self>) -> Option<String> {
        None
    }

    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        Some(UTF16Selection { range: 0..0, reversed: false })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.as_ref().map(|m| 0..m.encode_utf16().count())
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        cx.notify();
    }

    fn replace_text_in_range(&mut self, _: Option<Range<usize>>, text: &str, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        self.send(text);
        cx.notify();
    }

    fn replace_and_mark_text_in_range(&mut self, _: Option<Range<usize>>, text: &str, _: Option<Range<usize>>, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = (!text.is_empty()).then(|| text.to_string());
        cx.notify();
    }

    fn bounds_for_range(&mut self, _: Range<usize>, element: Bounds<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<Bounds<Pixels>> {
        let (r, c) = self.parser.screen().cursor_position();
        Some(Bounds::new(point(element.left() + px(PAD.3 + c as f32 * self.cell), element.top() + px(PAD.0 + r as f32 * LINE)), size(px(self.cell), px(LINE))))
    }

    fn character_index_for_point(&mut self, _: Point<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::keys_for;
    use gpui_kit::Keystroke;

    fn keys(stroke: &'static str, app: bool) -> Option<String> {
        keys_for(&Keystroke::parse(stroke).unwrap(), app)
    }

    #[test]
    fn keys_as_xterm_sends_them() {
        assert_eq!(keys("enter", false).as_deref(), Some("\r"));
        assert_eq!(keys("backspace", false).as_deref(), Some("\x7f"));
        assert_eq!(keys("ctrl-c", false).as_deref(), Some("\x03"));
        assert_eq!(keys("ctrl-d", false).as_deref(), Some("\x04"));
        assert_eq!(keys("up", false).as_deref(), Some("\x1b[A"));
        assert_eq!(keys("up", true).as_deref(), Some("\x1bOA"));
        assert_eq!(keys("ctrl-left", false).as_deref(), Some("\x1b[1;5D"));
        assert_eq!(keys("shift-tab", false).as_deref(), Some("\x1b[Z"));
        assert_eq!(keys("alt-b", false).as_deref(), Some("\x1bb"));
        assert_eq!(keys("delete", false).as_deref(), Some("\x1b[3~"));
        assert_eq!(keys("f5", false).as_deref(), Some("\x1b[15~"));
        assert_eq!(keys("f1", false).as_deref(), Some("\x1bOP"));
        assert_eq!(keys("escape", false).as_deref(), Some("\x1b"));
        // letters go to the input method, which commits them
        assert_eq!(keys("a", false), None);
        assert_eq!(keys("shift-a", false), None);
    }
}
