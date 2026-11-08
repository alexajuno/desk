// A row's menus, as the web's (issues/menus.tsx): S and P open the status and priority menus at the row in focus, and a
// right-click its actions: Status and Priority, Set parent…, Add sub-issue, Open chat, Copy link, Copy ID and Delete
// (Ctrl ⌫), whose toast has Undo. A card of the board is a row, and has the same. A status of Waiting then asks on
// whom, as the web's does.
use std::rc::Rc;

use gpui_kit::base::StyledExt;
use gpui_kit::component::menu::{PopupMenu, PopupMenuItem};
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::{json, Value};

use super::{IssueList, ListEvent};
use crate::issue::{priority_icon, priority_name, state_name, PRIORITIES, STATES};
use crate::picker::{Menu, Pick, Picker, PickerEvent, Source};
use crate::{net, theme, toast};

// A row of a menu: its icon, its words, its key at the right, and a chevron where it opens another menu.
fn row<I: IntoElement>(icon: impl Fn(&App) -> I + 'static, label: impl Into<SharedString>, key: Option<&'static str>, more: bool) -> PopupMenuItem {
    let label = label.into();
    PopupMenuItem::element(move |_, cx| {
        let muted = cx.theme().muted_foreground;
        div().h_flex().w_full().gap_2().child(div().flex().flex_none().w(px(16.)).justify_center().child(icon(cx))).child(div().flex_1().child(label.clone()))
            .when_some(key, |r, key| r.child(div().pl_4().text_xs().text_color(muted).child(key)))
            .when(more, |r| r.child(theme::glyph("chevron-right", muted).size(px(14.))))
    })
}

fn find(items: &[Value], slug: &str) -> Option<Value> {
    items.iter().find_map(|p| if p["slug"].as_str() == Some(slug) { Some(p.clone()) } else { find(p["kids"].as_array().map(Vec::as_slice).unwrap_or(&[]), slug) })
}

impl IssueList {
    // An issue on the list, as desk drew it.
    fn issue(&self, slug: &str) -> Option<Value> {
        self.groups().iter().find_map(|g| find(g["items"].as_array().map(Vec::as_slice).unwrap_or(&[]), slug))
    }

    // Where a row's menu opens for a key: under the row in focus, by its status.
    pub(super) fn under_row(&self, slug: &str) -> Point<Pixels> {
        self.anchors.get(&format!("row-{slug}")).map(|b| point(b.left() + px(16.), b.bottom() + px(2.))).unwrap_or(point(px(400.), px(200.)))
    }

