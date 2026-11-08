// The Inbox's Filter and Display options, as the web app's (lists/parts.tsx), which copies Linear's: at the list's
// right edge in the bar, Show unreads only, Filter and Display options, Display with a dot while the display differs
// from its default. Filter (F) opens a menu of the properties, and typing finds their values straight away, as Linear's
// quick filters do; a property opens its values, each with how many rows have it, and a pick adds it to the filter or
// takes it out, its checkbox doing the same with the menu left open. The filters show as chips in a box at the top of
// the list: "Issue status is In review ×", whose "is" turns to "is not", whose values open their menu, and + after them.
// Display options (Shift V) is a panel of Ordering, Show unread first and Reset. The view itself is listing.rs's.
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gpui_kit::base::StyledExt;
use gpui_kit::component::input::{Enter, Escape, Input, InputEvent, InputState, MoveDown, MoveUp};
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

use crate::listing::{self, Icon, View, ORDERS};
use crate::{theme, Desk};

const MENU_W: f32 = 340.;
const PANEL_W: f32 = 300.;
const OPTIONS_W: f32 = 160.;

// Where each control the popups open under was last drawn, in the window, by name.
#[derive(Clone, Default)]
pub struct Anchors(Rc<RefCell<HashMap<String, Bounds<Pixels>>>>);

impl Anchors {
    pub fn get(&self, name: &str) -> Option<Bounds<Pixels>> {
        self.0.borrow().get(name).copied()
    }

    pub(crate) fn within(&self, name: &str, at: Point<Pixels>) -> bool {
        self.get(name).is_some_and(|b| b.contains(&at))
    }

    // An element over its parent that notes where the parent is drawn.
    pub(crate) fn probe(&self, name: impl Into<String>) -> impl IntoElement {
        let (anchors, name) = (self.clone(), name.into());
        canvas(move |bounds, _, _| { anchors.0.borrow_mut().insert(name, bounds); }, |_, _, _, _| {}).absolute().size_full()
    }
}

pub struct FilterMenu {
    field: Option<&'static str>, // None: the properties
    anchor: String,
    query: Entity<InputState>,
    on: usize,
    scroll: ScrollHandle,
}

