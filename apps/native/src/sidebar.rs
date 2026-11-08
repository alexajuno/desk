// The sidebar, as the web's (frame/Sidebar.tsx), which copies Linear's: its head with the sidebar's toggle, Search and
// New issue; Inbox and My issues; Your teams, each folding open to its own Issues and Projects; then the chats you
// pinned and every other one still in hand, the newest first, as claude.ai's Starred and Recents (pages.ts, chatsNow).
// A section folds by a click on its label, kept between runs as the web keeps localStorage.sideFolded. A chat's row
// takes keys while the mouse is on it: P pins it, R renames a chat with no issue, Delete deletes one whose issue is not
// being worked, and a key with no action says why rather than reaching the chat open beside it.
use std::collections::HashSet;
use std::rc::Rc;

use gpui_kit::base::StyledExt;
use gpui_kit::component::ActiveTheme;
use gpui_kit::component::menu::{ContextMenuExt, PopupMenuItem};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::{json, Value};

use crate::picker::{Menu, Picker, PickerEvent, Source};
use crate::{chat::Chat, net, theme, toast, Desk, Page};

// A session as the sidebar lists it (store/frame.ts, ChatRow): its issue's slug and state, if it has one; auto, while
// Auto carries it on without you.
#[derive(Clone, Default, PartialEq)]
pub struct ChatRow {
    pub session: String,
    pub title: String,
    pub issue: Option<(String, String)>,
    pub working: bool,
    pub auto: bool,
}

// What the sidebar shows that no row says yet (pages.ts, framePage): the sessions pinned, in the order pinned, and the
// others still in hand.
#[derive(Clone, Default)]
pub struct Frame {
    pub pinned: Vec<ChatRow>,
    pub chats: Vec<ChatRow>,
}

impl Frame {
    pub fn read(frame: &Value) -> Frame {
        let rows = |key: &str| -> Vec<ChatRow> {
            frame[key].as_array().into_iter().flatten().map(|c| ChatRow {
                session: c["session"].as_str().unwrap_or("").into(),
                title: c["title"].as_str().unwrap_or("").into(),
                issue: c["issue"]["slug"].as_str().map(|slug| (slug.to_string(), c["issue"]["state"].as_str().unwrap_or("").to_string())),
                working: c["working"].as_bool().unwrap_or(false),
                auto: c["auto"].as_bool().unwrap_or(false),
            }).collect()
        };
        Frame { pinned: rows("pinned"), chats: rows("chats") }
    }
}

// The states of an issue being worked, whose chat has no Delete (the server's chats.ts, AT_WORK).
const AT_WORK: [&str; 4] = ["running", "waiting", "review", "landing"];

// The sections folded, and whether the sidebar is hidden ([ or its toggle).
#[derive(Default)]
pub struct Side {
    folded: HashSet<String>,
    pub hidden: bool,
}

impl Side {
    fn file() -> Option<std::path::PathBuf> {
        Some(crate::state_dir()?.join("native-side-folded"))
    }

    pub fn load() -> Side {
        let folded = Side::file().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok());
        Side { folded: folded.unwrap_or_default().into_iter().collect(), hidden: false }
    }

    fn toggle(&mut self, name: &str) {
        if !self.folded.remove(name) { self.folded.insert(name.into()); }
        let Some(file) = Side::file() else { return };
        if self.folded.is_empty() {
            let _ = std::fs::remove_file(file);
        } else {
            let mut names: Vec<&String> = self.folded.iter().collect();
            names.sort();
            if let Some(dir) = file.parent() { let _ = std::fs::create_dir_all(dir); }
            let _ = std::fs::write(file, serde_json::to_string(&names).unwrap_or_default());
        }
    }

    fn open(&self, name: &str) -> bool {
        !self.folded.contains(name)
    }
}

// What a chat's row can do, which its right-click menu and its keys share.
struct Actions {
    rename: bool,
    remove: bool,
    why: &'static str, // why it can't be deleted
}