    // The status's or priority's menu; not Triage, which only a chat files, nor Landing, which only Approve sets.
    pub(super) fn field_menu(&mut self, slug: String, field: &'static str, at: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(issue) = self.issue(&slug) else { return };
        let current = self.painted.get(&slug).filter(|(f, _)| f == field).map(|(_, v)| v.clone())
            .unwrap_or_else(|| issue[field].as_str().unwrap_or("").to_string());
        let this = cx.entity().downgrade();
        let menu = PopupMenu::build(window, cx, move |mut menu, _, _| {
            let values: &[&'static str] = if field == "state" { &STATES } else { &PRIORITIES };
            for value in values {
                let value: &'static str = value;
                let (this, slug, current) = (this.clone(), slug.clone(), current.clone());
                let item = if field == "state" {
                    row(move |cx| theme::state_icon(value, cx), state_name(value), None, false)
                } else {
                    row(move |cx| priority_icon(value, cx).size(px(14.)), priority_name(value), None, false)
                };
                menu = menu.item(item.checked(value == current).on_click(move |_, window, cx| {
                    if value == current { return }
                    let _ = this.update(cx, |list, cx| {
                        list.set_field(&slug, field, value.into(), cx);
                        if value == "waiting" { list.ask_waiting(&slug, at, window, cx) }
                    });
                }));
            }
            menu
        });
        self.show_menu(menu, at, window, cx);
    }

    // The actions on one issue, where it was right-clicked.
    pub(super) fn actions_menu(&mut self, slug: String, at: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(issue) = self.issue(&slug) else { return };
        let text = |k: &str| issue[k].as_str().unwrap_or("").to_string();
        let (state, priority, title, parent) = (text("state"), text("priority"), text("title"), text("parent"));
        let session = issue["session"].is_string();
        let this = cx.entity().downgrade();
        let menu = PopupMenu::build(window, cx, move |menu, _, _| {
            let act = |run: Rc<dyn Fn(&mut IssueList, &mut Window, &mut Context<IssueList>)>| {
                let this = this.clone();
                move |_: &ClickEvent, window: &mut Window, cx: &mut App| { let _ = this.update(cx, |list, cx| run(list, window, cx)); }
            };
            let (s1, s2, s3, s4, s5, s6, s7) = (slug.clone(), slug.clone(), slug.clone(), slug.clone(), slug.clone(), slug.clone(), slug.clone());
            let (st, pr, pa, ti) = (state.clone(), priority.clone(), parent.clone(), title.clone());
            menu.item(row(move |cx| theme::state_icon(&st, cx), "Status", Some("S"), true)
                    .on_click(act(Rc::new(move |list, window, cx| list.field_menu(s1.clone(), "state", at, window, cx)))))
                .item(row(move |cx| priority_icon(&pr, cx).size(px(14.)), "Priority", Some("P"), true)
                    .on_click(act(Rc::new(move |list, window, cx| list.field_menu(s2.clone(), "priority", at, window, cx)))))
                .item(row(|cx| theme::glyph("parent", cx.theme().muted_foreground), "Set parent…", None, true)
                    .on_click(act(Rc::new(move |list, window, cx| list.parent_picker(s3.clone(), pa.clone(), at, window, cx)))))
                .item(row(|cx| theme::glyph("plus", cx.theme().muted_foreground), "Add sub-issue", None, false)
                    .on_click(act(Rc::new(move |_, _, cx| cx.emit(ListEvent::New(json!({"parent": s4.clone(), "parentTitle": ti.clone()})))))))
                .separator()
                .when(session, |menu| menu.item(row(|cx| theme::glyph("chat", cx.theme().muted_foreground), "Open chat", Some("I"), false)
                    .on_click(act(Rc::new(move |_, _, cx| cx.emit(ListEvent::Open(s5.clone())))))))
                .item(row(|cx| theme::glyph("link", cx.theme().muted_foreground), "Copy link", None, false)
                    .on_click(act(Rc::new(move |_, _, cx| copy(format!("http://{}/issue/{}", net::host(), s6), "Link copied", cx)))))
                .item(row(|cx| theme::glyph("id", cx.theme().muted_foreground), "Copy ID", None, false)
                    .on_click(act(Rc::new({ let s = slug.clone(); move |_, _, cx| copy(s.clone(), "ID copied", cx) }))))
                .separator()
                .item(row(|cx| theme::glyph("trash", cx.theme().muted_foreground), "Delete", Some("Ctrl ⌫"), false)
                    .on_click(act(Rc::new(move |list, _, cx| list.delete(&s7, cx)))))
        });
        self.show_menu(menu, at, window, cx);
    }

    fn show_menu(&mut self, menu: Entity<PopupMenu>, at: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        menu.focus_handle(cx).focus(window, cx);
        // a menu that opens another, as Status does, is dismissed after the new one is up: only its own goes
        let gone = cx.subscribe_in(&menu, window, |list, menu, _: &DismissEvent, window, cx| {
            if list.menu.as_ref().is_some_and(|(open, _, _)| open == menu) {
                list.menu = None;
                if list.asking.is_none() { window.focus(&list.focus, cx) }
                cx.notify();
            }
        });
        self.menu = Some((menu, at, gone));
        cx.notify();
    }

    pub(super) fn menu_layer(&self) -> Option<AnyElement> {
        let (menu, at, _) = self.menu.as_ref()?;
        Some(deferred(anchored().position(*at).snap_to_window_with_margin(px(8.)).child(menu.clone())).with_priority(2).into_any_element())
    }

    // Set parent…: the open issues desk offers, without this one and its own sub-issues, No parent first.
    fn parent_picker(&mut self, slug: String, parent: String, at: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let path = format!("/api/parents?exclude={}", crate::picker::encode(&slug));
        cx.spawn_in(window, async move |this, cx| {
            let found = cx.background_spawn(async move { net::get(&path) }).await;
            let _ = this.update_in(cx, |list, window, cx| {
                let found = match found { Ok(v) => v, Err(e) => return toast::say(e, cx) };
                let mut picks = vec![Pick { icon: "none", label: "No parent".into(), value: String::new(), current: parent.is_empty() }];
                for i in found.as_array().into_iter().flatten() {
                    let value = i["slug"].as_str().unwrap_or("").to_string();
                    picks.push(Pick { icon: theme::state_glyph(i["state"].as_str().unwrap_or("")), label: i["title"].as_str().unwrap_or("").into(), current: value == parent, value });
                }
                let menu = Menu { source: Source::Fixed(picks), placeholder: "Set parent…", empty: "No open issue matches", width: 340., takes_typed: false, start: String::new() };
                let picker = cx.new(|cx| Picker::new(menu, Bounds::new(at, size(px(0.), px(0.))), window, cx));
                let events = cx.subscribe_in(&picker, window, move |list, _, event: &PickerEvent, window, cx| {
                    if let PickerEvent::Picked(to) = event {
                        if *to != parent { list.set_field(&slug, "parent", to.clone(), cx) }
                    }
                    list.asking = None;
                    window.focus(&list.focus, cx);
                    cx.notify();
                });
                list.asking = Some((picker, at, events));
                cx.notify();
            });
        })
        .detach();
    }

    // Delete, sub-issues and all, to the trash, with Undo in its toast.
    pub(super) fn delete(&mut self, slug: &str, cx: &mut Context<Self>) {
        let (slug, path) = (slug.to_string(), format!("/issue/{slug}/delete"));
        cx.spawn(async move |this, cx| {
            let answer = cx.background_spawn(async move { net::post(&path, json!({})) }).await;
            let _ = this.update(cx, |list, cx| {
                match answer {
                    Err(e) => toast::say(e, cx),
                    Ok(answer) => {
                        let deleted: Vec<String> = answer["deleted"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).collect();
                        if list.focused.as_ref().is_some_and(|f| deleted.contains(f)) { list.focused = None }
                        let kids = deleted.len().saturating_sub(1);
                        let words = if kids > 0 { format!("Issue and {kids} sub-issue{} deleted", if kids > 1 { "s" } else { "" }) } else { "Issue deleted".into() };
                        let back = cx.entity().downgrade();
                        let undo: toast::Run = Rc::new(move |_, cx| {
                            let (path, back) = (format!("/trash/{slug}/restore"), back.clone());
                            cx.spawn(async move |cx| {
                                let done = cx.background_spawn(async move { net::post(&path, json!({})) }).await;
                                cx.update(|cx| {
                                    match done { Ok(_) => toast::say("Issue restored", cx), Err(e) => toast::say(e, cx) }
                                    let _ = back.update(cx, |list, cx| list.ask(cx));
                                });
                            })
                            .detach();
                        });
                        toast::show(words, Some(("Undo", undo)), cx);
                    }
                }
                list.ask(cx);
            });
        })
        .detach();
    }
}

fn copy(text: String, done: &'static str, cx: &mut App) {
    cx.write_to_clipboard(ClipboardItem::new_string(text));
    toast::say(done, cx);
}