enum Action {
    Field(&'static str),
    Toggle(&'static str, String),
}

struct Item {
    group: u8,
    icon: Option<Icon>,
    label: String,
    hint: Option<String>,
    checked: Option<bool>, // a checkbox, ticked or not
    more: bool,
    action: Action,
}

// lists/parts.tsx's colours: desk.css's tokens, its lch() values written in hex.
pub(crate) struct Colours {
    pub pop: Hsla, pub pop_edge: Hsla, pub pop_on: Hsla,
    pub text_1: Hsla, pub text_2: Hsla, pub text_3: Hsla,
    pub box_fill: Hsla, pub box_edge: Hsla, pub chip: Hsla, pub ring: Hsla, pub hover: Hsla, pub active: Hsla, pub ghost_hover: Hsla, pub ghost_on: Hsla,
    pub tip: Hsla, pub tip_edge: Hsla, pub tip_key: Hsla, pub tip_text: Hsla, pub select: Hsla, pub select_hover: Hsla, pub select_ring: Hsla, pub select_ring_strong: Hsla, pub select_on: Hsla,
    pub edge_3: Hsla, pub accent: Hsla,
    // the command menu's (.menu.command): its row in focus and its text, the hint and the keys' edge
    pub cmd_on: Hsla, pub cmd_on_text: Hsla, pub cmd_hint: Hsla, pub key_edge: Hsla,
    pub dark: bool,
}

pub(crate) fn colours(cx: &App) -> Colours {
    let c = |hex: u32| -> Hsla { rgb(hex).into() };
    let alpha = |hex: u32, a: f32| -> Hsla { let mut h: Hsla = rgb(hex).into(); h.a = a; h };
    let t = theme::text(cx);
    if cx.theme().mode.is_dark() {
        Colours {
            pop: c(0x1b1b1d), pop_edge: c(0x28282b), pop_on: c(0x29292b),
            text_1: t.strong, text_2: c(0xe3e4e6), text_3: c(0x959597),
            box_fill: c(0x1a1a1b), box_edge: c(0x212224), chip: c(0x1b1c1d), ring: alpha(0xffffff, 0.137), hover: c(0x1e1e20), active: c(0x29292b),
            ghost_hover: c(0x232424), ghost_on: c(0x2d2d2f),
            tip: c(0x212122), tip_edge: c(0x3c3d40), tip_key: c(0x9c9d9f), tip_text: c(0xe5e6e8), select: c(0x2a2b2c), select_hover: c(0x343537),
            select_ring: alpha(0xffffff, 0.148), select_ring_strong: alpha(0xffffff, 0.247), select_on: c(0xffffff),
            edge_3: c(0x28282b), accent: t.accent,
            cmd_on: c(0x313234), cmd_on_text: c(0xffffff), cmd_hint: c(0x626365), key_edge: c(0x303134), dark: true,
        }
    } else {
        Colours {
            pop: c(0xffffff), pop_edge: c(0xe8e8e8), pop_on: c(0xf1f1f1),
            text_1: t.strong, text_2: c(0x2f2f31), text_3: c(0x5c5c5e),
            box_fill: c(0xefeff0), box_edge: c(0xe2e2e2), chip: c(0xffffff), ring: alpha(0x000000, 0.09), hover: c(0xebebec), active: c(0xe1e1e2),
            ghost_hover: c(0xf0f0f1), ghost_on: c(0xf0f0f0),
            tip: c(0xffffff), tip_edge: c(0xe8e8e8), tip_key: c(0x5e5e60), tip_text: c(0x303032), select: c(0xffffff), select_hover: c(0xf3f3f3),
            select_ring: alpha(0x000000, 0.088), select_ring_strong: alpha(0x000000, 0.147), select_on: c(0x1b1b1b),
            edge_3: c(0xd3d3d3), accent: t.accent,
            cmd_on: c(0xf1f1f1), cmd_on_text: c(0x1b1b1b), cmd_hint: c(0xa0a0a2), key_edge: c(0xe8e8e8), dark: false,
        }
    }
}

fn shadow(blur: f32, y: f32, a: f32) -> BoxShadow {
    let mut colour: Hsla = rgb(0x000000).into();
    colour.a = a;
    BoxShadow { color: colour, offset: point(px(0.), px(y)), blur_radius: px(blur), spread_radius: px(0.), inset: false }
}

// A menu's shadow (--shadow-pop), and the Display panel's (--shadow-keys in dark, --shadow-pop in light).
pub(crate) fn pop_shadow(dark: bool) -> Vec<BoxShadow> {
    if dark { vec![shadow(32., 7., 0.4)] } else { vec![shadow(48., 9., 0.08), shadow(24., 6., 0.1), shadow(1., 1., 0.04)] }
}

// A modal's, the command menu's and the search's (--shadow-modal): five in dark, the menus' in light.
pub(crate) fn modal_shadow(dark: bool) -> Vec<BoxShadow> {
    if dark { vec![shadow(40., 4., 0.1), shadow(20., 3., 0.125), shadow(12., 3., 0.125), shadow(8., 2., 0.125), shadow(1., 1., 0.125)] } else { pop_shadow(false) }
}

pub(crate) fn panel_shadow(dark: bool) -> Vec<BoxShadow> {
    if dark { vec![shadow(8., 3., 0.125), shadow(5., 2., 0.125), shadow(1., 1., 0.125)] } else { pop_shadow(false) }
}

pub(crate) fn ring(colour: Hsla, width: f32) -> BoxShadow {
    BoxShadow { color: colour, offset: point(px(0.), px(0.)), blur_radius: px(0.), spread_radius: px(width), inset: false }
}

fn icon(icon: &Option<Icon>, size: f32, colour: Hsla, cx: &App) -> Option<AnyElement> {
    Some(match icon.as_ref()? {
        Icon::State(state) => theme::state_icon_sized(state, size, cx).into_any_element(),
        Icon::Priority(level) => crate::issue::priority_icon(level, cx).size(px(size)).into_any_element(),
        Icon::Glyph(name) => theme::glyph(name, colour).size(px(size)).into_any_element(),
    })
}

fn plural(name: &str) -> String {
    match name { "status" => "statuses".into(), "priority" => "priorities".into(), "from" => "senders".into(), _ => format!("{name}s") }
}

impl Desk {
    pub(crate) fn store(&self) -> listing::Store<'_> {
        listing::Store { inbox: &self.inbox, issues: &self.all, teams: &self.teams, projects: &self.projects }
    }

    // A change to the view, kept for the next run.
    pub(crate) fn set_view(&mut self, change: impl FnOnce(&mut View), cx: &mut Context<Self>) {
        change(&mut self.inbox_view);
        self.inbox_view.save();
        cx.notify();
    }

    // Filter's menu, or a property's values, under the control named.
    pub(crate) fn open_filter(&mut self, field: Option<&'static str>, anchor: &str, window: &mut Window, cx: &mut Context<Self>) {
        let placeholder = match field {
            Some(name) => format!("{}…", listing::FILTERS.iter().find(|(n, _)| *n == name).map(|(_, l)| *l).unwrap_or(name)),
            None => "Add filter…".into(),
        };
        let query = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
        query.update(cx, |q, cx| q.focus(window, cx));
        self._filter_typed = Some(cx.subscribe(&query, |desk, _, event: &InputEvent, cx| {
            if let InputEvent::Change = event {
                if let Some(menu) = &mut desk.filter_menu { menu.on = 0 }
                cx.notify();
            }
        }));
        self.display_open = false;
        self.filter_menu = Some(FilterMenu { field, anchor: anchor.into(), query, on: 0, scroll: ScrollHandle::new() });
        cx.notify();
    }

    pub(crate) fn close_popups(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let had = self.filter_menu.is_some() || self.display_open;
        self.filter_menu = None;
        self._filter_typed = None;
        self.display_open = false;
        self.order_open = false;
        if had { window.focus(&self.inbox_focus, cx) }
        cx.notify();
    }

    pub(crate) fn toggle_display(&mut self, cx: &mut Context<Self>) {
        self.filter_menu = None;
        self.order_open = false;
        self.display_open = !self.display_open;
        cx.notify();
    }

    fn items(&self, cx: &App) -> Vec<Item> {
        let Some(menu) = &self.filter_menu else { return Vec::new() };
        let typed = menu.query.read(cx).value().trim().to_lowercase();
        let open = self.open_row.as_deref();
        let fields = self.store().fields(&self.inbox_view, open);
        let on = |name: &str, v: &str| self.inbox_view.filter(name).is_some_and(|f| f.values.iter().any(|x| x == v));
        match menu.field {
            None => {
                let words: Vec<&str> = typed.split_whitespace().collect();
                let hit = |text: &str| { let text = text.to_lowercase(); words.iter().all(|w| text.contains(w)) };
                let mut items: Vec<Item> = fields.iter().filter(|f| hit(f.label)).map(|f| Item {
                    group: 0, icon: f.icon.clone(), label: f.label.into(), hint: None, checked: None, more: true, action: Action::Field(f.name),
                }).collect();
                if !words.is_empty() {
                    for f in &fields {
                        for v in f.values.iter().filter(|v| hit(&v.label)) {
                            items.push(Item { group: 1, icon: v.icon.clone(), label: v.label.clone(), hint: Some(f.label.into()),
                                checked: Some(on(f.name, &v.value)), more: false, action: Action::Toggle(f.name, v.value.clone()) });
                        }
                    }
                }
                items
            }
            Some(name) => fields.into_iter().filter(|f| f.name == name).flat_map(|f| f.values).filter(|v| v.label.to_lowercase().contains(&typed)).map(|v| Item {
                group: 0, icon: v.icon.clone(), hint: Some(format!("{} notification{}", v.count, if v.count == 1 { "" } else { "s" })),
                checked: Some(on(name, &v.value)), more: false, label: v.label, action: Action::Toggle(name, v.value),
            }).collect(),
        }
    }

    // A row of the menu picked: a property opens its values where the menu was; a value goes in or out of the filter,
    // and the menu closes, unless it was its checkbox.
    fn run_item(&mut self, n: usize, keep_open: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(item) = self.items(cx).into_iter().nth(n) else { return };
        match item.action {
            Action::Field(name) => {
                let anchor = self.filter_menu.as_ref().map(|m| m.anchor.clone()).unwrap_or_default();
                self.open_filter(Some(name), &anchor, window, cx);
            }
            Action::Toggle(name, value) => {
                self.set_view(|v| v.toggle(name, &value), cx);
                if !keep_open { self.close_popups(window, cx) }
            }
        }
    }

    fn move_on(&mut self, by: isize, cx: &mut Context<Self>) {
        let items = self.items(cx);
        let Some(menu) = &mut self.filter_menu else { return };
        if items.is_empty() { return }
        menu.on = (menu.on as isize + by).rem_euclid(items.len() as isize) as usize;
        // its place among the list's children, which hold a divider between groups
        let dividers = items.iter().take(menu.on + 1).enumerate().filter(|(i, it)| *i > 0 && it.group != items[i - 1].group).count();
        menu.scroll.scroll_to_item(menu.on + dividers);
        cx.notify();
    }

    // The bar's three controls at the list's right edge, as Linear's: 28px circles with no fill at rest.
    pub(crate) fn inbox_tools(&self, cx: &mut Context<Self>) -> Div {
        let c = colours(cx);
        let tool = |id: &'static str, glyph: &'static str, on: bool| {
            div()
                .id(id)
                .relative()
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(28.))
                .rounded_full()
                .cursor_pointer()
                .when(on, |b| b.bg(c.ghost_on))
                .when(!on, |b| b.hover(|s| s.bg(c.ghost_hover)))
                .child(theme::glyph(glyph, if on { c.text_1 } else { c.text_3 }))
                .child(self.anchors.probe(id))
        };
        let unreads = tool("unreads", "unreads", self.inbox_view.unread).on_click(cx.listener(|desk, _, _, cx| {
            let on = !desk.inbox_view.unread;
            desk.stay = if on { desk.inbox.values().filter(|r| !r.read).map(|r| r.id.clone()).collect() } else { Default::default() };
            desk.set_view(|v| v.unread = on, cx);
        }));
        let filter = tool("filter", "filter", false).on_click(cx.listener(|desk, _, window, cx| {
            if desk.filter_menu.as_ref().is_some_and(|m| m.anchor == "filter") { desk.close_popups(window, cx) } else { desk.open_filter(None, "filter", window, cx) }
        }));
        let display = tool("display", "display", false)
            .when(!self.inbox_view.is_default(), |b| b.child(div().absolute().top_0().right_0().size(px(7.)).rounded_full().bg(c.accent)))
            .on_click(cx.listener(|desk, _, _, cx| desk.toggle_display(cx)));
        div().h_flex().gap(px(6.)).child(unreads).child(filter).child(display)
    }

