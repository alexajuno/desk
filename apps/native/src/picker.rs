// An issue's property menus, as the web's (issues/menus.tsx, opened by ui/menu.tsx; desk.css's .menu): a box under the
// row or chip clicked, its input on top. Typing narrows the rows to those holding every word, the arrows move, and the
// one it is now has a tick and is lit as the menu opens. Enter picks the row lit or, with none, takes what was typed
// where the menu reads it (Waiting on, Works in), and Tab completes a folder as a shell does. The due date's is Linear's
// date picker (ui/datepicker.tsx): a day typed, which desk reads (periods.ts), or picked from a month's calendar,
// Mondays first.
use chrono::{Datelike, Local, NaiveDate};
use gpui_kit::base::StyledExt;
use gpui_kit::component::input::{Enter, Escape, IndentInline, Input, InputEvent, InputState, MoveDown, MoveUp};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

use crate::filters::{colours, panel_shadow, pop_shadow};
use crate::{net, theme};

#[derive(Clone)]
pub struct Pick {
    pub icon: &'static str,
    pub label: String,
    pub value: String,
    pub current: bool,
}

pub enum Source {
    Fixed(Vec<Pick>),
    Folders(String), // your repos and the folders used before, as desk finds them for what was typed; the folder it is now
}

pub enum PickerEvent {
    Picked(String),
    Typed(String), // Enter with no row lit, where the menu takes what was typed
    Closed,
}

pub struct Picker {
    query: Entity<InputState>,
    source: Source,
    found: Vec<Pick>, // Folders: desk's latest answer
    asked: u64,
    on: usize,
    scroll: ScrollHandle,
    width: f32,
    empty: &'static str,
    takes_typed: bool,
    pub anchor: Bounds<Pixels>, // what opened it, where a press neither closes it nor reaches the page under it
    _typed: Subscription,
}

impl EventEmitter<PickerEvent> for Picker {}

pub struct Menu {
    pub source: Source,
    pub placeholder: &'static str,
    pub empty: &'static str,
    pub width: f32,
    pub takes_typed: bool,
    pub start: String, // what the input holds as it opens: who it waits on now
}

fn words(text: &str) -> Vec<String> {
    text.to_lowercase().split_whitespace().map(str::to_string).collect()
}