impl Desk {
    pub(crate) fn sidebar(&self, cx: &mut Context<Self>) -> Div {
        // Linear's sidebar keeps its scrollbar's room whether it shows or not, 2px beside it: rows end 12px from its edge.
        let mut list = div().id("side-list").v_flex().flex_1().min_h_0().overflow_y_scroll().pb_3();
        list = list
            .child(self.inbox_item(cx).flex_none())
            .child(self.nav_item("nav-issues", "issues", "My issues".into(), self.list_here(None, cx), cx)
                .on_click(cx.listener(|desk, _, window, cx| desk.open_list("", None, window, cx))))
            .child(self.fold_label("Your teams", cx));
        if self.side.open("Your teams") {
            for team in self.active_teams() {
                list = list.child(self.team_group(&team, cx));
            }
        }
        if !self.frame.pinned.is_empty() {
            list = list.child(self.fold_label("Pinned", cx));
            if self.side.open("Pinned") {
                for c in &self.frame.pinned { list = list.child(self.chat_row(c, true, cx)) }
            }
        }
        if !self.frame.chats.is_empty() {
            list = list.child(self.fold_label("Chats", cx));
            if self.side.open("Chats") {
                for c in &self.frame.chats { list = list.child(self.chat_row(c, false, cx)) }
            }
        }
        div()
            .v_flex()
            .flex_none()
            .w(px(244.))
            .h_full()
            .pt_3()
            .pl_3()
            .pr(px(12.))
            .child(self.side_head(cx))
            .child(list)
            .children(self.renaming.as_ref().map(|(picker, at, _)| {
                deferred(anchored().position(*at).snap_to_window_with_margin(px(8.)).child(picker.clone())).with_priority(2)
            }))
    }

    // The sidebar's head, where Linear's workspace switcher is: the toggle at its left, Search and New issue at its right.
    fn side_head(&self, cx: &mut Context<Self>) -> Div {
        let theme = cx.theme();
        let (muted, fg, strong) = (theme.muted_foreground, theme.foreground, theme::text(cx).strong);
        let dark = theme.mode.is_dark();
        let c = |hex: u32| -> Hsla { rgb(hex).into() };
        let icon_hover = if dark { c(0x1b1c1d) } else { hsla(0., 0., 0., 0.06) };
        let (button, button_hover) = if dark { (c(0x1b1c1d), c(0x252527)) } else { (c(0xf9f9fa), c(0xefeff0)) };
        let ring = if dark { hsla(0., 0., 1., 0.137) } else { hsla(0., 0., 0., 0.09) };
        let round = |id: &'static str| div().id(id).flex().items_center().justify_center().size(px(28.)).rounded_full().cursor_pointer();
        div()
            .h_flex()
            .h(px(28.))
            .gap(px(4.))
            .mb_3()
            .child(round("side-toggle").text_color(muted).hover(move |s| s.bg(icon_hover).text_color(strong))
                .child(theme::glyph("side", muted).size(px(14.)))
                .on_click(cx.listener(|desk, _, _, cx| desk.toggle_side(cx))))
            .child(div().flex_1())
            .child(round("side-search").hover(move |s| s.bg(icon_hover))
                .child(theme::glyph("search", muted).size(px(14.)))
                .on_click(cx.listener(|desk, _, window, cx| desk.open_search(window, cx))))
            .child(round("side-new-issue").bg(button).shadow(vec![crate::filters::ring(ring, 0.5)]).hover(move |s| s.bg(button_hover))
                .child(theme::glyph("new-issue", fg).size(px(14.)))
                .on_click(cx.listener(|desk, _, window, cx| desk.new_issue(serde_json::json!({}), window, cx))))
    }

    // A row of the sidebar, Linear's: 28px, its 16px icon and its words in --text-3, a fill under the mouse, and the
    // current one filled and bright.
    fn nav_item(&self, id: impl Into<ElementId>, icon: &str, label: SharedString, here: bool, cx: &mut Context<Self>) -> Stateful<Div> {
        let theme = cx.theme();
        let (hover, active, muted, fg) = (theme.list_hover, theme.list_active, theme.muted_foreground, theme.foreground);
        let strong = theme::text(cx).strong;
        div()
            .id(id.into())
            .h_flex()
            .flex_none()
            .h(px(28.))
            .pl(px(6.))
            .pr(px(9.))
            .gap(px(8.))
            .rounded(px(8.))
            .font_medium()
            .text_color(if here { strong } else { muted })
            .when(here, |n| n.bg(active))
            .when(!here, |n| n.hover(move |s| s.bg(hover).text_color(fg)))
            .child(theme::glyph(icon, muted))
            .child(div().min_w_0().truncate().child(label))
    }