    // The filters as chips, in a box at the top of the list, as Linear's Inbox has them: 10px round them, the chips
    // filled as buttons and ringed, 4px apart, with + and no Clear.
    pub(crate) fn filter_box(&self, cx: &mut Context<Self>) -> Option<Div> {
        let chips = self.store().chips(&self.inbox_view);
        if chips.is_empty() { return None }
        let c = colours(cx);
        let part = |id: SharedString| {
            div().id(id).h_flex().h_full().px(px(6.)).gap(px(4.)).border_l(px(0.5)).border_color(c.ring).text_color(c.text_2).cursor_pointer()
                .hover(|s| s.bg(c.hover).text_color(c.text_1))
        };
        let mut row = div().h_flex().flex_wrap().gap(px(4.)).p(px(10.)).rounded(px(8.)).border(px(0.5)).border_color(c.box_edge).bg(c.box_fill)
            .text_size(px(12.)).font_medium();
        for chip in chips {
            let n = chip.values.len();
            let mut icons: Vec<Icon> = Vec::new();
            for (_, _, i) in &chip.values { if let Some(i) = i { if !icons.contains(i) && icons.len() < 3 { icons.push(i.clone()) } } }
            let words = if n < 3 { chip.values.iter().map(|v| v.1.clone()).collect::<Vec<_>>().join(", ") } else { format!("{n} {}", plural(&chip.name)) };
            let op = if chip.not { "is not" } else if n > 1 { "is either of" } else { "is" };
            let (flip, pick, remove) = (chip.name.clone(), chip.name.clone(), chip.name.clone());
            let anchor = format!("chip-{}", chip.name);
            row = row.child(
                div().h_flex().h(px(24.)).rounded(px(6.)).border(px(0.5)).border_color(c.ring).bg(c.chip).overflow_hidden()
                    .child(div().h_flex().h_full().px(px(6.)).text_color(c.text_2).child(chip.label))
                    .child(part(format!("op-{}", chip.name).into()).text_color(c.text_3).font_normal().child(op)
                        .on_click(cx.listener(move |desk, _, _, cx| desk.set_view(|v| v.flip(&flip), cx))))
                    .child(part(format!("values-{}", chip.name).into()).relative().max_w(px(240.))
                        .children(icons.iter().filter_map(|i| icon(&Some(i.clone()), 14., c.text_3, cx)))
                        .child(div().min_w_0().truncate().child(words))
                        .child(self.anchors.probe(anchor.clone()))
                        .on_click(cx.listener(move |desk, _, window, cx| {
                            let name = listing::FILTERS.iter().find(|(n, _)| *n == pick).map(|(n, _)| *n);
                            if let Some(name) = name { desk.open_filter(Some(name), &format!("chip-{pick}"), window, cx) }
                        })))
                    .child(part(format!("remove-{}", chip.name).into()).text_color(c.text_3).child(theme::glyph("close", c.text_3).size(px(12.)))
                        .on_click(cx.listener(move |desk, _, _, cx| desk.set_view(|v| v.remove(&remove), cx)))),
            );
        }
        let add = div().id("filter-add").relative().flex().items_center().justify_center().size(px(24.)).rounded(px(6.)).cursor_pointer()
            .hover(|s| s.bg(c.active))
            .child(theme::glyph("plus", c.text_3))
            .child(self.anchors.probe("filter-add"))
            .on_click(cx.listener(|desk, _, window, cx| desk.open_filter(None, "filter-add", window, cx)));
        Some(div().pl(px(8.)).pr(px(10.)).pb(px(8.)).child(row.child(add)))
    }

