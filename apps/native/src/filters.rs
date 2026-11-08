// Filter and Display options, as the web app's (lists/parts.tsx), which copies Linear's, for the Inbox's view and an
// issue list's alike. Filter (F) opens a menu of the properties, and typing finds their values straight away, as
// Linear's quick filters do; a property opens its values, each with how many rows have it, and a pick adds it to the
// filter or takes it out, its checkbox doing the same with the menu left open. The filters show as chips, "Issue status
// is In review ×", whose "is" turns to "is not", whose values open their menu, and + after them. Display options (Shift
// V) is a panel of the view's own choices: Layout, then Grouping and Ordering with its direction, the rest under a
// line, its switches, and Reset. What a view holds, and how a change reaches it, is its owner's (Filtering): the Inbox
// works its view out in the window (listing.rs), and an issue list's is desk's server's (lists.rs).
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gpui_kit::base::StyledExt;
use gpui_kit::component::input::{Enter, Escape, Input, InputEvent, InputState, MoveDown, MoveUp};
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

use crate::listing::{Chip, Field, Icon, ORDERS};
use crate::tip::Tipped;
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
    field: Option<String>, // None: the properties
    anchor: String,
    query: Entity<InputState>,
    on: usize,
    scroll: ScrollHandle,
}

// What a view's owner keeps of its popups: Filter's menu, the Display panel, and the panel's select whose options are
// open, by its word.
#[derive(Default)]
pub struct Popups {
    menu: Option<FilterMenu>,
    _typed: Option<Subscription>,
    pub display: bool,
    select: Option<String>,
}

impl Popups {
    pub fn any(&self) -> bool {
        self.menu.is_some() || self.display
    }

    // What the open Filter menu opened under.
    pub fn menu_at(&self) -> Option<&str> {
        self.menu.as_ref().map(|m| m.anchor.as_str())
    }
}

enum Action {
    Field(String),
    Toggle(String, String),
}

pub(crate) struct Item {
    group: u8,
    icon: Option<Icon>,
    label: String,
    hint: Option<String>,
    checked: Option<bool>, // a checkbox, ticked or not
    more: bool,
    action: Action,
}

// One of Display's choices: its word in the view, its label, its options as value and label, and the one picked.
pub(crate) struct Select {
    pub key: String,
    pub label: String,
    pub options: Vec<(String, String)>,
    pub current: String,
}

// Display options' rows, as the view has them.
#[derive(Default)]
pub(crate) struct Panel {
    pub layout: Option<Select>,
    pub first: Vec<Select>,                    // Grouping and Ordering
    pub rest: Vec<Select>,                     // under a line
    pub switches: Vec<(String, String, bool)>, // a switch's word, its label, and whether it is on
    pub reverse: Option<bool>,                 // Ordering's direction, where it has one: reversed or not
}

// The chips' look: in a box, as Linear's Inbox has them, or a list's bar, which ends in Clear.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum ChipsLook {
    Inbox,
    List,
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
    // the issue lists' (lists.rs): the open view tab, a ring under the mouse, the group's triangle, a date passed, a
    // selected row and under the mouse, a round button under the mouse
    pub tab_on: Hsla, pub ring_hover: Hsla, pub group_toggle: Hsla, pub late: Hsla, pub selected: Hsla, pub selected_hover: Hsla, pub btn_hover: Hsla,
    // a list's filter chip (bg-panel), and Display's Layout button under the mouse and picked (bg-dp-layout-hover, bg-dp-on)
    pub panel: Hsla, pub layout_hover: Hsla, pub layout_on: Hsla,
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
            cmd_on: c(0x313234), cmd_on_text: c(0xffffff), cmd_hint: c(0x626365), key_edge: c(0x303134),
            tab_on: c(0x29292b), ring_hover: alpha(0xffffff, 0.229), group_toggle: c(0x2c313b), late: c(0xff6364), selected: c(0x1f2029), selected_hover: c(0x242531),
            btn_hover: c(0x252527), panel: c(0x121213), layout_hover: c(0x323334), layout_on: c(0x38393b), dark: true,
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
            cmd_on: c(0xf1f1f1), cmd_on_text: c(0x1b1b1b), cmd_hint: c(0xa0a0a2), key_edge: c(0xe8e8e8),
            tab_on: c(0xececed), ring_hover: alpha(0x000000, 0.15), group_toggle: c(0xc4c8df), late: c(0xe2253b), selected: c(0xeaeaf4), selected_hover: c(0xe2e3f1),
            btn_hover: c(0xf3f3f3), panel: c(0xf9f9fa), layout_hover: c(0xf6f6f6), layout_on: c(0xf2f2f2), dark: false,
        }
    }
}