    // A section's label, Linear's sidebar section header: a click folds what is under it, and the triangle turns.
    fn fold_label(&self, name: &'static str, cx: &mut Context<Self>) -> Stateful<Div> {
        let muted = cx.theme().muted_foreground;
        let strong = theme::text(cx).strong;
        let open = self.side.open(name);
        div()
            .id(SharedString::from(format!("fold-{name}")))
            .group(SharedString::from(format!("fold-{name}")))
            .h_flex()
            .flex_none()
            .h(px(40.))
            .pt(px(12.))
            .px(px(6.))
            .gap(px(2.))
            .text_xs()
            .font_medium()
            .text_color(muted)
            .hover(move |s| s.text_color(strong))
            .child(name)
            .child(theme::glyph(if open { "triangle-open" } else { "triangle" }, muted)
                .group_hover(SharedString::from(format!("fold-{name}")), move |s| s.text_color(strong)))
            .on_click(cx.listener(move |desk, _, _, cx| {
                desk.side.toggle(name);
                cx.notify();
            }))
    }

    fn active_teams(&self) -> Vec<Value> {
        let mut teams: Vec<Value> = self.rows.get("teams").into_iter().flat_map(|t| t.values()).filter(|t| t["state"] == "active").cloned().collect();
        teams.sort_by(|a, b| a["created"].as_str().cmp(&b["created"].as_str()));
        teams
    }

    // A team, Linear's: its icon and name, and a triangle that folds its pages, its Issues and Projects 19px further in;
    // right-click for its settings and every team.
    fn team_group(&self, team: &Value, cx: &mut Context<Self>) -> Div {
        let theme = cx.theme();
        let (hover, muted, fg) = (theme.list_hover, theme.muted_foreground, theme.foreground);
        let faint = theme::text(cx).faint;
        let slug = team["slug"].as_str().unwrap_or("").to_string();
        let title = team["title"].as_str().unwrap_or(&slug).to_string();
        let key = format!("team:{slug}");
        let open = self.side.open(&key);
        let row = div()
            .id(SharedString::from(key.clone()))
            .h_flex()
            .h(px(28.))
            .px(px(9.))
            .gap(px(7.))
            .rounded(px(8.))
            .font_medium()
            .text_color(muted)
            .hover(move |s| s.bg(hover).text_color(fg))
            .child(theme::glyph("team", fg).size(px(14.)))
            .child(div().min_w_0().truncate().child(title))
            .child(div().ml(px(-5.)).child(theme::glyph(if open { "triangle-open" } else { "triangle" }, faint)))
            .on_click(cx.listener(move |desk, _, _, cx| {
                desk.side.toggle(&key);
                cx.notify();
            }));
        let (settings, all) = (cx.entity().downgrade(), cx.entity().downgrade());
        let team_slug = slug.clone();
        let row = row.context_menu(move |menu, _, _| {
            let (settings, all, slug) = (settings.clone(), all.clone(), team_slug.clone());
            menu.item(menu_row("sliders", "Team settings", None).on_click(move |_, _, cx| {
                let _ = settings.update(cx, |desk, cx| desk.show_soon(&format!("team/{slug}"), cx));
            }))
            .item(menu_row("team", "All teams", None).on_click(move |_, _, cx| {
                let _ = all.update(cx, |desk, cx| desk.show_soon("teams", cx));
            }))
        });
        let here = |page: &str| self.page == Page::Soon && self.soon == format!("team/{slug}/{page}");
        div().v_flex().flex_none().child(row).when(open, |group| {
            let (issues, projects) = (slug.clone(), slug.clone());
            group
                .child(div().ml(px(19.)).child(self.nav_item(SharedString::from(format!("team-issues-{slug}")), "issues", "Issues".into(), self.list_here(Some(&slug), cx), cx)
                    .on_click(cx.listener(move |desk, _, window, cx| desk.open_list("", Some(issues.clone()), window, cx)))))
                .child(div().ml(px(19.)).child(self.nav_item(SharedString::from(format!("team-projects-{slug}")), "project", "Projects".into(), here("projects"), cx)
                    .on_click(cx.listener(move |desk, _, _, cx| desk.show_soon(&format!("team/{projects}/projects"), cx)))))
        })
    }

    fn actions(&self, c: &ChatRow) -> Actions {
        let is_chat = self.rows.get("chats").is_some_and(|chats| chats.values().any(|chat| chat["session"].as_str() == Some(&c.session)));
        let state = c.issue.as_ref().map(|(slug, state)| self.all.get(slug).map(|i| i.state.clone()).unwrap_or_else(|| state.clone()));
        let working = state.as_deref().is_some_and(|s| AT_WORK.contains(&s));
        Actions {
            rename: c.issue.is_none(),
            remove: is_chat && !working,
            why: if working { "Its issue is being worked: delete the chat once that ends." } else { "Only a desk chat can be deleted, not an issue's own session." },
        }
    }