fn encode(text: &str) -> String {
    text.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~/".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

// What the rows share from their start.
fn shared_start(texts: &[String]) -> String {
    let Some(first) = texts.first() else { return String::new() };
    let mut end = first.len();
    for text in &texts[1..] {
        end = first.char_indices().zip(text.chars()).take_while(|((i, a), b)| *i < end && a == b).last().map(|((i, a), _)| i + a.len_utf8()).unwrap_or(0).min(end);
    }
    first[..end].to_string()
}

impl Picker {
    pub fn new(menu: Menu, anchor: Bounds<Pixels>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let Menu { source, placeholder, empty, width, takes_typed, start } = menu;
        let query = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder).default_value(start));
        query.update(cx, |q, cx| q.focus(window, cx));
        let typed = cx.subscribe(&query, |picker, _, event: &InputEvent, cx| {
            if let InputEvent::Change = event {
                picker.on = 0;
                picker.ask(cx);
                cx.notify();
            }
        });
        let on = match &source { Source::Fixed(items) => items.iter().position(|p| p.current).unwrap_or(0), Source::Folders(_) => 0 };
        let mut picker = Self { query, source, found: Vec::new(), asked: 0, on, scroll: ScrollHandle::new(), width, empty, takes_typed, anchor, _typed: typed };
        picker.ask(cx);
        picker
    }

    // The folders desk finds for what is typed; an answer to an older query is dropped.
    fn ask(&mut self, cx: &mut Context<Self>) {
        let Source::Folders(_) = &self.source else { return };
        self.asked += 1;
        let (asked, path) = (self.asked, format!("/api/folders?q={}", encode(&self.query.read(cx).value())));
        cx.spawn(async move |this, cx| {
            let answer = cx.background_spawn(async move { net::get(&path) }).await;
            let _ = this.update(cx, |picker, cx| {
                if picker.asked != asked { return }
                let Source::Folders(now) = &picker.source else { return };
                picker.found = answer.ok().and_then(|v| v.as_array().cloned()).unwrap_or_default().iter().filter_map(|v| v.as_str()).map(|path| Pick {
                    icon: "folder", label: path.into(), value: path.into(), current: path == now,
                }).collect();
                picker.on = picker.on.min(picker.found.len().saturating_sub(1));
                cx.notify();
            });
        })
        .detach();
    }

    fn items(&self, cx: &App) -> Vec<Pick> {
        match &self.source {
            Source::Fixed(items) => {
                let words = words(&self.query.read(cx).value());
                items.iter().filter(|p| { let label = p.label.to_lowercase(); words.iter().all(|w| label.contains(w)) }).cloned().collect()
            }
            Source::Folders(_) => self.found.clone(),
        }
    }

    fn enter(&mut self, cx: &mut Context<Self>) {
        match self.items(cx).into_iter().nth(self.on) {
            Some(pick) => cx.emit(PickerEvent::Picked(pick.value)),
            None if self.takes_typed => cx.emit(PickerEvent::Typed(self.query.read(cx).value().trim().to_string())),
            None => {}
        }
    }

    fn move_on(&mut self, by: isize, cx: &mut Context<Self>) {
        let n = self.items(cx).len();
        if n == 0 { return }
        self.on = (self.on as isize + by).clamp(0, n as isize - 1) as usize;
        self.scroll.scroll_to_item(self.on);
        cx.notify();
    }

    // Tab, in Works in: what the rows share, so proj gives ~/projects/ rather than the first row's ~/projects/adblock/,
    // while it still holds every word typed; else the row lit, with its /.
    fn complete(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Source::Folders(_) = &self.source else { return };
        let typed = self.query.read(cx).value().to_string();
        let shown: Vec<String> = self.found.iter().map(|p| p.label.clone()).collect();
        let common = if shown.len() > 1 { shared_start(&shown) } else { String::new() };
        let lower = common.to_lowercase();
        let next = if common.len() > typed.len() && words(&typed).iter().all(|w| lower.contains(w)) {
            common
        } else if let Some(row) = shown.get(self.on) {
            format!("{row}/")
        } else {
            return;
        };
        self.query.update(cx, |q, cx| q.set_value(next, window, cx));
    }
}

impl Render for Picker {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = colours(cx);
        let items = self.items(cx);
        let mut list = div().id("pick-items").v_flex().max_h(px(300.)).overflow_y_scroll().track_scroll(&self.scroll).px(px(4.));
        for (n, item) in items.iter().enumerate() {
            let value = item.value.clone();
            list = list.child(
                div().id(("pick", n)).h_flex().flex_none().h(px(32.)).px(px(8.)).gap(px(10.)).rounded(px(6.)).cursor_pointer().text_color(c.text_1)
                    .when(n == self.on, |r| r.bg(c.pop_on))
                    .child(theme::glyph(item.icon, c.text_3).size(px(16.)))
                    .child(div().flex_1().min_w_0().truncate().child(item.label.clone()))
                    .when(item.current, |r| r.child(theme::glyph("tick", c.text_1).size(px(14.))))
                    .on_hover(cx.listener(move |picker, on: &bool, _, cx| if *on && picker.on != n { picker.on = n; cx.notify() }))
                    .on_click(cx.listener(move |_, _, _, cx| cx.emit(PickerEvent::Picked(value.clone())))),
            );
        }
        if items.is_empty() {
            list = list.child(div().h_flex().h(px(32.)).px(px(8.)).text_color(c.text_3).child(self.empty));
        }
        let anchor = self.anchor;
        div()
            .id("picker")
            .occlude()
            .w(px(self.width))
            .pb(px(4.))
            .rounded(px(8.))
            .border(px(0.5))
            .border_color(c.pop_edge)
            .bg(c.pop)
            .shadow(pop_shadow(c.dark))
            .text_size(px(13.))
            .capture_action(cx.listener(|picker, _: &MoveDown, _, cx| picker.move_on(1, cx)))
            .capture_action(cx.listener(|picker, _: &MoveUp, _, cx| picker.move_on(-1, cx)))
            .capture_action(cx.listener(|picker, _: &Enter, _, cx| picker.enter(cx)))
            .capture_action(cx.listener(|picker, _: &IndentInline, window, cx| picker.complete(window, cx)))
            .capture_action(cx.listener(|_, _: &Escape, _, cx| cx.emit(PickerEvent::Closed)))
            .on_mouse_down_out(cx.listener(move |_, e: &MouseDownEvent, _, cx| if !anchor.contains(&e.position) { cx.emit(PickerEvent::Closed) }))
            .child(div().h_flex().h(px(38.)).px(px(12.)).mb(px(4.)).border_b(px(0.5)).border_color(c.pop_edge).child(Input::new(&self.query).appearance(false).text_size(px(13.))))
            .child(list)
    }
}