fn shadow(blur: f32, y: f32, a: f32) -> BoxShadow {
    spread_shadow(blur, y, 0., a)
}

fn spread_shadow(blur: f32, y: f32, spread: f32, a: f32) -> BoxShadow {
    let mut colour: Hsla = rgb(0x000000).into();
    colour.a = a;
    BoxShadow { color: colour, offset: point(px(0.), px(y)), blur_radius: px(blur), spread_radius: px(spread), inset: false }
}

// A menu's shadow (--shadow-pop).
pub(crate) fn pop_shadow(dark: bool) -> Vec<BoxShadow> {
    if dark { vec![shadow(32., 7., 0.4)] } else { vec![shadow(48., 9., 0.08), shadow(24., 6., 0.1), shadow(1., 1., 0.04)] }
}

// A modal's, the command menu's and the search's (--shadow-modal): five in dark, the menus' in light.
pub(crate) fn modal_shadow(dark: bool) -> Vec<BoxShadow> {
    if dark { vec![shadow(40., 4., 0.1), shadow(20., 3., 0.125), shadow(12., 3., 0.125), shadow(8., 2., 0.125), shadow(1., 1., 0.125)] } else { pop_shadow(false) }
}

// The shortcuts panel's and Display options' (--shadow-keys).
pub(crate) fn keys_shadow(dark: bool) -> Vec<BoxShadow> {
    if dark { vec![shadow(8., 3., 0.125), shadow(5., 2., 0.125), shadow(1., 1., 0.125)] } else { pop_shadow(false) }
}

// What lifts a filled control off the page, under its ring (--shadow-panel).
pub(crate) fn panel_shadow(dark: bool) -> Vec<BoxShadow> {
    if dark { vec![spread_shadow(1., 0.5, 1., 0.3)] } else { vec![spread_shadow(6., 3., -2., 0.02), shadow(1., 1., 0.04)] }
}

// A ring, then what lifts the control.
pub(crate) fn ringed(colour: Hsla, dark: bool) -> Vec<BoxShadow> {
    let mut all = vec![ring(colour, 0.5)];
    all.extend(panel_shadow(dark));
    all
}

pub(crate) fn ring(colour: Hsla, width: f32) -> BoxShadow {
    BoxShadow { color: colour, offset: point(px(0.), px(0.)), blur_radius: px(0.), spread_radius: px(width), inset: false }
}


pub(crate) fn icon(icon: &Option<Icon>, size: f32, colour: Hsla, cx: &App) -> Option<AnyElement> {
    Some(match icon.as_ref()? {
        Icon::State(state) => theme::state_icon_sized(state, size, cx).into_any_element(),
        Icon::Priority(level) => crate::issue::priority_icon(level, cx).size(px(size)).into_any_element(),
        Icon::Project(status) => theme::project_icon(status, 0, cx).into_any_element(),
        Icon::Glyph(name) => theme::glyph(name, colour).size(px(size)).into_any_element(),
    })
}

fn plural(name: &str) -> String {
    match name { "status" => "statuses".into(), "priority" => "priorities".into(), "from" => "senders".into(), _ => format!("{name}s") }
}