    // A session's row: its issue's state, or a ring for a chat with no issue; then, on the right, the composer's Auto icon
    // while Auto carries the chat on without you, or else the Inbox's dot while its row there is unread and the chat is
    // not working. One with an issue opens the issue, where its chat is, and goes by the issue's title.
    fn chat_row(&self, c: &ChatRow, pinned: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let (hover, active, muted, fg) = (theme.list_hover, theme.list_active, theme.muted_foreground, theme.foreground);
        let t = theme::text(cx);
        let here = match &c.issue {
            Some((slug, _)) => self.page == Page::Issue && self.picked.as_deref() == Some(slug),
            None => self.page == Page::Session && self.session_shown.as_deref() == Some(&c.session),
        };
        let unread = self.inbox.get(&c.session).is_some_and(|r| !r.read);
        let state = c.issue.as_ref().map(|(slug, state)| self.all.get(slug).map(|i| i.state.clone()).unwrap_or_else(|| state.clone()));
        let session = c.session.clone();
        let hovered = session.clone();
        let row = div()
            .id(SharedString::from(format!("chat-{}", c.session)))
            .h_flex()
            .flex_none()
            .h(px(28.))
            .pl(px(6.))
            .pr(px(9.))
            .gap(px(8.))
            .rounded(px(8.))
            .font_medium()
            .text_color(if here { t.strong } else { muted })
            .when(here, |n| n.bg(active))
            .when(!here, |n| n.hover(move |s| s.bg(hover).text_color(fg)))
            .child(div().size(px(16.)).flex().items_center().justify_center().child(theme::state_icon(state.as_deref().unwrap_or("chat"), cx)))
            .child(div().flex_1().min_w_0().truncate().child(c.title.clone()))
            .map(|row| {
                if c.auto {
                    row.child(theme::glyph("auto", muted).size(px(14.)))
                } else if !c.working && unread {
                    row.child(div().flex_none().size(px(8.)).rounded_full().bg(t.accent))
                } else {
                    row
                }
            })
            .on_hover(cx.listener(move |desk, on: &bool, _, _| {
                if *on { desk.hovered_chat = Some(hovered.clone()) } else if desk.hovered_chat.as_deref() == Some(&hovered) { desk.hovered_chat = None }
            }))
            .on_click(cx.listener(move |desk, _, window, cx| desk.open_session(&session, window, cx)));
        let Actions { rename, remove, .. } = self.actions(c);
        let this = cx.entity().downgrade();
        let session = c.session.clone();
        row.context_menu(move |mut menu, _, _| {
            let (pin, renamer, deleter) = (this.clone(), this.clone(), this.clone());
            let (one, two, three) = (session.clone(), session.clone(), session.clone());
            menu = menu.item(menu_row("pin", if pinned { "Unpin" } else { "Pin" }, Some("P")).on_click(move |_, _, cx| {
                let _ = pin.update(cx, |desk, cx| desk.pin_chat(&one, !pinned, cx));
            }));
            if rename {
                menu = menu.item(menu_row("pencil", "Rename…", Some("R")).on_click(move |_, window, cx| {
                    let _ = renamer.update(cx, |desk, cx| desk.rename_chat(&two, window, cx));
                }));
            }
            if remove {
                menu = menu.separator().item(menu_row("trash", "Delete", Some("Del")).on_click(move |_, _, cx| {
                    let _ = deleter.update(cx, |desk, cx| desk.delete_chat(&three, true, None, cx));
                }));
            }
            menu
        })
    }

    // The keys of the chat under the mouse, as Linear's keys act on the row under it.
    pub(crate) fn chat_key(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let k = &e.keystroke;
        if k.modifiers.alt || k.modifiers.shift || k.modifiers.control || k.modifiers.platform { return false }
        let Some(session) = self.hovered_chat.clone() else { return false };
        let pinned = self.frame.pinned.iter().any(|c| c.session == session);
        let Some(c) = self.frame.pinned.iter().chain(&self.frame.chats).find(|c| c.session == session).cloned() else { return false };
        let actions = self.actions(&c);
        match k.key.as_str() {
            "p" => self.pin_chat(&session, !pinned, cx),
            "r" if actions.rename => self.rename_chat(&session, window, cx),
            "r" => toast::say("A chat with an issue goes by the issue's title.", cx),
            "delete" | "backspace" if actions.remove => self.delete_chat(&session, true, None, cx),
            "delete" | "backspace" => toast::say(actions.why, cx),
            _ => return false,
        }
        true
    }

