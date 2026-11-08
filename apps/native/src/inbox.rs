// The Inbox, as the web app's (inbox/InboxPage.tsx), which copies Linear's: the notifications on the left, newest first,
// and the one picked open on the right. Each row is one of the Inbox's rows desk pushes over the sync socket (the
// server's inbox.ts): a session that did something for you, read or not, until you delete it; a chat with no issue; or
// a Slack or mail thread the firewall let through. Opening a row reads it, and anything new on it while it is open.
// An issue's row shows its status where Linear draws who acted, with a badge for what it asks of you, then a dot while
// unread, its title, what the session did and how long ago.
//
// J, K, ↑ and ↓ move through the rows and open each, as Linear's; U marks the row under the mouse, else the open one,
// read or unread; Backspace deletes it; Alt U marks all read and Shift Backspace deletes all read, as the ⋯ menu does.
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use gpui_kit::base::StyledExt;
use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::menu::{DropdownMenu, PopupMenuItem};
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::json;

use crate::chat::Chat;
use crate::issue::{IssueEvent, IssuePage};
use crate::sync::InboxRow;
use crate::{net, theme, Desk};

const LIST: f32 = 400.; // the list's widest; half the page when that is less
const ROW: f32 = 54.;
const DEADLINE: [&str; 2] = ["due soon", "overdue"];

// When a row's event happened, as Linear's Inbox writes it: now, 5m, 13h, 3d, 2w.
fn ago(at: f64) -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(at);
    let seconds = now - at;
    for (size, unit) in [(604800., "w"), (86400., "d"), (3600., "h"), (60., "m")] {
        if seconds >= size { return format!("{}{unit}", (seconds / size).floor()) }
    }
    "now".into()
}

fn initial(who: Option<&str>) -> String {
    who.unwrap_or("?").trim().chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_else(|| "?".into())
}

// A thread no chat follows yet opens its messages, not a chat.
fn is_thread(r: &InboxRow) -> bool {
    r.source.is_some() && r.session.is_none()
}

impl Desk {
    // The rows the list shows, in its order: every row but the deleted ones, save the one open, newest first; with Show
    // unreads only, the unread ones, the one open and those read in this visit, so that reading never moves the list.
    pub(crate) fn inbox_rows(&self) -> Vec<InboxRow> {
        let open = self.open_row.as_deref();
        let mut rows: Vec<InboxRow> = self.inbox.values().filter(|r| !r.gone || Some(r.slug.as_str()) == open).cloned().collect();
        rows.sort_by(|a, b| b.at.total_cmp(&a.at));
        if self.unreads_only {
            rows.retain(|r| !r.read || self.stay.contains(&r.id) || Some(r.slug.as_str()) == open);
        }
        // a row seen unread while Show unreads only is on stays listed once read
        rows
    }

    pub(crate) fn unread(&self) -> usize {
        self.inbox.values().filter(|r| !r.read).count()
    }