// A view with Filter and Display options. Its owner says what the view holds and makes its changes; the menus, the
// chips and the panel are drawn here.
pub(crate) trait Filtering: Sized + 'static {
    fn popups(&mut self) -> &mut Popups;
    fn popped(&self) -> &Popups;
    fn anchors(&self) -> &Anchors;
    // where the keys go back to once a popup closes
    fn home(&self) -> FocusHandle;
    // Filter's properties, each with its values and how many rows have each
    fn fields(&self, cx: &App) -> Vec<Field>;
    // what a value's count counts: "notification", "issue"
    fn noun(&self) -> String;
    fn chips(&self, cx: &App) -> Vec<Chip>;
    // a property's filter: whether it is "is not", and its values, none when it has no filter
    fn filter(&self, name: &str) -> (bool, Vec<String>);
    // filters set, each by its property; None takes one out
    fn set_filters(&mut self, changes: Vec<(String, Option<(bool, Vec<String>)>)>, cx: &mut Context<Self>);
    fn panel(&self) -> Panel;
    // Display's choices set, each by its word; None drops it, as a switch turned off
    fn set_display(&mut self, changes: Vec<(String, Option<String>)>, cx: &mut Context<Self>);
    fn reset_display(&mut self, cx: &mut Context<Self>);

    fn toggle_value(&mut self, name: &str, value: &str, cx: &mut Context<Self>) {
        let (not, mut values) = self.filter(name);
        match values.iter().position(|v| v == value) {
            Some(at) => { values.remove(at); }
            None => values.push(value.into()),
        }
        self.set_filters(vec![(name.into(), (!values.is_empty()).then_some((not, values)))], cx);
    }

    fn clear_filters(&mut self, cx: &mut Context<Self>) {
        let all = self.chips(cx).into_iter().map(|c| (c.name, None)).collect();
        self.set_filters(all, cx);
    }

    // Filter's menu, or a property's values, under the control named.
    fn open_filter(&mut self, field: Option<String>, anchor: &str, window: &mut Window, cx: &mut Context<Self>) {
        let placeholder = match &field {
            Some(name) => format!("{}…", self.fields(cx).into_iter().find(|f| f.name == *name).map_or_else(|| name.clone(), |f| f.label)),
            None => "Add filter…".into(),
        };
        let query = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
        query.update(cx, |q, cx| q.focus(window, cx));
        let typed = cx.subscribe(&query, |this: &mut Self, _, event: &InputEvent, cx| {
            if let InputEvent::Change = event {
                if let Some(menu) = &mut this.popups().menu { menu.on = 0 }
                cx.notify();
            }
        });
        *self.popups() = Popups {
            menu: Some(FilterMenu { field, anchor: anchor.into(), query, on: 0, scroll: ScrollHandle::new() }),
            _typed: Some(typed),
            display: false,
            select: None,
        };
        cx.notify();
    }

    fn close_popups(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let had = self.popped().any();
        *self.popups() = Popups::default();
        if had { window.focus(&self.home(), cx) }
        cx.notify();
    }

    fn toggle_display(&mut self, cx: &mut Context<Self>) {
        let open = !self.popped().display;
        *self.popups() = Popups { display: open, ..Default::default() };
        cx.notify();
    }

    fn menu_items(&self, cx: &App) -> Vec<Item> {
        let Some(menu) = &self.popped().menu else { return Vec::new() };
        let typed = menu.query.read(cx).value().trim().to_lowercase();
        let fields = self.fields(cx);
        let picked: HashMap<String, Vec<String>> = fields.iter().map(|f| (f.name.clone(), self.filter(&f.name).1)).collect();
        let on = |name: &str, v: &str| picked.get(name).is_some_and(|p| p.iter().any(|x| x == v));
        match &menu.field {
            None => {
                let words: Vec<&str> = typed.split_whitespace().collect();
                let hit = |text: &str| { let text = text.to_lowercase(); words.iter().all(|w| text.contains(w)) };
                let mut items: Vec<Item> = fields.iter().filter(|f| hit(&f.label)).map(|f| Item {
                    group: 0, icon: f.icon.clone(), label: f.label.clone(), hint: None, checked: None, more: true, action: Action::Field(f.name.clone()),
                }).collect();
                if !words.is_empty() {
                    for f in &fields {
                        for v in f.values.iter().filter(|v| hit(&v.label)) {
                            items.push(Item { group: 1, icon: v.icon.clone(), label: v.label.clone(), hint: Some(f.label.clone()),
                                checked: Some(on(&f.name, &v.value)), more: false, action: Action::Toggle(f.name.clone(), v.value.clone()) });
                        }
                    }
                }
                items
            }
            Some(name) => {
                let noun = self.noun();
                fields.into_iter().filter(|f| f.name == *name).flat_map(|f| f.values).filter(|v| v.label.to_lowercase().contains(&typed)).map(|v| Item {
                    group: 0, icon: v.icon.clone(), hint: Some(format!("{} {noun}{}", v.count, if v.count == 1 { "" } else { "s" })),
                    checked: Some(on(name, &v.value)), more: false, label: v.label, action: Action::Toggle(name.clone(), v.value),
                }).collect()
            }
        }
    }

    // A row of the menu picked: a property opens its values where the menu was; a value goes in or out of the filter,
    // and the menu closes, unless it was its checkbox.
    fn run_item(&mut self, n: usize, keep_open: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(item) = self.menu_items(cx).into_iter().nth(n) else { return };
        match item.action {
            Action::Field(name) => {
                let anchor = self.popped().menu.as_ref().map(|m| m.anchor.clone()).unwrap_or_default();
                self.open_filter(Some(name), &anchor, window, cx);
            }
            Action::Toggle(name, value) => {
                self.toggle_value(&name, &value, cx);
                if !keep_open { self.close_popups(window, cx) }
            }
        }
    }

    fn move_on(&mut self, by: isize, cx: &mut Context<Self>) {
        let items = self.menu_items(cx);
        let Some(menu) = &mut self.popups().menu else { return };
        if items.is_empty() { return }
        menu.on = (menu.on as isize + by).rem_euclid(items.len() as isize) as usize;
        // its place among the list's children, which hold a divider between groups
        let dividers = items.iter().take(menu.on + 1).enumerate().filter(|(i, it)| *i > 0 && it.group != items[i - 1].group).count();
        menu.scroll.scroll_to_item(menu.on + dividers);
        cx.notify();
    }

    // The filters as chips: each "Property is Value ×", then +, and on a list Clear at the right end. In the Inbox they
    // sit in a box, as Linear's Inbox has them: 10px round them, the chips filled as buttons and ringed, 4px apart; on
    // a list, in a soft bar, the chips on the panel's fill with a hairline edge, 6px apart.
    fn filter_chips(&self, look: ChipsLook, cx: &mut Context<Self>) -> Option<Div> {
        let chips = self.chips(cx);
        if chips.is_empty() { return None }
        let c = colours(cx);
        let (fill, edge) = if look == ChipsLook::Inbox { (c.chip, c.ring) } else { (c.panel, c.edge_3) };
        let part = |id: SharedString| {
            div().id(id).h_flex().h_full().px(px(6.)).gap(px(4.)).border_l(px(0.5)).border_color(edge).text_color(c.text_2).cursor_pointer()
                .hover(|s| s.bg(c.hover).text_color(c.text_1))
        };
        let mut row = div().h_flex().flex_wrap().rounded(px(8.)).bg(c.box_fill).text_size(px(12.)).font_medium();
        row = match look {
            ChipsLook::Inbox => row.gap(px(4.)).p(px(10.)).border(px(0.5)).border_color(c.box_edge),
            ChipsLook::List => row.gap(px(6.)).min_h(px(36.)).py(px(6.)).px(px(8.)).mb(px(4.)),
        };
        for chip in chips {
            let n = chip.values.len();
            let mut icons: Vec<Icon> = Vec::new();
            for (_, _, i) in &chip.values { if let Some(i) = i { if !icons.contains(i) && icons.len() < 3 { icons.push(i.clone()) } } }
            let words = if n < 3 { chip.values.iter().map(|v| v.1.clone()).collect::<Vec<_>>().join(", ") } else { format!("{n} {}", plural(&chip.name)) };
            let op = if chip.not { "is not" } else if n > 1 { "is either of" } else { "is" };
            let (flip, pick, remove) = (chip.name.clone(), chip.name.clone(), chip.name.clone());
            let anchor = format!("chip-{}", chip.name);
            row = row.child(
                div().h_flex().h(px(24.)).rounded(px(6.)).border(px(0.5)).border_color(edge).bg(fill).overflow_hidden()
                    .child(div().h_flex().h_full().px(px(6.)).text_color(c.text_2).child(chip.label))
                    .child(part(format!("op-{}", chip.name).into()).text_color(c.text_3).font_weight(FontWeight(450.)).child(op)
                        .on_click(cx.listener(move |this: &mut Self, _, _, cx| {
                            let (not, values) = this.filter(&flip);
                            if !values.is_empty() { this.set_filters(vec![(flip.clone(), Some((!not, values)))], cx) }
                        }))
                        .tip(if chip.not { "Change to is" } else { "Change to is not" }))
                    .child(part(format!("values-{}", chip.name).into()).relative().max_w(px(240.))
                        .children(icons.iter().filter_map(|i| icon(&Some(i.clone()), 14., c.text_3, cx)))
                        .child(div().min_w_0().truncate().when(!icons.is_empty(), |w| w.ml(px(2.))).child(words))
                        .child(self.anchors().probe(anchor.clone()))
                        .on_click(cx.listener(move |this: &mut Self, _, window, cx| this.open_filter(Some(pick.clone()), &format!("chip-{pick}"), window, cx)))
                        .tip("Change the values"))
                    .child(part(format!("remove-{}", chip.name).into()).text_color(c.text_3).child(theme::glyph("close", c.text_3).size(px(12.)))
                        .on_click(cx.listener(move |this: &mut Self, _, _, cx| this.set_filters(vec![(remove.clone(), None)], cx)))
                        .tip("Remove filter")),
            );
        }
        let add = div().id("filter-add").relative().flex().items_center().justify_center().size(px(24.)).rounded(px(6.)).cursor_pointer()
            .hover(|s| s.bg(c.active))
            .child(theme::glyph("plus", c.text_3))
            .child(self.anchors().probe("filter-add"))
            .on_click(cx.listener(|this: &mut Self, _, window, cx| this.open_filter(None, "filter-add", window, cx)))
            .tip("Add filter  F");
        row = row.child(add);
        Some(match look {
            ChipsLook::Inbox => div().pl(px(8.)).pr(px(10.)).pb(px(8.)).child(row),
            ChipsLook::List => row.child(
                div().id("filter-clear").h_flex().h(px(24.)).px(px(8.)).ml_auto().rounded_full().text_color(c.text_2).cursor_pointer()
                    .hover(|s| s.bg(c.active).text_color(c.text_1))
                    .child("Clear")
                    .on_click(cx.listener(|this: &mut Self, _, _, cx| this.clear_filters(cx))),
            ),
        })
    }

    // What floats over the view: Filter's menu, Display options, and a select's options.
    fn filter_layers(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        [self.filter_popup(cx), self.display_popup(cx), self.options_popup(cx)].into_iter().flatten().collect()
    }

    // The open menu, under what opened it.
    fn filter_popup(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let menu = self.popped().menu.as_ref()?;
        let at = self.anchors().get(&menu.anchor).map(|b| point(b.left(), b.bottom() + px(4.))).unwrap_or(point(px(400.), px(48.)));
        let c = colours(cx);
        let items = self.menu_items(cx);
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
                    .on_click(cx.listener(move |this: &mut Self, _, window, cx| { cx.stop_propagation(); this.run_item(n, true, window, cx) }))
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
                    .on_hover(cx.listener(move |this: &mut Self, on: &bool, _, cx| {
                        if *on { if let Some(menu) = &mut this.popups().menu { if menu.on != n { menu.on = n; cx.notify() } } }
                    }))
                    .on_click(cx.listener(move |this: &mut Self, _, window, cx| this.run_item(n, false, window, cx))),
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
            .capture_action(cx.listener(|this: &mut Self, _: &MoveDown, _, cx| { cx.stop_propagation(); this.move_on(1, cx) }))
            .capture_action(cx.listener(|this: &mut Self, _: &MoveUp, _, cx| { cx.stop_propagation(); this.move_on(-1, cx) }))
            .capture_action(cx.listener(|this: &mut Self, _: &Enter, window, cx| {
                cx.stop_propagation();
                let on = this.popped().menu.as_ref().map(|m| m.on).unwrap_or(0);
                this.run_item(on, false, window, cx);
            }))
            .capture_action(cx.listener(|this: &mut Self, _: &Escape, window, cx| { cx.stop_propagation(); this.close_popups(window, cx) }))
            .on_mouse_down_out(cx.listener(move |this: &mut Self, e: &MouseDownEvent, window, cx| {
                if !this.anchors().within(&opener, e.position) { this.close_popups(window, cx) }
            }))
            .child(head)
            .child(list);
        Some(deferred(anchored().position(at).snap_to_window_with_margin(px(8.)).child(box_)).with_priority(2).into_any_element())
    }

    // Display options, Linear's panel: Layout's two buttons, Grouping and Ordering, the rest under a line, the switches,
    // and Reset at its foot.
    fn display_popup(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.popped().display { return None }
        let c = colours(cx);
        let anchor = self.anchors().get("display")?;
        let at = point((anchor.right() - px(PANEL_W)).max(px(8.)), anchor.bottom() + px(6.));
        let panel = self.panel();
        let line = || div().flex_none().h(px(0.)).my(px(8.)).mx(px(-16.)).border_t(px(0.5)).border_color(c.tip_edge);
        let mut body = div()
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
            .shadow(keys_shadow(c.dark))
            .text_size(px(12.))
            .font_medium()
            .text_color(c.tip_key)
            .on_mouse_down_out(cx.listener(|this: &mut Self, e: &MouseDownEvent, _, cx| {
                let options = this.popped().select.is_some() && this.anchors().within("dp-options", e.position);
                if !(this.anchors().within("display", e.position) || options) {
                    let p = this.popups();
                    p.display = false;
                    p.select = None;
                    cx.notify();
                }
            }));
        if let Some(layout) = &panel.layout { body = body.child(self.layout_row(layout, &c, cx)) }
        for s in &panel.first { body = body.child(self.select_row(s, panel.reverse, &c, cx)) }
        if !panel.rest.is_empty() || !panel.switches.is_empty() { body = body.child(line()) }
        for s in &panel.rest { body = body.child(self.select_row(s, None, &c, cx)) }
        for (n, (key, label, on)) in panel.switches.iter().enumerate() {
            let (key, on) = (key.clone(), *on);
            let switch = div().id(("dp-switch", n)).relative().w(px(22.)).h(px(14.)).rounded_full().cursor_pointer()
                .bg(if on { c.accent } else { c.active })
                .when(!on, |s| s.shadow(vec![BoxShadow { inset: true, ..ring(c.edge_3, 0.5) }]))
                .child(div().absolute().top(px(2.)).left(px(if on { 10. } else { 2. })).size(px(10.)).rounded_full().bg(if on { rgb(0xffffff).into() } else { c.text_3 }))
                .on_click(cx.listener(move |this: &mut Self, _, _, cx| this.set_display(vec![(key.clone(), (!on).then(|| "1".into()))], cx)));
            body = body.child(div().h_flex().h(px(32.)).gap(px(4.)).child(div().flex_1().child(label.clone())).child(switch));
        }
        let reset = div().id("dp-reset").h_flex().h(px(24.)).px(px(8.)).rounded_full().text_color(c.text_1).cursor_pointer()
            .hover(|s| s.bg(c.active))
            .child("Reset")
            .on_click(cx.listener(|this: &mut Self, _, _, cx| this.reset_display(cx)));
        body = body.child(div().h_flex().justify_end().mt(px(8.)).mx(px(-16.)).py(px(8.)).px(px(12.)).border_t(px(0.5)).border_color(c.tip_edge).child(reset));
        Some(deferred(anchored().position(at).snap_to_window_with_margin(px(8.)).child(body)).with_priority(1).into_any_element())
    }

    // Layout's buttons, List and Board, each its icon and name; the one picked filled brighter in a strong ring.
    fn layout_row(&self, layout: &Select, c: &Colours, cx: &mut Context<Self>) -> Div {
        let mut row = div().h_flex().gap(px(6.)).mt(px(8.)).mx(px(2.)).mb(px(18.));
        for (n, (value, label)) in layout.options.iter().enumerate() {
            let on = layout.current == *value;
            let group = SharedString::from(format!("dp-layout-{n}"));
            let (tip_text, hover, strong, dark) = (c.tip_text, c.layout_hover, c.select_ring_strong, c.dark);
            let (key, value) = (layout.key.clone(), value.clone());
            let colour = if on { c.select_on } else { c.tip_key };
            row = row.child(
                div().id(("dp-layout", n)).group(group.clone()).flex_1().h_flex().justify_center().gap(px(6.)).h(px(28.)).px(px(8.)).rounded_full()
                    .cursor_pointer().text_color(colour)
                    .when(on, |b| b.bg(c.layout_on).shadow(vec![ring(strong, 0.5)]))
                    .when(!on, |b| b.bg(c.select).shadow(ringed(c.select_ring, dark)).hover(move |s| s.bg(hover).shadow(ringed(strong, dark)).text_color(tip_text)))
                    .child(theme::glyph(&format!("layout-{value}"), colour).size(px(14.)).when(!on, |g| g.group_hover(group, move |s| s.text_color(tip_text))))
                    .child(label.clone())
                    .on_click(cx.listener(move |this: &mut Self, _, _, cx| this.set_display(vec![(key.clone(), Some(value.clone()))], cx)))
                    .tip(format!("{label}  Ctrl B")),
            );
        }
        row
    }

    // A choice's row: its label, then its select, which opens its options; Ordering's has its direction before it.
    fn select_row(&self, s: &Select, reverse: Option<bool>, c: &Colours, cx: &mut Context<Self>) -> Div {
        let current = s.options.iter().find(|(v, _)| *v == s.current).map_or_else(|| s.current.clone(), |(_, l)| l.clone());
        let (hover, strong, lit, dark) = (c.select_hover, c.select_ring_strong, c.select_on, c.dark);
        let id = SharedString::from(format!("dp-{}", s.key));
        let key = s.key.clone();
        let select = div().id(id.clone()).group(id.clone()).relative().h_flex().min_w(px(116.)).h(px(24.)).pl(px(8.)).pr(px(18.)).rounded(px(8.))
            .bg(c.select).shadow(ringed(c.select_ring, dark)).text_color(c.tip_text).font_weight(FontWeight::NORMAL).cursor_pointer()
            .hover(move |st| st.bg(hover).shadow(ringed(strong, dark)).text_color(lit))
            .child(current)
            .child(div().absolute().right(px(6.)).top(px(7.5))
                .child(theme::glyph("select-chevron", c.tip_text).size(px(9.)).group_hover(id.clone(), move |st| st.text_color(lit))))
            .child(self.anchors().probe(id.to_string()))
            .on_click(cx.listener(move |this: &mut Self, _, _, cx| {
                let p = this.popups();
                p.select = if p.select.as_deref() == Some(key.as_str()) { None } else { Some(key.clone()) };
                cx.notify();
            }));
        let direction = reverse.filter(|_| s.key == "order").map(|reversed| {
            let (active, text_1) = (c.active, c.text_1);
            div().id("dp-dir").group("dp-dir").flex().flex_none().items_center().justify_center().size(px(24.)).rounded_full().cursor_pointer()
                .hover(move |st| st.bg(active))
                .child(theme::glyph(if reversed { "direction-reversed" } else { "direction" }, c.text_3).group_hover("dp-dir", move |st| st.text_color(text_1)))
                .on_click(cx.listener(move |this: &mut Self, _, _, cx| this.set_display(vec![("reverse".into(), (!reversed).then(|| "1".into()))], cx)))
                .tip(if reversed { "Reversed" } else { "Reverse the order" })
        });
        div().h_flex().h(px(32.)).gap(px(4.)).child(div().flex_1().child(s.label.clone())).children(direction).child(select)
    }

    // A select's options, under it, each with a tick on the one picked.
    fn options_popup(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let key = self.popped().select.clone().filter(|_| self.popped().display)?;
        let panel = self.panel();
        let s = panel.layout.iter().chain(&panel.first).chain(&panel.rest).find(|s| s.key == key)?;
        let c = colours(cx);
        let anchor = format!("dp-{key}");
        let select = self.anchors().get(&anchor)?;
        let at = point(select.left(), select.bottom() + px(4.));
        let mut list = div().v_flex().py(px(4.)).px(px(4.));
        for (n, (value, label)) in s.options.iter().enumerate() {
            let current = s.current == *value;
            let (key, value) = (key.clone(), value.clone());
            list = list.child(
                div().id(("dp-option", n)).h_flex().h(px(32.)).px(px(8.)).gap(px(10.)).rounded(px(6.)).cursor_pointer().text_color(c.text_1)
                    .hover(|st| st.bg(c.pop_on))
                    .child(div().flex_1().child(label.clone()))
                    .when(current, |r| r.child(theme::glyph("tick", c.text_1).size(px(14.))))
                    .on_click(cx.listener(move |this: &mut Self, _, _, cx| {
                        this.popups().select = None;
                        this.set_display(vec![(key.clone(), Some(value.clone()))], cx);
                    })),
            );
        }
        let menu = div().id("dp-options").occlude().relative().w(px(OPTIONS_W)).rounded(px(8.)).border(px(0.5)).border_color(c.pop_edge).bg(c.pop)
            .shadow(pop_shadow(c.dark)).text_size(px(13.))
            .child(self.anchors().probe("dp-options"))
            .on_mouse_down_out(cx.listener(move |this: &mut Self, e: &MouseDownEvent, _, cx| {
                if !this.anchors().within(&anchor, e.position) { this.popups().select = None; cx.notify() }
            }))
            .child(list);
        Some(deferred(anchored().position(at).snap_to_window_with_margin(px(8.)).child(menu)).with_priority(3).into_any_element())
    }
}

