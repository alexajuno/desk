// The Board layout, as the web's (lists/Board.tsx), which copies Linear's (linear.app/docs/board-layout): a column per
// group, each issue a card. A card dragged to another column sets what the board is grouped by, as Linear's does: its
// status, priority, team, project or folder. Landing takes no drop, since only Approve lands an issue, nor Triage, which
// only a chat files, and a column that takes none says why while a card is dragged; a drop on Waiting asks on whom, as
// the S menu does. A card is a row as well: the mouse, or J and K, puts it in focus, and Enter opens it.
use std::collections::HashMap;

use gpui_kit::base::StyledExt;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::{json, Value};

use super::{icon_of, IssueList, ListEvent};
use crate::filters::{colours, pop_shadow, ringed, Colours};
use crate::picker::{Menu, Picker, PickerEvent, Source};
use crate::tip::Tipped;
use crate::{net, theme, toast};

const COLUMN_W: f32 = 320.;
const CARD_W: f32 = COLUMN_W - 10.; // the column's 1px edge and its cards' 4px each side

// A card on its way to another column: the issue, and the column it left. Under the mouse it is drawn as the card.
#[derive(Clone)]
pub(crate) struct DraggedCard {
    slug: String,
    title: String,
    state: String,
    priority: String,
    from: String,
}

impl Render for DraggedCard {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = colours(cx);
        div()
            .w(px(CARD_W))
            .v_flex()
            .gap(px(8.))
            .py(px(10.))
            .px(px(12.))
            .rounded(px(8.))
            .bg(c.hover)
            .shadow(pop_shadow(c.dark))
            .opacity(0.9)
            .text_color(c.text_1)
            .child(top(&self.state, &self.title, cx))
            .child(div().h_flex().child(crate::issue::priority_icon(&self.priority, cx).size(px(16.))))
    }
}

// A card's status and its title, on up to two lines.
fn top(state: &str, title: &str, cx: &App) -> Div {
    div()
        .flex()
        .items_start()
        .gap(px(8.))
        .min_w_0()
        .child(div().flex_none().mt(px(1.)).child(theme::state_icon(state, cx)))
        .child(div().min_w_0().text_size(px(13.)).line_height(px(18.)).font_medium().line_clamp(2).child(title.to_string()))
}

// What a drop on a column sets, or why it can't.
enum Drop {
    Set(&'static str, String),
    Folder(String),
}

fn drop_of(group: &str, value: &str) -> Result<Drop, &'static str> {
    let none_is_empty = |v: &str| if v == "none" { String::new() } else { v.to_string() };
    match group {
        "status" if value == "landing" => Err("Only Approve lands an issue."),
        "status" if value == "triage" => Err("Only a chat files an issue in Triage."),
        "status" => Ok(Drop::Set("state", value.into())),
        "priority" => Ok(Drop::Set("priority", value.into())),
        "team" => Ok(Drop::Set("team", none_is_empty(value))),
        "project" => Ok(Drop::Set("project", none_is_empty(value))),
        // a folder group's name back to its path: the repos under ~/projects go by their path there
        "folder" => Ok(Drop::Folder(match value {
            "none" => String::new(),
            v if v.starts_with('~') || v.starts_with('/') => v.into(),
            v => format!("~/projects/{v}"),
        })),
        _ => Err("Group the board to move cards between columns."),
    }
}

// Every issue of a group, each a card: a list's nesting undone, and a parent shown only for its sub-issues left out.
pub(super) fn cards_of(items: &[Value], out: &mut Vec<Value>) {
    for p in items {
        if p["context"] != true { out.push(p.clone()) }
        cards_of(p["kids"].as_array().map(Vec::as_slice).unwrap_or(&[]), out);
    }
}

impl IssueList {
    pub(super) fn is_board(&self) -> bool {
        self.view()["layout"] == "board"
    }