    // The open menu, under what opened it.
    pub(crate) fn filter_popup(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let menu = self.filter_menu.as_ref()?;
        let at = self.anchors.get(&menu.anchor).map(|b| point(b.left(), b.bottom() + px(4.))).unwrap_or(point(px(400.), px(48.)));
        let c = colours(cx);
        let items = self.items(cx);
        let mut list = div().id("filter-items").v_flex().max_h(px(300.)).overflow_y_scroll().track_scroll(&menu.scroll).px(px(4.));
        for (n, item) in items.iter().enumerate() {
            if n > 0 && item.group != items[n - 1].group {
                list = list.child(div().flex_none().h(px(1.)).my(px(4.)).mx(px(-4.)).bg(c.pop_edge));
            }
            let lit = n == menu.on;
            let check = item.checked.map(|ticked| {
                div().id(("filter-check", n)).flex().flex_none().items_center().justify_center().size(px(14.)).mr(px(-2.)).rounded(px(3.))
                    .border(px(0.5)).border_color(if ticked { c.accent } else { c.text_3 })
                    .when(ticked, |b| b.bg(c.accent).child(theme::glyph("tick", rgb(0xffffff).into()).size(px(10.))))
                    .when(!lit && !ticked, |b| b.invisible())
                    .on_click(cx.listener(move |desk, _, window, cx| { cx.stop_propagation(); desk.run_item(n, true, window, cx) }))
            });
            list = list.child(
                div().id(("filter-item", n)).h_flex().flex_none().h(px(32.)).px(px(8.)).gap(px(10.)).rounded(px(6.)).cursor_pointer()
                    .text_color(c.text_1)
                    .when(lit, |r| r.bg(c.pop_on))
                    .children(check)
                    .children(icon(&item.icon, 16., c.text_3, cx))
                    .child(div().flex_1().min_w_0().truncate().child(item.label.clone()))
                    .children(item.hint.clone().map(|h| div().flex_none().text_size(px(12.)).text_color(c.text_3).child(h)))
                    .when(item.more, |r| r.child(theme::glyph("chevron-right", c.text_3).size(px(14.))))
                    .on_hover(cx.listener(move |desk, on: &bool, _, cx| {
                        if *on { if let Some(menu) = &mut desk.filter_menu { if menu.on != n { menu.on = n; cx.notify() } } }
                    }))
                    .on_click(cx.listener(move |desk, _, window, cx| desk.run_item(n, false, window, cx))),
            );
        }
        if items.is_empty() {
            list = list.child(div().h_flex().h(px(32.)).px(px(8.)).text_color(c.text_3).child("No match"));
        }
        let head = div().h_flex().h(px(38.)).px(px(12.)).mb(px(4.)).border_b(px(0.5)).border_color(c.pop_edge)
            .child(Input::new(&menu.query).appearance(false).text_size(px(13.)));
        let opener = menu.anchor.clone();
        let box_ = div()
            .id("filter-menu")
            .occlude()
            .w(px(MENU_W))
            .pb(px(4.))
            .rounded(px(8.))
            .border(px(0.5))
            .border_color(c.pop_edge)
            .bg(c.pop)
            .shadow(pop_shadow(c.dark))
            .text_size(px(13.))
            .capture_action(cx.listener(|desk, _: &MoveDown, _, cx| desk.move_on(1, cx)))
            .capture_action(cx.listener(|desk, _: &MoveUp, _, cx| desk.move_on(-1, cx)))
            .capture_action(cx.listener(|desk, _: &Enter, window, cx| {
                let on = desk.filter_menu.as_ref().map(|m| m.on).unwrap_or(0);
                desk.run_item(on, false, window, cx);
            }))
            .capture_action(cx.listener(|desk, _: &Escape, window, cx| desk.close_popups(window, cx)))
            .on_mouse_down_out(cx.listener(move |desk, e: &MouseDownEvent, window, cx| {
                if !desk.anchors.within(&opener, e.position) { desk.close_popups(window, cx) }
            }))
            .child(head)
            .child(list);
        Some(deferred(anchored().position(at).snap_to_window_with_margin(px(8.)).child(box_)).with_priority(2).into_any_element())
    }