impl Desk {
    pub(crate) fn store(&self) -> crate::listing::Store<'_> {
        crate::listing::Store { inbox: &self.inbox, issues: &self.all, teams: &self.teams, projects: &self.projects }
    }

    // A change to the Inbox's view, kept for the next run.
    pub(crate) fn set_view(&mut self, change: impl FnOnce(&mut crate::listing::View), cx: &mut Context<Self>) {
        change(&mut self.inbox_view);
        self.inbox_view.save();
        cx.notify();
    }

    // The Inbox's three controls at the list's right edge in the bar, as Linear's: Show unreads only, Filter and
    // Display options, 28px circles with no fill at rest, Display with a dot while the display differs from its default.
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
            if desk.inbox_popups.menu.as_ref().is_some_and(|m| m.anchor == "filter") { desk.close_popups(window, cx) } else { desk.open_filter(None, "filter", window, cx) }
        }));
        let display = tool("display", "display", false)
            .when(!self.inbox_view.is_default(), |b| b.child(div().absolute().top_0().right_0().size(px(7.)).rounded_full().bg(c.accent)))
            .on_click(cx.listener(|desk, _, _, cx| desk.toggle_display(cx)));
        div().h_flex().gap(px(6.)).child(unreads).child(filter).child(display)
    }
}