    fn pin_chat(&mut self, session: &str, pinned: bool, cx: &mut Context<Self>) {
        self.chat_call(format!("/api/live/{session}/pin"), json!({ "pinned": pinned }), cx);
    }

    // Rename…: a box over the row, holding its title; Enter saves what it holds, and an empty one gives back Claude
    // Code's own title.
    pub(crate) fn rename_chat(&mut self, session: &str, window: &mut Window, cx: &mut Context<Self>) {
        let shown = self.chat.as_ref().filter(|c| c.read(cx).session() == Some(session)).and_then(|c| c.read(cx).title());
        let title = self.frame.pinned.iter().chain(&self.frame.chats).find(|c| c.session == session).map(|c| c.title.clone()).or(shown).unwrap_or_default();
        let menu = Menu { source: Source::Fixed(Vec::new()), placeholder: "Rename chat…", empty: "Enter saves it; empty gives back its own title", width: 300., takes_typed: true, start: title };
        let at = window.mouse_position();
        let picker = cx.new(|cx| Picker::new(menu, Bounds::new(at, size(px(1.), px(1.))), window, cx));
        let session = session.to_string();
        let sub = cx.subscribe(&picker, move |desk, _, event: &PickerEvent, cx| {
            if let PickerEvent::Typed(typed) = event {
                let title = typed.split_whitespace().collect::<Vec<_>>().join(" ");
                desk.chat_call(format!("/api/live/{session}/title"), json!({ "title": title }), cx);
            }
            if matches!(event, PickerEvent::Typed(_) | PickerEvent::Closed | PickerEvent::Picked(_)) {
                desk.renaming = None;
                cx.notify();
            }
        });
        self.renaming = Some((picker, at, sub));
        cx.notify();
    }

    // Delete takes the chat out of sight and keeps its files (the server's chats.ts, remove), with Undo in its toast; a
    // chat's Triage issue is dropped with it, and comes back with Undo.
    fn delete_chat(&mut self, session: &str, deleted: bool, dropped: Option<String>, cx: &mut Context<Self>) {
        let (path, body) = (format!("/api/live/{session}/delete"), json!({ "deleted": deleted, "dropped": dropped }));
        let session = session.to_string();
        let this = cx.entity().downgrade();
        cx.spawn(async move |_, cx| {
            let answer = cx.background_spawn(async move { net::post(&path, body) }).await;
            cx.update(|cx| match answer {
                Err(reason) => toast::say(reason, cx),
                Ok(answer) if deleted => {
                    let dropped = answer["dropped"].as_str().map(str::to_string);
                    let undo: toast::Run = Rc::new(move |_, cx| {
                        let (session, dropped) = (session.clone(), dropped.clone());
                        let _ = this.update(cx, |desk, cx| desk.delete_chat(&session, false, dropped, cx));
                    });
                    toast::show("Chat deleted", Some(("Undo", undo)), cx);
                }
                Ok(_) => {}
            });
        })
        .detach();
    }

    // A call about a chat, its reason in a toast when desk refuses it; the frame then brings the change.
    fn chat_call(&mut self, path: String, body: Value, cx: &mut Context<Self>) {
        cx.spawn(async move |_, cx| {
            if let Err(reason) = cx.background_spawn(async move { net::post(&path, body) }).await {
                cx.update(|cx| toast::say(reason, cx));
            }
        })
        .detach();
    }

    pub(crate) fn toggle_side(&mut self, cx: &mut Context<Self>) {
        self.side.hidden = !self.side.hidden;
        cx.notify();
    }