    // The board's columns, each with its cards, a card just dropped already in the column it went to.
    pub(super) fn columns(&self) -> Vec<(Value, Vec<Value>)> {
        let group = self.view()["group"].as_str().unwrap_or("").to_string();
        let field = match group.as_str() { "status" => "state", "priority" => "priority", _ => "" };
        let mut columns: Vec<(Value, Vec<Value>)> = self.groups().into_iter().map(|g| {
            let mut cards = Vec::new();
            cards_of(g["items"].as_array().map(Vec::as_slice).unwrap_or(&[]), &mut cards);
            (g, cards)
        }).collect();
        let moved: HashMap<String, String> =
            self.painted.iter().filter(|(_, (f, _))| f == field).map(|(slug, (_, v))| (slug.clone(), v.clone())).collect();
        if moved.is_empty() { return columns }
        let mut going = Vec::new();
        for (g, cards) in &mut columns {
            let here = g["value"].as_str().unwrap_or("").to_string();
            cards.retain(|p| match moved.get(p["slug"].as_str().unwrap_or("")) {
                Some(to) if *to != here => { going.push((to.clone(), p.clone())); false }
                _ => true,
            });
        }
        for (to, card) in going {
            if let Some((_, cards)) = columns.iter_mut().find(|(g, _)| g["value"] == to.as_str()) { cards.push(card) }
        }
        columns
    }

    pub(super) fn board(&self, data: &Value, c: &Colours, cx: &mut Context<Self>) -> AnyElement {
        let columns = self.columns();
        if columns.is_empty() {
            let hidden = data["hidden"].as_u64().unwrap_or(0);
            let empty = if hidden > 0 { format!("{hidden} issue{} hidden by filters", if hidden == 1 { "" } else { "s" }) } else { self.empty_text().into() };
            return div().p(px(16.)).text_color(c.text_3).child(empty).into_any_element();
        }
        let grouped = data["grouped"] == true;
        let group = self.view()["group"].as_str().unwrap_or("").to_string();
        div()
            .id("board")
            .flex_1()
            .min_h_0()
            .flex()
            .flex_row()
            .gap(px(8.))
            .overflow_x_scroll()
            .pt(px(4.))
            .px(px(4.))
            .pb(px(16.))
            .capture_any_mouse_up(cx.listener(|list, _, _, cx| if list.dragging.take().is_some() { cx.notify() }))
            .children(columns.into_iter().enumerate().map(|(n, (g, cards))| self.column(n, &g, cards, grouped, &group, c, cx)))
            .into_any_element()
    }

    fn column(&self, n: usize, g: &Value, cards: Vec<Value>, grouped: bool, group: &str, c: &Colours, cx: &mut Context<Self>) -> Stateful<Div> {
        let value = g["value"].as_str().unwrap_or("").to_string();
        let drop = drop_of(group, &value);
        let dragging = self.dragging.as_ref();
        let home = dragging.is_some_and(|d| d.from == value);
        let refuse = dragging.filter(|_| !home).and_then(|_| drop.as_ref().err().copied());
        let takes = drop.is_ok();
        let (raised, edge) = (c.box_fill, c.edge_3);
        let column_value = value.clone();
        let preset = g["preset"].clone();
        let (active, text_1) = (c.active, c.text_1);
        let add = preset.is_object().then(|| {
            div().id(("column-add", n)).flex().flex_none().items_center().justify_center().size(px(24.)).ml_auto().rounded(px(6.)).cursor_pointer()
                .hover(move |s| s.bg(active).text_color(text_1))
                .child(theme::glyph("plus", c.text_3))
                .on_click(cx.listener(move |_, _, _, cx| cx.emit(ListEvent::New(preset.clone()))))
                .tip("New issue")
        });
        let head = div().h_flex().flex_none().h(px(36.)).px(px(8.)).gap(px(8.)).text_size(px(12.)).font_medium().text_color(c.text_1)
            .children(icon_of(g["icon"].as_str(), c, cx))
            .child(if grouped { g["label"].as_str().unwrap_or("").to_string() } else { "All issues".into() })
            .child(div().text_color(c.text_3).font_weight(FontWeight(450.)).child(g["count"].as_u64().unwrap_or(0).to_string()))
            .children(add);
        let note = refuse.map(|why| {
            div().mx(px(8.)).mb(px(8.)).py(px(8.)).px(px(10.)).border_1().border_dashed().border_color(c.edge_3).rounded(px(8.))
                .text_size(px(12.)).text_color(c.text_3).child(why)
        });
        let list = div().id(("cards", n)).flex_1().min_h(px(40.)).v_flex().gap(px(6.)).overflow_y_scroll().pt(px(2.)).px(px(4.)).pb(px(8.))
            .children(cards.iter().map(|p| self.card(p, &value, c, cx)));
        div()
            .id(("column", n))
            .v_flex()
            .flex_none()
            .w(px(COLUMN_W))
            .min_h_0()
            .rounded(px(10.))
            .border_1()
            .border_color(transparent_black())
            .when(refuse.is_some(), |col| col.opacity(0.55))
            .when(takes, |col| {
                col.drag_over::<DraggedCard>(move |style, card, _, _| if card.from != column_value { style.bg(raised).border_color(edge) } else { style })
                    .on_drop(cx.listener(move |list, card: &DraggedCard, window, cx| list.drop_card(card, &value, window, cx)))
            })
            .child(head)
            .children(note)
            .child(list)
    }