    // Display options, Linear's panel: Ordering, then Show unread first under a line, and Reset at its foot.
    pub(crate) fn display_popup(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.display_open { return None }
        let c = colours(cx);
        let anchor = self.anchors.get("display")?;
        let at = point((anchor.right() - px(PANEL_W)).max(px(8.)), anchor.bottom() + px(6.));
        let view = &self.inbox_view;
        let order = ORDERS.iter().find(|(o, _)| *o == view.order).map(|(_, l)| *l).unwrap_or("Newest");
        let (hover, ring_strong, lit) = (c.select_hover, c.select_ring_strong, c.select_on);
        let select = div().id("dp-order").relative().h_flex().min_w(px(116.)).h(px(24.)).pl(px(8.)).pr(px(18.)).rounded(px(8.))
            .bg(c.select).shadow(vec![ring(c.select_ring, 0.5)]).text_color(c.tip_text).font_normal().cursor_pointer()
            .hover(move |s| s.bg(hover).shadow(vec![ring(ring_strong, 0.5)]).text_color(lit))
            .child(order)
            .child(div().absolute().right(px(6.)).top(px(7.5)).child(theme::glyph("select-chevron", c.tip_text).size(px(9.))))
            .child(self.anchors.probe("dp-order"))
            .on_click(cx.listener(|desk, _, _, cx| { desk.order_open = !desk.order_open; cx.notify() }));
        let row = |label: &'static str| div().h_flex().h(px(32.)).gap(px(4.)).child(div().flex_1().child(label));
        let on = view.first;
        let switch = div().id("dp-first").relative().w(px(22.)).h(px(14.)).rounded_full().cursor_pointer()
            .bg(if on { c.accent } else { c.active })
            .when(!on, |s| s.shadow(vec![BoxShadow { inset: true, ..ring(c.edge_3, 0.5) }]))
            .child(div().absolute().top(px(2.)).left(px(if on { 10. } else { 2. })).size(px(10.)).rounded_full().bg(if on { rgb(0xffffff).into() } else { c.text_3 }))
            .on_click(cx.listener(|desk, _, _, cx| desk.set_view(|v| v.first = !v.first, cx)));
        let reset = div().id("dp-reset").h_flex().h(px(24.)).px(px(8.)).rounded_full().text_color(c.text_1).cursor_pointer()
            .hover(|s| s.bg(c.active))
            .child("Reset")
            .on_click(cx.listener(|desk, _, _, cx| desk.set_view(|v| { v.order = "newest".into(); v.first = false; }, cx)));
        let panel = div()
            .id("display-panel")
            .occlude()
            .v_flex()
            .w(px(PANEL_W))
            .pt(px(8.))
            .px(px(16.))
            .rounded(px(12.))
            .border(px(0.5))
            .border_color(c.tip_edge)
            .bg(c.tip)
            .shadow(panel_shadow(c.dark))
            .text_size(px(12.))
            .font_medium()
            .text_color(c.tip_key)
            .on_mouse_down_out(cx.listener(|desk, e: &MouseDownEvent, _, cx| {
                let inside = desk.anchors.within("display", e.position) || (desk.order_open && desk.anchors.within("dp-options", e.position));
                if !inside { desk.display_open = false; desk.order_open = false; cx.notify() }
            }))
            .child(row("Ordering").child(select))
            .child(div().flex_none().h(px(1.)).my(px(8.)).mx(px(-16.)).bg(c.tip_edge))
            .child(row("Show unread first").child(switch))
            .child(div().h_flex().justify_end().mt(px(8.)).mx(px(-16.)).py(px(8.)).px(px(12.)).border_t(px(0.5)).border_color(c.tip_edge).child(reset));
        Some(deferred(anchored().position(at).snap_to_window_with_margin(px(8.)).child(panel)).with_priority(1).into_any_element())
    }