// --- the due date ---------------------------------------------------------------------------------------------------

const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEK: [&str; 7] = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

pub struct DatePick {
    typed: Entity<InputState>,
    current: Option<NaiveDate>,
    month: NaiveDate, // its first day
    pub anchor: Bounds<Pixels>,
}

impl EventEmitter<PickerEvent> for DatePick {}

impl DatePick {
    pub fn new(current: Option<&str>, anchor: Bounds<Pixels>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let typed = cx.new(|cx| InputState::new(window, cx).placeholder("Try: 20/05/2027, Nov 8"));
        typed.update(cx, |t, cx| t.focus(window, cx));
        let current = current.and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
        let from = current.unwrap_or_else(|| Local::now().date_naive());
        Self { typed, current, month: from.with_day(1).unwrap_or(from), anchor }
    }

    fn step(&mut self, by: i32, cx: &mut Context<Self>) {
        let n = self.month.year() * 12 + self.month.month0() as i32 + by;
        self.month = NaiveDate::from_ymd_opt(n.div_euclid(12), n.rem_euclid(12) as u32 + 1, 1).unwrap_or(self.month);
        cx.notify();
    }
}

// How a chip writes a day, as Linear's: Apr 21st, with its year when not this one (periods.ts, label).
pub fn day_label(text: &str) -> Option<String> {
    let day = NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()?;
    let d = day.day();
    let ord = match (d % 10, d) { (1, n) if n != 11 => "st", (2, n) if n != 12 => "nd", (3, n) if n != 13 => "rd", _ => "th" };
    let year = if day.year() == Local::now().year() { String::new() } else { format!(", {}", day.year()) };
    Some(format!("{} {d}{ord}{year}", &MONTHS[day.month0() as usize][..3]))
}

// Days from today: 0 today, negative once passed.
pub fn days_left(text: &str) -> Option<i64> {
    let day = NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()?;
    Some((day - Local::now().date_naive()).num_days())
}

impl Render for DatePick {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = colours(cx);
        let dark = c.dark;
        let weekend: Hsla = if dark { rgb(0x2a2b2c).into() } else { rgb(0xffffff).into() }; // --bg-dp-layout
        let link_bar: Hsla = if dark { rgb(0x505154).into() } else { rgb(0xd8d8d8).into() }; // --border-link-bar
        let white: Hsla = rgb(0xffffff).into();
        let today = Local::now().date_naive();
        let lead = self.month.weekday().num_days_from_monday() as i64;
        let next = { let n = self.month.year() * 12 + self.month.month0() as i32 + 1; NaiveDate::from_ymd_opt(n.div_euclid(12), n.rem_euclid(12) as u32 + 1, 1).unwrap_or(self.month) };
        let length = (next - self.month).num_days();
        let cells = ((lead + length + 6) / 7) * 7;