    // An issue's card: its status and title, then its priority, who it waits on and since when, its folder, how many of
    // its sub-issues are done, and the day it was made.
    fn card(&self, p: &Value, column: &str, c: &Colours, cx: &mut Context<Self>) -> Stateful<Div> {
        let slug = p["slug"].as_str().unwrap_or("").to_string();
        let painted = |field: &str| self.painted.get(&slug).filter(|(f, _)| f == field).map(|(_, v)| v.clone());
        let state = painted("state").unwrap_or_else(|| p["state"].as_str().unwrap_or("backlog").to_string());
        let priority = painted("priority").unwrap_or_else(|| p["priority"].as_str().unwrap_or("none").to_string());
        let title = p["title"].as_str().unwrap_or("").to_string();
        let focused = self.focused.as_deref() == Some(slug.as_str());
        let chip = |text: String| {
            div().flex_shrink(1.).min_w_0().h(px(20.)).px(px(7.)).rounded_full().border(px(0.5)).border_color(c.edge_3).text_size(px(11.5))
                .line_height(px(19.)).text_color(c.text_2).truncate().child(text)
        };
        let waiting = (state == "waiting").then(|| {
            chip(format!("{} · {}", p["waiting_on"].as_str().filter(|w| !w.is_empty()).unwrap_or("Waiting"), p["waited"].as_str().unwrap_or("")))
        });
        let folder = p["folder"].as_str().map(|f| {
            let f = f.trim_end_matches('/');
            let f = f.strip_prefix("~/projects/").unwrap_or(f);
            match f.strip_prefix("/home/").and_then(|rest| rest.split_once("/projects/")) { Some((_, rest)) => rest.to_string(), None => f.to_string() }
        }).filter(|f| !f.is_empty()).map(chip);
        let subs = p["subs"].as_array().filter(|s| s.len() == 2).map(|s| chip(format!("{}/{}", s[0].as_u64().unwrap_or(0), s[1].as_u64().unwrap_or(0))));
        let dragged = DraggedCard { slug: slug.clone(), title: title.clone(), state: state.clone(), priority: priority.clone(), from: column.into() };
        let this = cx.entity().downgrade();
        let (hover, open_slug, menu_slug) = (c.hover, slug.clone(), slug.clone());
        div()
            .id(SharedString::from(format!("card-{slug}")))
            .relative()
            .v_flex()
            .flex_none()
            .gap(px(8.))
            .py(px(10.))
            .px(px(12.))
            .rounded(px(8.))
            .bg(if focused { c.hover } else { c.card })
            .shadow(ringed(c.card_ring, c.dark))
            .text_color(c.text_1)
            .hover(move |s| s.bg(hover))
            .child(top(&state, &title, cx))
            .child(
                div().h_flex().gap(px(6.)).min_w_0()
                    .child(crate::issue::priority_icon(&priority, cx).size(px(16.)))
                    .children(waiting)
                    .children(folder)
                    .children(subs)
                    .child(div().flex_1())
                    .child(div().flex_none().text_size(px(12.)).text_color(c.text_3).child(p["created_short"].as_str().unwrap_or("").to_string())),
            )
            .on_mouse_move(cx.listener(move |list, _, _, cx| {
                if list.focused.as_deref() != Some(slug.as_str()) { list.focused = Some(slug.clone()); cx.notify() }
            }))
            .child(self.anchors.probe(format!("row-{menu_slug}")))
            .on_click(cx.listener(move |_, _, _, cx| cx.emit(ListEvent::Open(open_slug.clone()))))
            .on_mouse_down(MouseButton::Right, cx.listener(move |list, e: &MouseDownEvent, window, cx| {
                // the list's own focus on a press would take the keys from the menu
                cx.stop_propagation();
                window.prevent_default();
                list.focused = Some(menu_slug.clone());
                list.actions_menu(menu_slug.clone(), e.position, window, cx);
            }))
            .on_drag(dragged, move |card, _, _, cx| {
                let _ = this.update(cx, |list, cx| { list.dragging = Some(card.clone()); cx.notify() });
                cx.new(|_| card.clone())
            })
    }