    // Ordering's choices, under its select, each with a tick on the one picked.
    pub(crate) fn order_popup(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !(self.display_open && self.order_open) { return None }
        let c = colours(cx);
        let select = self.anchors.get("dp-order")?;
        let at = point(select.left(), select.bottom() + px(4.));
        let mut list = div().v_flex().py(px(4.)).px(px(4.));
        for (value, label) in ORDERS {
            let current = self.inbox_view.order == value;
            list = list.child(
                div().id(value).h_flex().h(px(32.)).px(px(8.)).gap(px(10.)).rounded(px(6.)).cursor_pointer().text_color(c.text_1)
                    .hover(|s| s.bg(c.pop_on))
                    .child(div().flex_1().child(label))
                    .when(current, |r| r.child(theme::glyph("tick", c.text_1).size(px(14.))))
                    .on_click(cx.listener(move |desk, _, _, cx| { desk.order_open = false; desk.set_view(|v| v.order = value.into(), cx) })),
            );
        }
        let menu = div().id("dp-options").occlude().relative().w(px(OPTIONS_W)).rounded(px(8.)).border(px(0.5)).border_color(c.pop_edge).bg(c.pop)
            .shadow(pop_shadow(c.dark)).text_size(px(13.))
            .child(self.anchors.probe("dp-options"))
            .on_mouse_down_out(cx.listener(|desk, e: &MouseDownEvent, _, cx| {
                if !desk.anchors.within("dp-order", e.position) { desk.order_open = false; cx.notify() }
            }))
            .child(list);
        Some(deferred(anchored().position(at).snap_to_window_with_margin(px(8.)).child(menu)).with_priority(3).into_any_element())
    }
}