    // What changed in the Inbox: the open row's news is read as it comes.
    pub(crate) fn inbox_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(row) = self.pending_row.take() {
            if self.inbox.values().any(|r| r.slug == row) { self.open_row(Some(row), window, cx) } else { self.pending_row = Some(row) }
        }
        if self.unreads_only {
            let unread: Vec<String> = self.inbox.values().filter(|r| !r.read).map(|r| r.id.clone()).collect();
            self.stay.extend(unread);
        }
        self.read_open(cx);
    }

    // Opening a row reads it, and anything new on it while it is open, as the server's inbox.ts reads a slug's rows.
    fn read_open(&mut self, cx: &mut Context<Self>) {
        if !self.in_inbox() { return }
        let Some(open) = self.open_row.clone() else { return };
        let keys: Vec<String> = self.inbox.values().filter(|r| r.slug == open && !r.read && !self.reading.contains(&r.id)).map(|r| r.id.clone()).collect();
        if keys.is_empty() { return }
        self.reading.extend(keys.iter().cloned());
        self.inbox_call("/api/inbox/read", json!({"keys": keys}), cx);
    }

    // A change to the Inbox's rows, which desk then pushes back as any write.
    fn inbox_call(&mut self, path: &'static str, body: serde_json::Value, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let done = cx.background_spawn(async move { net::post(path, body) }).await;
            let _ = this.update(cx, |desk, cx| {
                desk.notice = done.err().map(|e| (e, true));
                desk.reading.clear();
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn in_inbox(&self) -> bool {
        self.page == crate::Page::Inbox
    }

    pub(crate) fn show_inbox(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.page = crate::Page::Inbox;
        self.stay.clear();
        self.tell_shown(cx);
        window.focus(&self.inbox_focus, cx);
        self.read_open(cx);
        cx.notify();
    }

    // A row opened on the right, as the web's Inbox opens it: an issue's row its page; a chat's row, or an issue's row
    // carrying a thread's news, its chat; a thread no chat follows yet its messages.
    pub(crate) fn open_row(&mut self, slug: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        if self.open_row == slug { return }
        self.open_row = slug.clone();
        self.inbox_chat = None;
        self.inbox_issue = None;
        self._inbox_issue_events = None;
        if let Some(row) = slug.as_ref().and_then(|s| self.inbox.values().find(|r| &r.slug == s)).cloned() {
            match (&row.session, row.issue && row.source.is_none()) {
                _ if is_thread(&row) => {}
                (_, true) => {
                    let page = cx.new(|cx| IssuePage::new(row.slug.clone(), cx));
                    self._inbox_issue_events = Some(cx.subscribe_in(&page, window, |desk, _, event, window, cx| match event {
                        IssueEvent::Open(slug) => {
                            let issue = desk.all.get(slug).cloned().unwrap_or_else(|| crate::Issue { slug: slug.clone(), ..Default::default() });
                            desk.open(&issue, window, cx);
                        }
                        IssueEvent::Onward { next, note } => {
                            desk.open_row(next.clone(), window, cx);
                            desk.notice = Some((note.clone(), false));
                        }
                    }));
                    self.inbox_issue = Some(page);
                }
                (Some(session), false) => self.inbox_chat = Some(cx.new(|cx| Chat::of_session(session.clone(), window, cx))),
                (None, false) => self.inbox_chat = Some(cx.new(|cx| Chat::new(row.slug.clone(), window, cx))),
            }
        }
        self.notice = None;
        self.tell_shown(cx);
        window.focus(&self.inbox_focus, cx); // the list keeps its keys; a click in the chat goes to the chat
        self.read_open(cx);
        cx.notify();
    }

    // The row U and Backspace act on: the one under the mouse, else the one open.
    fn row_now(&self) -> Option<InboxRow> {
        let slug = self.hovered_row.clone().or_else(|| self.open_row.clone())?;
        self.inbox_rows().into_iter().find(|r| r.slug == slug)
    }

    fn toggle_read(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(row) = self.row_now() else { return };
        let unread = row.read;
        // the open row closes as it turns unread, or opening it would read it again at once
        if unread && self.open_row.as_deref() == Some(&row.slug) { self.open_row(None, window, cx) }
        self.inbox_call("/api/inbox/read", json!({"keys": [row.id], "unread": unread}), cx);
    }

    // The row deleted; the open one gives way to the next, the one below it, else the one above, as Linear's. A row
    // that waits on you stays until you answer it.
    fn delete_row(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(row) = self.row_now() else { return };
        if row.waits {
            self.notice = Some(("It waits on you: answer it, and it leaves the Inbox.".into(), false));
            return cx.notify();
        }
        if self.open_row.as_deref() == Some(&row.slug) {
            let rows = self.inbox_rows();
            let at = rows.iter().position(|r| r.slug == row.slug).unwrap_or(0);
            let next = rows.get(at + 1).or_else(|| at.checked_sub(1).and_then(|a| rows.get(a))).map(|r| r.slug.clone());
            self.open_row(next, window, cx);
        }
        self.hovered_row = None;
        self.inbox_call("/api/inbox/delete", json!({"keys": [row.id]}), cx);
    }

    fn delete_all(&mut self, only_read: bool, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(open) = self.open_row.clone().and_then(|s| self.inbox.values().find(|r| r.slug == s).cloned()) {
            if !open.waits && (!only_read || open.read) { self.open_row(None, window, cx) }
        }
        self.inbox_call("/api/inbox/delete", if only_read { json!({"read": true}) } else { json!({}) }, cx);
    }

    fn move_row(&mut self, by: isize, window: &mut Window, cx: &mut Context<Self>) {
        let rows = self.inbox_rows();
        if rows.is_empty() { return }
        let at = self.open_row.as_ref().and_then(|o| rows.iter().position(|r| &r.slug == o));
        let next = match at {
            Some(at) => (at as isize + by).clamp(0, rows.len() as isize - 1) as usize,
            None => if by > 0 { 0 } else { rows.len() - 1 },
        };
        self.open_row(Some(rows[next].slug.clone()), window, cx);
        self.inbox_scroll.scroll_to_item(next, ScrollStrategy::Nearest);
    }

    fn inbox_key(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let k = &e.keystroke;
        let m = &k.modifiers;
        // an issue's page open: Ctrl Enter presses its step, I opens its chat
        if let Some(page) = self.inbox_issue.clone() {
            match (k.key.as_str(), m.control, m.alt || m.shift || m.platform) {
                ("enter", true, false) => page.update(cx, |p, cx| p.press_step(cx)),
                ("i", false, false) => page.update(cx, |p, cx| p.open_chat(cx)),
                _ => {}
            }
        }
        if m.control || m.platform { return }
        match (k.key.as_str(), m.alt, m.shift) {
            ("u", true, false) => self.inbox_call("/api/inbox/read", json!({}), cx),
            ("backspace", false, true) => self.delete_all(true, window, cx),
            ("u", false, false) => self.toggle_read(window, cx),
            ("backspace" | "delete", false, false) => self.delete_row(window, cx),
            ("j" | "down", false, false) => self.move_row(1, window, cx),
            ("k" | "up", false, false) => self.move_row(-1, window, cx),
            ("enter", false, false) => {
                // Enter goes into the open chat, to reply
                if let Some(chat) = &self.inbox_chat { chat.update(cx, |c, cx| c.focus_composer(window, cx)) }
            }
            _ => return,
        }
        cx.stop_propagation();
    }

    // The bar over the Inbox, split at the list's edge, as Linear's: "Inbox" with its ⋯ menu over the list, and Show
    // unreads only at the list's right edge; over the rest, the open notification's title.
    fn inbox_bar(&self, list: f32, cx: &mut Context<Self>) -> Div {
        let theme = cx.theme();
        let t = theme::text(cx);
        let (muted, hover, divider) = (theme.muted_foreground, t.hover, t.divider);
        let on_fill: Hsla = if theme.mode.is_dark() { rgb(0x2d2d2f).into() } else { rgb(0xf0f0f0).into() };
        let this = cx.entity().downgrade();
        let more = Button::new("inbox-more")
            .ghost()
            .w(px(28.))
            .h(px(28.))
            .child(theme::glyph("more", muted))
            .dropdown_menu_with_anchor(Anchor::TopLeft, move |menu, _, _| {
                let (read, all, read_only) = (this.clone(), this.clone(), this.clone());
                menu.item(PopupMenuItem::new("Mark all as read").on_click(move |_, _, cx| {
                    let _ = read.update(cx, |d, cx| d.inbox_call("/api/inbox/read", json!({}), cx));
                }))
                .separator()
                .item(PopupMenuItem::new("Delete all").on_click(move |_, window, cx| {
                    let _ = all.update(cx, |d, cx| d.delete_all(false, window, cx));
                }))
                .item(PopupMenuItem::new("Delete all read").on_click(move |_, window, cx| {
                    let _ = read_only.update(cx, |d, cx| d.delete_all(true, window, cx));
                }))
            });
        let unreads = div()
            .id("inbox-unreads")
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(28.))
            .rounded_full()
            .when(self.unreads_only, |b| b.bg(on_fill))
            .when(!self.unreads_only, |b| b.hover(|s| s.bg(hover)))
            .cursor_pointer()
            .on_click(cx.listener(|desk, _, _, cx| {
                desk.unreads_only = !desk.unreads_only;
                desk.stay = if desk.unreads_only { desk.inbox.values().filter(|r| !r.read).map(|r| r.id.clone()).collect() } else { Stay::new() };
                cx.notify();
            }))
            .child(theme::glyph("unreads", if self.unreads_only { t.strong } else { muted }));
        let open = self.open_row.as_ref().and_then(|s| self.inbox.values().find(|r| &r.slug == s));
        let crumb = open.map(|r| match (r.issue && r.source.is_none(), &r.agent) {
            (true, _) => self.all.get(&r.slug).map(|i| i.title.clone()).unwrap_or_else(|| r.title.clone()),
            (false, Some(agent)) if !is_thread(r) => format!("{agent}: {}", r.title),
            _ => r.title.clone(),
        });
        div()
            .h_flex()
            .flex_none()
            .h(px(44.))
            .border_b_1()
            .border_color(divider)
            .child(
                div()
                    .h_flex()
                    .flex_none()
                    .w(px(list))
                    .h_full()
                    .pl(px(16.))
                    .pr(px(11.))
                    .gap(px(6.))
                    .border_r_1()
                    .border_color(divider)
                    .child(div().font_medium().text_color(theme.foreground).child("Inbox"))
                    .child(div().ml(px(4.)).child(more))
                    .child(div().flex_1())
                    .child(unreads),
            )
            .children(crumb.map(|title| div().flex_1().min_w_0().px(px(16.)).truncate().font_medium().text_color(t.strong).child(title)))
    }

    // A row: who or what it is about, a dot while unread, its title, then what happened and how long ago.
    fn inbox_row(&self, row: &InboxRow, n: usize, cx: &mut Context<Self>) -> Stateful<Div> {
        let theme = cx.theme();
        let t = theme::text(cx);
        let open = self.open_row.as_deref() == Some(&row.slug);
        let read = row.read || open;
        let avatar_fill: Hsla = rgb(0x8584d6).into();
        let white: Hsla = rgb(0xffffff).into();
        let badge = |child: AnyElement| {
            div().absolute().left(px(19.5)).top(px(17.5)).size(px(16.)).rounded_full().bg(theme.background).flex().items_center().justify_center().child(child)
        };
        let circle = || div().relative().flex_none().size(px(32.)).rounded_full().bg(avatar_fill).text_color(white).flex().items_center().justify_center();
        let issue = row.issue.then(|| self.all.get(&row.slug)).flatten();
        let (avatar, title, says) = if is_thread(row) {
            let mark: AnyElement = match row.source.as_deref() {
                _ if row.slug.starts_with("login:") => theme::glyph("key", t.strong).size(px(10.)).into_any_element(),
                Some("mail") => theme::glyph("envelope", t.strong).size(px(10.)).into_any_element(),
                _ => theme::slack_mark(10.).into_any_element(),
            };
            (circle().text_size(px(13.)).font_medium().child(initial(row.who.as_deref())).child(badge(mark)).into_any_element(), row.title.clone(), row.says.clone())
        } else if let Some(issue) = issue {
            let glyph = if DEADLINE.contains(&row.why.as_str()) { "calendar" } else if row.kind == "review" { "tick-bold" } else { "bubble" };
            let says = if DEADLINE.contains(&row.why.as_str()) || row.source.is_some() { row.says.clone() } else { format!("Session {}", row.says) };
            let avatar = div().relative().flex_none().size(px(32.)).child(theme::state_icon_sized(&issue.state, 32., cx)).child(badge(theme::glyph(glyph, theme.muted_foreground).size(px(12.)).into_any_element()));
            (avatar.into_any_element(), issue.title.clone(), says)
        } else {
            let avatar = match &row.agent {
                Some(agent) => circle().text_size(px(13.)).font_medium().child(initial(Some(agent))),
                None => circle().child(theme::glyph("bubble", white)),
            };
            let says = if row.source.is_some() { row.says.clone() } else { format!("{} {}", row.agent.as_deref().unwrap_or("Chat"), row.says) };
            (avatar.into_any_element(), row.title.clone(), says)
        };
        let slug = row.slug.clone();
        let hovered = row.slug.clone();
        div().id(("inbox-row", n)).h(px(ROW)).px(px(10.)).child(
            div()
                .h_flex()
                .size_full()
                .px(px(8.))
                .gap(px(12.))
                .rounded(px(8.))
                .when(open, |r| r.bg(t.raised))
                .hover(|r| r.bg(t.raised))
                .child(avatar)
                .child(
                    div()
                        .v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(px(2.))
                        .child(
                            div()
                                .h_flex()
                                .h(px(17.))
                                .gap(px(4.))
                                .when(!read, |l| l.child(div().flex_none().size(px(8.)).mr(px(2.)).rounded_full().bg(t.accent)))
                                .child(div().flex_1().min_w_0().truncate().font_medium().text_color(if read { theme.muted_foreground } else { theme.foreground }).child(title)),
                        )
                        .child(
                            div()
                                .h_flex()
                                .h(px(15.))
                                .text_size(px(12.))
                                .text_color(theme.muted_foreground)
                                .child(div().flex_1().min_w_0().truncate().child(says))
                                .child(div().flex_none().ml(px(4.)).child(ago(row.at))),
                        ),
                ),
        )
        .on_hover(cx.listener(move |desk, on: &bool, _, _| {
            if *on { desk.hovered_row = Some(hovered.clone()) } else if desk.hovered_row.as_ref() == Some(&hovered) { desk.hovered_row = None }
        }))
        .on_click(cx.listener(move |desk, _, window, cx| desk.open_row(Some(slug.clone()), window, cx)))
    }

    // What the pane says with no notification open, as Linear's: how many are unread, else that none is open.
    fn empty_pane(&self, rows: &[InboxRow], cx: &mut Context<Self>) -> Div {
        let theme = cx.theme();
        let count = rows.iter().filter(|r| !r.read).count();
        let line = if count > 0 {
            format!("{count} unread notification{}", if count == 1 { "" } else { "s" })
        } else if !rows.is_empty() {
            "No notification selected".into()
        } else if self.unreads_only {
            "No unread notifications".into()
        } else {
            "No notifications".into()
        };
        div()
            .v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .gap(px(24.))
            .font_medium()
            .text_color(theme.muted_foreground)
            .child(theme::empty_inbox(theme.muted_foreground, theme.foreground))
            .child(line)
    }

    pub(crate) fn inbox_page(&mut self, page_width: f32, cx: &mut Context<Self>) -> Div {
        let list = LIST.min(page_width / 2.);
        let rows = self.inbox_rows();
        let divider = theme::text(cx).divider;
        let waiting = theme::text(cx).waiting;
        let muted = cx.theme().muted_foreground;
        let open = self.open_row.as_ref().and_then(|s| rows.iter().find(|r| &r.slug == s)).cloned();
        if let Some(page) = &self.inbox_issue { page.update(cx, |p, _| p.width = page_width - list - 1.) }
        let theme = cx.theme();
        let pane: AnyElement = match (&open, &self.inbox_chat) {
            (Some(_), _) if self.inbox_issue.is_some() => self.inbox_issue.clone().unwrap().into_any_element(),
            (Some(_), Some(chat)) => chat.clone().into_any_element(),
            (Some(row), None) if is_thread(row) => div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .text_color(theme.muted_foreground)
                .child(format!("{}: its messages open here in a later step.", row.title))
                .into_any_element(),
            _ => self.empty_pane(&rows, cx).into_any_element(),
        };
        let this = cx.entity().downgrade();
        let shown = rows.clone();
        let list_rows = uniform_list("inbox", rows.len(), move |range, _, cx| {
            let Some(desk) = this.upgrade() else { return Vec::new() };
            range.map(|n| desk.update(cx, |desk, cx| desk.inbox_row(&shown[n], n, cx))).collect()
        })
        .track_scroll(&self.inbox_scroll)
        .flex_1();
        div().size_full().child(div()
            .id("inbox-page")
            .v_flex()
            .size_full()
            .track_focus(&self.inbox_focus)
            .on_key_down(cx.listener(|desk, e: &KeyDownEvent, window, cx| desk.inbox_key(e, window, cx)))
            .child(self.inbox_bar(list, cx))
            .child(
                div()
                    .h_flex()
                    .flex_1()
                    .min_h_0()
                    .child(
                        div()
                            .v_flex()
                            .flex_none()
                            .w(px(list))
                            .h_full()
                            .py(px(8.))
                            .border_r_1()
                            .border_color(divider)
                            .on_mouse_down(MouseButton::Left, cx.listener(|desk, _, window, cx| window.focus(&desk.inbox_focus, cx)))
                            .when_some(self.notice.clone(), |l, (notice, wrong)| l.child(div().px(px(18.)).pb(px(8.)).text_xs().text_color(if wrong { waiting } else { muted }).child(notice)))
                            .child(list_rows),
                    )
                    .child(div().flex_1().min_w_0().h_full().child(pane)),
            ))
    }

    // The sidebar's Inbox, over the issues, with how many rows are unread.
    pub(crate) fn inbox_item(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let theme = cx.theme();
        let t = theme::text(cx);
        let here = self.in_inbox();
        let count = self.unread();
        let colour = if here { t.strong } else { theme.muted_foreground };
        div()
            .id("nav-inbox")
            .h_flex()
            .h(px(28.))
            .mx_2()
            .pl(px(6.))
            .pr(px(9.))
            .gap(px(8.))
            .rounded(px(8.))
            .font_medium()
            .text_color(colour)
            .when(here, |n| n.bg(theme.list_active))
            .when(!here, |n| n.hover(|s| s.bg(theme.list_hover).text_color(theme.foreground)))
            .cursor_pointer()
            .child(theme::glyph("inbox", theme.muted_foreground))
            .child("Inbox")
            .when(count > 0, |n| n.child(div().ml_auto().text_xs().font_normal().text_color(theme.muted_foreground).child(count.to_string())))
            .on_click(cx.listener(|desk, _, window, cx| desk.show_inbox(window, cx)))
    }
}

// Rows read while Show unreads only is on stay listed until the Inbox is left (InboxPage.tsx, stay).
pub type Stay = HashSet<String>;