    // A card dropped on a column: what the board is grouped by takes the column's value; Waiting then asks on whom.
    fn drop_card(&mut self, card: &DraggedCard, value: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.dragging = None;
        cx.notify();
        if card.from == value { return }
        let group = self.view()["group"].as_str().unwrap_or("").to_string();
        match drop_of(&group, value) {
            Ok(Drop::Set(field, to)) => {
                self.set_field(&card.slug, field, to, cx);
                if field == "state" && value == "waiting" { self.ask_waiting(&card.slug, window.mouse_position(), window, cx) }
            }
            Ok(Drop::Folder(path)) => {
                let url = format!("/issue/{}/folder", card.slug);
                cx.spawn(async move |this, cx| {
                    let done = cx.background_spawn(async move { net::act(&url, json!({"folder": path})) }).await;
                    let _ = this.update(cx, |list, cx| {
                        if let Err(e) = done { toast::say(e, cx) }
                        list.ask(cx);
                    });
                })
                .detach();
            }
            Err(why) => toast::say(why, cx),
        }
    }

    // A field of an issue set: its status or priority shows at once, and the list is drawn again once desk has it.
    pub(super) fn set_field(&mut self, slug: &str, field: &'static str, value: String, cx: &mut Context<Self>) {
        if field == "state" || field == "priority" { self.painted.insert(slug.into(), (field.into(), value.clone())); }
        let (slug, path) = (slug.to_string(), format!("/issue/{slug}/set"));
        cx.spawn(async move |this, cx| {
            let done = cx.background_spawn(async move { net::post(&path, json!({"field": field, "value": value})) }).await;
            let _ = this.update(cx, |list, cx| {
                match done {
                    Ok(answer) => {
                        if let Some(n) = answer["closed"].as_array().map(Vec::len).filter(|n| *n > 0) {
                            toast::say(format!("Auto-closed {n} more issue{}", if n > 1 { "s" } else { "" }), cx);
                        }
                    }
                    Err(e) => {
                        list.painted.remove(&slug);
                        toast::say(e, cx);
                    }
                }
                list.ask(cx);
            });
        })
        .detach();
    }

    // Waiting on whom, for what: typed where the card was dropped, as the S menu asks it.
    pub(super) fn ask_waiting(&mut self, slug: &str, at: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let menu = Menu { source: Source::Fixed(Vec::new()), placeholder: "Waiting on whom, for what…", empty: "Enter saves it, such as QA on #570", width: 360., takes_typed: true, start: String::new() };
        let picker = cx.new(|cx| Picker::new(menu, Bounds::new(at, size(px(0.), px(0.))), window, cx));
        let slug = slug.to_string();
        let events = cx.subscribe_in(&picker, window, move |list, _, event: &PickerEvent, window, cx| {
            if let PickerEvent::Picked(on) | PickerEvent::Typed(on) = event {
                let on = on.trim().to_string();
                if !on.is_empty() { list.set_field(&slug, "waiting_on", on, cx) }
            }
            list.asking = None;
            window.focus(&list.focus, cx);
            cx.notify();
        });
        self.asking = Some((picker, at, events));
    }

    // The question on whom, where it was asked.
    pub(super) fn asking_layer(&self) -> Option<AnyElement> {
        let (picker, at, _) = self.asking.as_ref()?;
        Some(deferred(anchored().position(*at).snap_to_window_with_margin(px(8.)).child(picker.clone())).with_priority(2).into_any_element())
    }
}