// The Inbox's view is worked out in the window from the rows desk pushes (listing.rs).
impl Filtering for Desk {
    fn popups(&mut self) -> &mut Popups {
        &mut self.inbox_popups
    }

    fn popped(&self) -> &Popups {
        &self.inbox_popups
    }

    fn anchors(&self) -> &Anchors {
        &self.anchors
    }

    fn home(&self) -> FocusHandle {
        self.inbox_focus.clone()
    }

    fn fields(&self, _: &App) -> Vec<Field> {
        self.store().fields(&self.inbox_view, self.open_row.as_deref())
    }

    fn noun(&self) -> String {
        "notification".into()
    }

    fn chips(&self, _: &App) -> Vec<Chip> {
        self.store().chips(&self.inbox_view)
    }

    fn filter(&self, name: &str) -> (bool, Vec<String>) {
        self.inbox_view.filter(name).map(|f| (f.not, f.values.clone())).unwrap_or_default()
    }

    fn set_filters(&mut self, changes: Vec<(String, Option<(bool, Vec<String>)>)>, cx: &mut Context<Self>) {
        self.set_view(|v| for (name, filter) in changes { v.set(name, filter) }, cx);
    }

    fn panel(&self) -> Panel {
        let order = Select {
            key: "order".into(),
            label: "Ordering".into(),
            options: ORDERS.iter().map(|(v, l)| (v.to_string(), l.to_string())).collect(),
            current: self.inbox_view.order.clone(),
        };
        Panel { first: vec![order], switches: vec![("first".into(), "Show unread first".into(), self.inbox_view.first)], ..Default::default() }
    }

    fn set_display(&mut self, changes: Vec<(String, Option<String>)>, cx: &mut Context<Self>) {
        self.set_view(|v| for (key, value) in changes {
            match key.as_str() {
                "order" => v.order = value.unwrap_or_else(|| "newest".into()),
                "first" => v.first = value.is_some(),
                _ => {}
            }
        }, cx);
    }

    fn reset_display(&mut self, cx: &mut Context<Self>) {
        self.set_view(|v| { v.order = "newest".into(); v.first = false; }, cx);
    }
}