    // A chat by its session: one with an issue opens the issue, where its chat is; one with none yet, its own page.
    pub(crate) fn open_session(&mut self, session: &str, window: &mut Window, cx: &mut Context<Self>) {
        let row = self.frame.pinned.iter().chain(&self.frame.chats).find(|c| c.session == session).cloned();
        if let Some((slug, _)) = row.as_ref().and_then(|c| c.issue.clone()) {
            let issue = self.all.get(&slug).cloned().unwrap_or(crate::Issue { slug, ..Default::default() });
            return self.open(&issue, window, cx);
        }
        self.page = Page::Session;
        if self.session_shown.as_deref() == Some(session) && self.chat.is_some() { return cx.notify() }
        self.session_shown = Some(session.to_string());
        self.picked = None;
        self.current = crate::Issue { title: row.map(|c| c.title).unwrap_or_default(), state: "chat".into(), ..Default::default() };
        self.chat = Some(cx.new(|cx| {
            let mut chat = Chat::of_session(session.to_string(), window, cx);
            chat.wants_focus = true;
            chat
        }));
        self.changes = None;
        self.commits = None;
        let half = self.half.filter(|h| *h != Half::Terminal && *h != Half::Browser && *h != Half::Steps && *h != Half::Changes);
        self.set_half(half, cx);
        crate::give_back(cx);
        cx.notify();
    }

    // New chat, Ctrl Shift O: desk makes an agent chat, or hands back a new one nobody wrote in yet, and it opens here,
    // its composer taking the cursor (the web's newSession). It files its issue once you say what about.
    pub(crate) fn new_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        cx.spawn_in(window, async move |this, cx| {
            let made = cx.background_spawn(async { net::post("/sessions/new", json!({})) }).await;
            let _ = this.update_in(cx, |desk, window, cx| match made.map(|v| v["id"].as_str().map(str::to_string)) {
                Ok(Some(id)) => desk.open_session(&id, window, cx),
                Ok(None) => toast::say("desk made no chat", cx),
                Err(reason) => toast::say(reason, cx),
            });
        })
        .detach();
    }

    // The frame changed: a chat shown before its issue moves to the issue's page once the agent files one, as the web's
    // SessionFullRoute does, and its head takes a new title.
    pub(crate) fn frame_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.page != Page::Session { return }
        let Some(session) = self.session_shown.clone() else { return };
        let Some(row) = self.frame.pinned.iter().chain(&self.frame.chats).find(|c| c.session == session).cloned() else { return };
        match row.issue {
            Some((slug, _)) => {
                let issue = self.all.get(&slug).cloned().unwrap_or(crate::Issue { slug, ..Default::default() });
                self.session_shown = None;
                self.open(&issue, window, cx);
            }
            None => self.current.title = row.title,
        }
    }

    // Whether the page shows this list: My issues (None), or a team's Issues.
    fn list_here(&self, team: Option<&str>, cx: &App) -> bool {
        self.page == Page::List && self.list.as_ref().is_some_and(|(l, _)| l.read(cx).team.as_deref() == team)
    }

    // My issues, or a team's Issues, on the tab it was left on, and drawn again.
    pub(crate) fn open_list(&mut self, tab: &str, team: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let list = match &self.list {
            Some((list, _)) if list.read(cx).team == team => {
                let list = list.clone();
                list.update(cx, |l, cx| l.refresh(cx));
                list
            }
            _ => {
                let list = cx.new(|cx| crate::lists::IssueList::new(tab, team, cx));
                let events = cx.subscribe_in(&list, window, |desk, _, event, window, cx| match event {
                    crate::lists::ListEvent::Open(slug) => {
                        let issue = desk.all.get(slug).cloned().unwrap_or_else(|| crate::Issue { slug: slug.clone(), ..Default::default() });
                        desk.open(&issue, window, cx);
                    }
                    crate::lists::ListEvent::New(preset) => desk.new_issue(preset.clone(), window, cx),
                });
                self.list = Some((list.clone(), events));
                list
            }
        };
        self.page = Page::List;
        let focus = list.read(cx).focus.clone();
        window.focus(&focus, cx);
        cx.notify();
    }

    // A page this issue builds in a later step.
    pub(crate) fn show_soon(&mut self, what: &str, cx: &mut Context<Self>) {
        self.page = Page::Soon;
        self.soon = what.to_string();
        cx.notify();
    }
}

use crate::Half;

// A row of an actions menu, the web's .menu.actions: its glyph, its words, and its key at the right.
pub(crate) fn menu_row(icon: &'static str, label: &'static str, key: Option<&'static str>) -> PopupMenuItem {
    PopupMenuItem::element(move |_, cx| {
        let muted = cx.theme().muted_foreground;
        div().h_flex().w_full().gap_2().child(theme::glyph(icon, muted)).child(div().flex_1().child(label))
            .when_some(key, |row, key| row.child(div().pl_4().text_xs().text_color(muted).child(key)))
    })
}