        let step = |id: &'static str, glyph: &'static str, by: i32| {
            div().id(id).flex().items_center().justify_center().size(px(24.)).rounded_full().cursor_pointer().hover(|s| s.bg(c.active))
                .child(theme::glyph(glyph, c.tip_key).size(px(16.)))
                .on_click(cx.listener(move |pick, _, _, cx| pick.step(by, cx)))
        };
        let head = div().h_flex().h(px(28.)).gap(px(4.)).mb(px(8.)).text_size(px(12.)).font_medium().text_color(c.tip_text)
            .child(div().flex_1().child(format!("{} {}", MONTHS[self.month.month0() as usize], self.month.year())))
            .child(step("cal-back", "chevron-left", -1))
            .child(step("cal-on", "chevron-right", 1));
        let mut grid = div().v_flex();
        let mut week = div().h_flex();
        for (n, name) in WEEK.iter().enumerate() {
            week = week.child(div().flex_1().h(px(32.)).flex().items_center().justify_center().text_size(px(12.)).font_medium().text_color(c.tip_key)
                .when(n > 4, |d| d.bg(weekend).rounded_t(px(6.))).child(*name));
        }
        grid = grid.child(week);
        for row in 0..cells / 7 {
            let mut line = div().h_flex();
            for col in 0..7 {
                let day = self.month + chrono::Duration::days(row * 7 + col - lead);
                let out = day.month() != self.month.month();
                let on = self.current == Some(day);
                let text = day.format("%Y-%m-%d").to_string();
                let edge = if day == today { link_bar } else { c.tip_edge };
                line = line.child(
                    div().id(SharedString::from(format!("day-{text}"))).flex_1().h(px(34.)).flex().items_center().justify_center().cursor_pointer()
                        .when(col > 4, |d| d.bg(weekend))
                        .child(
                            div().flex().items_center().justify_center().size(px(26.)).rounded_full().text_size(px(12.))
                                .text_color(if on { white } else if out { c.tip_key } else { c.tip_text })
                                .when(out && !on, |d| d.opacity(0.6))
                                .when(on, |d| d.bg(c.accent))
                                .when(!on && day == today, |d| d.border_1().border_color(link_bar))
                                .when(!on && day != today, move |d| d.border_1().border_color(transparent_black()).hover(move |s| s.border_color(edge)))
                                .child(day.day().to_string()),
                        )
                        .on_click(cx.listener(move |_, _, _, cx| cx.emit(PickerEvent::Picked(text.clone())))),
                );
            }
            grid = grid.child(line);
        }
        let clear = self.current.is_some().then(|| {
            div().h_flex().justify_end().mt(px(4.)).child(
                div().id("date-clear").h_flex().h(px(24.)).px(px(8.)).rounded_full().text_size(px(12.)).font_medium().text_color(c.tip_key).cursor_pointer()
                    .hover(|s| s.bg(c.active))
                    .child("Remove date")
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(PickerEvent::Picked(String::new())))),
            )
        });
        let anchor = self.anchor;
        div()
            .id("date-pick")
            .occlude()
            .w(px(304.))
            .rounded(px(8.))
            .border(px(0.5))
            .border_color(c.tip_edge)
            .bg(c.tip)
            .shadow(panel_shadow(dark))
            .capture_action(cx.listener(|pick, _: &Enter, _, cx| {
                let typed = pick.typed.read(cx).value().trim().to_string();
                if !typed.is_empty() { cx.emit(PickerEvent::Typed(typed)) }
            }))
            .capture_action(cx.listener(|_, _: &Escape, _, cx| cx.emit(PickerEvent::Closed)))
            .on_mouse_down_out(cx.listener(move |_, e: &MouseDownEvent, _, cx| if !anchor.contains(&e.position) { cx.emit(PickerEvent::Closed) }))
            .child(
                div().p(px(16.)).border_b(px(0.5)).border_color(c.tip_edge)
                    .child(div().mb(px(8.)).text_size(px(12.)).font_medium().text_color(c.tip_key).child("Due date"))
                    .child(div().h_flex().h(px(32.)).px(px(2.)).rounded(px(8.)).border(px(0.5)).border_color(link_bar).bg(c.tip)
                        .child(Input::new(&self.typed).appearance(false).text_size(px(12.)))),
            )
            .child(div().px(px(16.)).py(px(12.)).child(head).child(grid).children(clear))
    }
}
