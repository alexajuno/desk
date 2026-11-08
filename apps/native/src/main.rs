// desk's window, native: GPUI (Zed's toolkit) with gpui-component, on desk's Node server, which it reads as the page
// does (desk issue "Rebuild desk as a native Rust app like Zed, off Electron"). It copies the web app's frame, which
// copies Linear's: the open issues down the left, directly on the window's background, and the page beside them, one
// panel floating a few pixels in, with the picked issue's chat and, when its head's buttons say so, its right half: its
// steps, its Changes, its terminal or its Browser.
mod browser;
mod changes;
mod chat;
mod inbox;
mod issue;
mod emoji;
mod filters;
mod listing;
mod picker;
mod settings;
mod sidebar;
mod toast;
mod thread;
mod live;
mod net;
mod steps;
mod sync;
mod terminal;
mod theme;

use changes::Changes;
use chat::Chat;
use gpui_kit::base::StyledExt;
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use steps::Steps;
use std::collections::HashMap;

use sync::{Event, InboxRow, Issue};

const OPEN: [&str; 5] = ["triage", "running", "review", "waiting", "backlog"];

// The chat is a column this wide beside its right half, and the half takes the rest; where the page can't give the half
// HALF beside it, the half takes the chat's place under the chat's head, one screen at a time (the web app's
// frame/oneScreen.ts). SIDE is the sidebar and the page's margin, or the page's margins alone while it is hidden.
const CHAT: f32 = 480.;
const HALF: f32 = 780.;
const SIDE: f32 = 252.;

// What the page shows: an issue's chat, a chat before its issue, the Inbox, Settings, or a page a later step builds.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Page {
    Issue,
    Session,
    Inbox,
    Settings,
    Soon,
}

// What the right half shows.
#[derive(Clone, Copy, PartialEq)]
enum Half {
    Terminal,
    Browser,
    Steps,
    Changes,
}

struct Desk {
    page: Page,
    issues: Vec<Issue>,
    all: HashMap<String, Issue>, // every issue, open or not, by slug, for the Inbox's rows
    inbox: HashMap<String, InboxRow>, // by id
    open_row: Option<String>,        // the Inbox's row open, by what it opens
    pending_row: Option<String>,     // the row to open once the rows came (`desk inbox <row>`)
    inbox_chat: Option<Entity<Chat>>,
    inbox_issue: Option<Entity<issue::IssuePage>>, // an issue's row open: its page
    inbox_thread: Option<Entity<thread::ThreadPage>>, // a thread's row open: its messages
    started: HashMap<String, String>, // the chat you started on a thread, by the thread, until its row says so itself
    _inbox_issue_events: Option<Subscription>,
    rows: sync::Rows,                  // teams, projects, milestones, activity and chats, as desk sends them
    frame: sidebar::Frame,             // the sidebar's sessions
    side: sidebar::Side,
    hovered_chat: Option<String>,      // the sidebar's chat under the mouse, which P, R and Delete act on
    renaming: Option<(Entity<picker::Picker>, Point<Pixels>, Subscription)>,
    session_shown: Option<String>,     // the chat shown before its issue
    soon: String,                      // which page a later step builds
    focus: FocusHandle,                // the window's own, which holds the keys while nothing types
    teams: HashMap<String, String>,    // a team's name by its slug, for the Inbox's filters
    projects: HashMap<String, String>, // a project's name by its slug
    inbox_view: listing::View,         // Filter, Display options and Show unreads only
    filter_menu: Option<filters::FilterMenu>,
    _filter_typed: Option<Subscription>,
    display_open: bool,
    order_open: bool,
    anchors: filters::Anchors,
    stay: inbox::Stay,
    hovered_row: Option<String>,
    reading: std::collections::HashSet<String>,
    notice: Option<(String, bool)>, // what the Inbox says over its list, and whether something went wrong
    inbox_focus: FocusHandle,
    inbox_scroll: UniformListScrollHandle,
    picked: Option<String>,
    current: Issue, // the picked issue as last heard, open or closed, for the chat's head
    chat: Option<Entity<Chat>>,
    steps: Entity<Steps>,
    changes: Option<Entity<Changes>>,
    half: Option<Half>,
    terminal: Option<Entity<terminal::Terminal>>, // the chat's terminal, while the half shows it
    _terminal_events: Option<Subscription>,
    tabs: Vec<sync::Tab>, // the tabs Claude's sessions have open in desk's Chrome
    browser: Option<Entity<browser::Browser>>, // the chat's Browser, while the half shows it
    tab_of: HashMap<String, String>, // the tab each chat's Browser shows, by its session, once you picked one or Claude used one
    _browser_events: Option<Subscription>,
    commits: Option<Vec<String>>, // the picked issue's steps' commits, once its page came
    shows: smol::channel::Sender<String>,
    settings: Option<Entity<settings::SettingsPage>>, // while Settings shows
    back_to: Page, // the page Back to app returns to
    _appearance: Subscription,
}

impl Desk {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (send, events) = smol::channel::unbounded();
        let window_handle = Some(window.window_handle());
        let (shows, shown) = smol::channel::unbounded();
        sync::start(send, shown);
        cx.spawn(async move |this, cx| {
            while let Ok(event) = events.recv().await {
                let Some(window) = window_handle else { break };
                let done = window.update(cx, |_, window, cx| {
                    this.update(cx, |desk, cx| { desk.apply(event, window, cx); cx.notify() })
                });
                if !matches!(done, Ok(Ok(()))) { break }
            }
        })
        .detach();
        // The system's light or dark, as the web app follows it.
        let appearance = cx.observe_window_appearance(window, |_, window, cx| theme::sync(window, cx));
        let half = match std::env::var("DESK_HALF").as_deref() {
            Ok("steps") => Some(Half::Steps),
            Ok("changes") => Some(Half::Changes),
            _ => None,
        };
        Self {
            page: Page::Issue,
            all: HashMap::new(),
            inbox: HashMap::new(),
            open_row: None,
            pending_row: None,
            inbox_chat: None,
            inbox_issue: None,
            inbox_thread: None,
            started: HashMap::new(),
            _inbox_issue_events: None,
            rows: sync::Rows::new(),
            frame: sidebar::Frame::default(),
            side: sidebar::Side::load(),
            hovered_chat: None,
            renaming: None,
            session_shown: None,
            soon: String::new(),
            focus: cx.focus_handle(),
            teams: HashMap::new(),
            projects: HashMap::new(),
            inbox_view: listing::View::load(),
            filter_menu: None,
            _filter_typed: None,
            display_open: false,
            order_open: false,
            anchors: Default::default(),
            stay: inbox::Stay::new(),
            hovered_row: None,
            reading: Default::default(),
            notice: None,
            inbox_focus: cx.focus_handle(),
            inbox_scroll: UniformListScrollHandle::new(),
            issues: Vec::new(), picked: None, current: Issue::default(), chat: None, steps: cx.new(|_| Steps::new()), changes: None, half, terminal: None, _terminal_events: None, tabs: Vec::new(), browser: None, tab_of: HashMap::new(), _browser_events: None, commits: None, shows, settings: None, back_to: Page::Issue, _appearance: appearance }
    }

    fn apply(&mut self, event: Event, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            Event::Page { slug, page } => {
                if let Some(open) = self.inbox_issue.clone().filter(|p| p.read(cx).slug == slug) {
                    let page = page.clone();
                    open.update(cx, |open, cx| open.set(page, window, cx));
                }
                if self.picked.as_deref() == Some(&slug) {
                    self.steps.update(cx, |steps, cx| steps.set(&page, cx));
                    // A step's new commit opens Changes once, over the steps but never in the chat's place.
                    let commits = changes::commits(&page);
                    let new = self.commits.as_ref().is_some_and(|had| commits.last().is_some_and(|c| !had.contains(c)));
                    if new && self.half != Some(Half::Changes) && !self.one_screen(window) {
                        self.set_half(Some(Half::Changes), cx);
                    }
                    self.commits = Some(commits);
                    if let Some(changes) = &self.changes { changes.update(cx, |c, cx| c.page(&page, cx)) }
                }
                return;
            }
            Event::Row { table, key, row } => {
                self.row(&table, key, row);
                return;
            }
            Event::Frame(frame) => {
                self.frame = sidebar::Frame::read(&frame);
                self.frame_changed(window, cx);
                return;
            }
            // Claude opened the chat's terminal (tt, or desk's call): it opens beside the chat, where you watch it type
            Event::Terminal(session) => {
                let shown = self.chat.as_ref().and_then(|c| c.read(cx).session().map(str::to_string));
                if self.page == Page::Issue && shown.as_deref() == Some(session.as_str()) && self.half != Some(Half::Terminal) {
                    self.open_terminal(false, window, cx);
                }
                return;
            }
            Event::Tab { target, row } => {
                self.tabs.retain(|t| t.target != target);
                self.tabs.extend(row);
                self.tabs_changed(cx);
                return;
            }
            // Claude opened a tab or works in one: the chat's Browser opens on it, where you watch what it does there
            Event::Browser { session, target } => {
                self.tab_of.insert(session.clone(), target);
                if self.page == Page::Issue && self.session(cx).as_deref() == Some(session.as_str()) { self.open_browser(cx) }
                return;
            }
            // the session closed its last tab: its Browser, which would show nothing, closes
            Event::BrowserClosed(session) => {
                if self.half == Some(Half::Browser) && self.session(cx).as_deref() == Some(session.as_str()) { self.set_half(None, cx) }
                return;
            }
            Event::Snapshot(issues, inbox, rows, tabs) => {
                self.tabs = tabs;
                self.tabs_changed(cx);
                self.rows = rows;
                let names = |table: &str| -> HashMap<String, String> {
                    self.rows.get(table).into_iter().flatten().map(|(k, r)| (k.clone(), r["title"].as_str().unwrap_or(k).to_string())).collect()
                };
                (self.teams, self.projects) = (names("teams"), names("projects"));
                self.all = issues.iter().map(|i| (i.slug.clone(), i.clone())).collect();
                self.issues = issues;
                self.inbox = inbox.into_iter().map(|r| (r.id.clone(), r)).collect();
                self.inbox_changed(window, cx);
                give_back(cx); // what reading the snapshot took
            }
            Event::Inbox { id, row } => {
                match row {
                    Some(row) => { self.inbox.insert(id, row); }
                    None => { self.inbox.remove(&id); }
                }
                self.inbox_changed(window, cx);
                return;
            }
            Event::Issue { slug, row } if self.picked.as_deref() == Some(&slug) => {
                match &row { Some(r) => { self.all.insert(slug.clone(), r.clone()); } None => { self.all.remove(&slug); } }
                if let Some(row) = &row { self.current = row.clone() }
                self.issues.retain(|issue| issue.slug != slug);
                self.issues.extend(row);
            }
            Event::Issue { slug, row } => {
                match &row { Some(r) => { self.all.insert(slug.clone(), r.clone()); } None => { self.all.remove(&slug); } }
                self.issues.retain(|issue| issue.slug != slug);
                self.issues.extend(row);
            }
        }
        if let Some(found) = self.issues.iter().find(|i| Some(&i.slug) == self.picked.as_ref()) { self.current = found.clone() }
        self.issues.retain(|issue| OPEN.contains(&issue.state.as_str()));
        let rank = |s: &str| OPEN.iter().position(|o| *o == s).unwrap_or(OPEN.len());
        self.issues.sort_by(|a, b| rank(&a.state).cmp(&rank(&b.state)).then_with(|| a.title.cmp(&b.title)));
    }

    fn row(&mut self, table: &str, key: String, row: Option<serde_json::Value>) {
        let names = match table { "teams" => Some(&mut self.teams), "projects" => Some(&mut self.projects), _ => None };
        if let Some(names) = names {
            match row.as_ref().and_then(|r| r["title"].as_str()) {
                Some(title) => { names.insert(key.clone(), title.to_string()); }
                None => { names.remove(&key); }
            }
        }
        let rows = self.rows.entry(table.to_string()).or_default();
        match row {
            Some(row) => { rows.insert(key, row); }
            None => { rows.remove(&key); }
        }
    }

    // Whether something other than the window or the Inbox's list holds the keys: a box typed in, the terminal, the
    // Browser's page; the window's own keys then leave them alone, as the web's do while typing.
    fn typing(&self, window: &Window, cx: &App) -> bool {
        window.focused(cx).is_some_and(|f| f != self.focus && f != self.inbox_focus)
    }

    // The issue whose page desk pushes over the sync socket: the one whose page the Inbox shows, else the one picked.
    // desk sends one page per socket, again on each show.
    pub(crate) fn tell_shown(&self, cx: &App) {
        let slug = match &self.inbox_issue {
            Some(page) if self.page == Page::Inbox => Some(page.read(cx).slug.clone()),
            _ => self.picked.clone(),
        };
        if let Some(slug) = slug { let _ = self.shows.try_send(slug); }
    }

    pub(crate) fn open(&mut self, issue: &Issue, window: &mut Window, cx: &mut Context<Self>) {
        let was = self.page;
        self.page = Page::Issue;
        self.session_shown = None;
        if self.picked.as_deref() == Some(&issue.slug) {
            if was != Page::Issue { self.tell_shown(cx) }
            return cx.notify();
        }
        self.picked = Some(issue.slug.clone());
        self.current = self.issues.iter().find(|i| i.slug == issue.slug).cloned().unwrap_or_else(|| issue.clone());
        let slug = issue.slug.clone();
        self.tell_shown(cx);
        self.steps = cx.new(|_| Steps::new());
        let chat = cx.new(|cx| Chat::new(slug.clone(), window, cx));
        let weak = chat.downgrade();
        self.changes = Some(cx.new(|cx| Changes::new(slug, weak, window, cx)));
        self.chat = Some(chat);
        self.commits = None;
        let half = self.half.filter(|h| *h != Half::Terminal && *h != Half::Browser); // the terminal and the tabs were the other chat's
        self.set_half(half, cx);
        give_back(cx); // what the chat left held
        cx.notify();
    }

    // The half shown, or none: Changes reads its diffs only while it shows them, and the terminal stays attached only
    // while it shows, as the web's (tmux keeps the session meanwhile).
    fn set_half(&mut self, half: Option<Half>, cx: &mut Context<Self>) {
        self.half = half;
        if half != Some(Half::Terminal) {
            self.terminal = None;
            self._terminal_events = None;
        }
        // the Browser lets go of its tab, which goes back to its own size
        if half != Some(Half::Browser) {
            self.browser = None;
            self._browser_events = None;
        }
        if let Some(changes) = &self.changes { changes.update(cx, |c, cx| c.show(half == Some(Half::Changes), cx)) }
        cx.notify();
    }

    // The chat's terminal in the half: you opening it starts its session, and the keys go to it.
    fn open_terminal(&mut self, yours: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = self.chat.as_ref().and_then(|c| c.read(cx).session().map(str::to_string)) else { return };
        let term = cx.new(|cx| terminal::Terminal::new(session, yours, window, cx));
        self._terminal_events = Some(cx.subscribe(&term, |desk, _, event: &terminal::TerminalEvent, cx| match event {
            terminal::TerminalEvent::Ended => desk.set_half(None, cx),
        }));
        self.terminal = Some(term);
        self.half = Some(Half::Terminal);
        if let Some(changes) = &self.changes { changes.update(cx, |c, cx| c.show(false, cx)) }
        cx.notify();
    }

    fn session(&self, cx: &App) -> Option<String> {
        self.chat.as_ref().and_then(|c| c.read(cx).session().map(str::to_string))
    }

    // The chat's Browser in the half, on the tab Claude last used or you last picked, else its last.
    fn open_browser(&mut self, cx: &mut Context<Self>) {
        let Some(session) = self.session(cx) else { return };
        let tabs: Vec<sync::Tab> = self.tabs.iter().filter(|t| t.session == session).cloned().collect();
        let picked = self.tab_of.get(&session).cloned();
        match &self.browser {
            Some(browser) => browser.update(cx, |b, cx| {
                b.set_tabs(tabs, cx);
                if let Some(target) = picked { b.show(&target, cx) }
            }),
            None => {
                let browser = cx.new(|cx| browser::Browser::new(tabs, picked, cx));
                self._browser_events = Some(cx.subscribe(&browser, move |desk, _, event: &browser::BrowserEvent, _| match event {
                    browser::BrowserEvent::Picked(target) => { desk.tab_of.insert(session.clone(), target.clone()); }
                }));
                self.browser = Some(browser);
            }
        }
        self.half = Some(Half::Browser);
        self.terminal = None;
        self._terminal_events = None;
        if let Some(changes) = &self.changes { changes.update(cx, |c, cx| c.show(false, cx)) }
        cx.notify();
    }

    fn flip_browser(&mut self, cx: &mut Context<Self>) {
        if self.half == Some(Half::Browser) { self.set_half(None, cx) } else { self.open_browser(cx) }
    }

    // The tabs changed: the Browser shown takes its session's.
    fn tabs_changed(&mut self, cx: &mut Context<Self>) {
        let (Some(browser), Some(session)) = (self.browser.clone(), self.session(cx)) else { return };
        let tabs: Vec<sync::Tab> = self.tabs.iter().filter(|t| t.session == session).cloned().collect();
        browser.update(cx, |b, cx| b.set_tabs(tabs, cx));
    }

    fn flip_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.half == Some(Half::Terminal) { self.set_half(None, cx) } else { self.open_terminal(true, window, cx) }
    }

    fn flip(&mut self, half: Half, cx: &mut Context<Self>) {
        let next = if self.half == Some(half) { None } else { Some(half) };
        self.set_half(next, cx);
    }

    fn side_width(&self) -> f32 {
        if self.side.hidden && self.page != Page::Settings { 16. } else { SIDE }
    }

    // Whether the page can't give the chat its column and the half its room beside it.
    fn one_screen(&self, window: &Window) -> bool {
        window.viewport_size().width.as_f32() - self.side_width() < CHAT + HALF
    }

    // A button of the chat's head that opens a view of the right half: its glyph alone, a circle with no fill until
    // the mouse is on it, filled while its view is open.
    fn half_button(&self, glyph: &'static str, on: bool, cx: &mut Context<Self>) -> Stateful<Div> {
        let theme = cx.theme();
        let (hover, active, muted) = (theme.list_hover, theme.list_active, theme.muted_foreground);
        let strong = theme::text(cx).strong;
        div()
            .id(SharedString::from(format!("half-{glyph}")))
            .flex()
            .items_center()
            .justify_center()
            .size(px(28.))
            .rounded_full()
            .when(on, |b| b.bg(active))
            .when(!on, |b| b.hover(|s| s.bg(hover)))
            .child(theme::glyph(glyph, if on { strong } else { muted }))
    }

    // The chat's head: the issue's status and title, then the buttons that open the right half (desk-ui, The chat): its
    // steps, then, once a step has sent its commit, its Changes; first of them, while the half takes the chat's place,
    // Chat, which brings the chat back.
    fn head(&self, window: &Window, cx: &mut Context<Self>) -> Div {
        let issue = self.current.clone();
        let strong = theme::text(cx).strong;
        let divider = theme::text(cx).divider;
        div()
            .h_flex()
            .flex_none()
            .h(px(44.))
            .px_4()
            .gap_2()
            .border_b_1()
            .border_color(divider)
            .child(theme::state_icon(&issue.state, cx))
            .child(div().flex_1().min_w_0().truncate().font_medium().text_color(strong).child(issue.title.clone()))
            .when(self.one_screen(window), |head| {
                head.child(self.half_button("chat", self.half.is_none(), cx).on_click(cx.listener(|desk, _, _, cx| desk.set_half(None, cx))))
            })
            .when(self.chat.as_ref().is_some_and(|c| c.read(cx).session().is_some()), |head| {
                head.child(self.half_button("terminal", self.half == Some(Half::Terminal), cx).on_click(cx.listener(|desk, _, window, cx| desk.flip_terminal(window, cx))))
                    .child(self.half_button("globe", self.half == Some(Half::Browser), cx).on_click(cx.listener(|desk, _, _, cx| desk.flip_browser(cx))))
            })
            .when(self.page == Page::Issue, |head| {
                head.child(self.half_button("steps", self.half == Some(Half::Steps), cx).on_click(cx.listener(|desk, _, _, cx| desk.flip(Half::Steps, cx))))
            })
            .when(self.commits.as_ref().is_some_and(|c| !c.is_empty()), |head| {
                head.child(self.half_button("changes", self.half == Some(Half::Changes), cx).on_click(cx.listener(|desk, _, _, cx| desk.flip(Half::Changes, cx))))
            })
    }
}

impl Render for Desk {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let (window_bg, page_bg, fg, muted) = (theme.sidebar, theme.background, theme.foreground, theme.muted_foreground);
        let font = theme.font_family.clone();
        let divider = theme::text(cx).divider;
        let border = theme.border;
        let one_screen = self.one_screen(window);
        let page_width = window.viewport_size().width.as_f32() - self.side_width();
        let half: Option<AnyView> = match self.half {
            Some(Half::Steps) => Some(self.steps.clone().into()),
            Some(Half::Changes) => self.changes.clone().map(Into::into),
            Some(Half::Terminal) => self.terminal.clone().map(Into::into),
            Some(Half::Browser) => self.browser.clone().map(Into::into),
            None => None,
        };
        let half_width = if one_screen { page_width } else { page_width - CHAT };
        self.steps.update(cx, |steps, _| steps.width = half_width);
        let page = match &self.chat {
            _ if self.page == Page::Inbox => self.inbox_page(page_width, cx),
            _ if self.page == Page::Settings => div().size_full().children(self.settings.clone()),
            _ if self.page == Page::Soon => div().size_full().flex().items_center().justify_center().text_color(muted).child(format!("{}: a later step of this issue builds it", self.soon)),
            Some(chat) => div()
                .v_flex()
                .size_full()
                .child(self.head(window, cx))
                .child(
                    div()
                        .h_flex()
                        .flex_1()
                        .min_h_0()
                        .when(half.is_none() || !one_screen, |row| {
                            row.child(div().h_full().when(half.is_some(), |c| c.flex_none().w(px(CHAT))).when(half.is_none(), |c| c.flex_1().min_w_0()).child(chat.clone()))
                        })
                        .when_some(half, |row, half| {
                            row.child(div().flex_1().min_w_0().h_full().when(!one_screen, |h| h.border_l_1().border_color(divider)).child(half))
                        }),
                ),
            None => div().size_full().flex().items_center().justify_center().text_color(muted).child("Pick an issue"),
        };
        let chat_page = self.page == Page::Issue || self.page == Page::Session;
        div()
            .h_flex()
            .size_full()
            .track_focus(&self.focus)
            // Ctrl , Settings, as the web app's; and the half's: Ctrl ` its terminal, Ctrl Shift S its steps, Ctrl Shift G
            // its Changes, Ctrl Shift B its Browser. While nothing types: [ hides or shows the sidebar, and P, R and
            // Delete act on the sidebar's chat under the mouse.
            .on_key_down(cx.listener(move |desk, e: &KeyDownEvent, window, cx| {
                let k = &e.keystroke;
                if !desk.typing(window, cx) {
                    let bare = !(k.modifiers.control || k.modifiers.alt || k.modifiers.platform);
                    if bare && k.key == "[" {
                        desk.toggle_side(cx);
                        return cx.stop_propagation();
                    }
                    if desk.chat_key(e, window, cx) { return cx.stop_propagation() }
                }
                if k.modifiers.control && !k.modifiers.shift && !k.modifiers.alt && k.key == "," {
                    desk.open_settings(settings::Section::Preferences, cx);
                    return cx.stop_propagation();
                }
                if k.modifiers.control && !k.modifiers.shift && !k.modifiers.alt && k.key == "`" && desk.chat.is_some() && chat_page {
                    desk.flip_terminal(window, cx);
                    return cx.stop_propagation();
                }
                if !(k.modifiers.control && k.modifiers.shift) || k.modifiers.alt || desk.chat.is_none() || !chat_page { return }
                match k.key.to_lowercase().as_str() {
                    "s" if desk.page == Page::Issue => desk.flip(Half::Steps, cx),
                    "b" if desk.session(cx).is_some() => desk.flip_browser(cx),
                    "g" if desk.commits.as_ref().is_some_and(|c| !c.is_empty()) => desk.flip(Half::Changes, cx),
                    _ => return,
                }
                cx.stop_propagation();
            }))
            .font_family(font)
            .text_size(px(13.))
            .bg(window_bg)
            .text_color(fg)
            .when(self.page == Page::Settings, |w| w.child(self.settings_nav(cx)))
            .when(self.page != Page::Settings && !self.side.hidden, |w| w.child(self.sidebar(cx)))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .py_2()
                    .pr_2()
                    .when(self.side.hidden && self.page != Page::Settings, |p| p.pl_2())
                    .child(div().size_full().rounded(px(8.)).border_1().border_color(border).bg(page_bg).overflow_hidden().child(page)),
            )
            .children({
                let composer = self.chat.as_ref().filter(|_| chat_page).and_then(|c| c.read(cx).composer_at.get());
                toast::render(composer, window, cx)
            })
    }
}

// glibc keeps what a thread frees in that thread's own arena, a block of up to 64 MB, for that thread to take again:
// with GPUI's workers and a thread per socket, the window held 20 MB freed at start and more with each chat opened
// (step 5.10). Two arenas keep what is freed where any thread takes it again, and a trim a moment after a big change
// gives the rest back to the system.
// Where the window keeps what it keeps between runs, as the web keeps it in localStorage: ~/.local/state/desk.
pub(crate) fn state_dir() -> Option<std::path::PathBuf> {
    let state = std::env::var_os("XDG_STATE_HOME").map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".local/state")))?;
    Some(state.join("desk"))
}

fn arenas() {
    unsafe { libc::mallopt(libc::M_ARENA_MAX, 2) };
}

pub(crate) fn give_back(cx: &mut App) {
    cx.background_spawn(async {
        smol::Timer::after(std::time::Duration::from_secs(2)).await;
        unsafe { libc::malloc_trim(0) };
    })
    .detach();
}

fn main() {
    arenas();
    gpui_kit::application().with_assets(theme::Assets).run(move |cx| {
        gpui_kit::init(cx);
        let options = WindowOptions { app_id: Some("desk-native".into()), ..Default::default() };
        // `desk <slug>` opens on that issue's chat.
        let slug = std::env::args().nth(1);
        gpui_kit::open_window(options, cx, |window, cx| {
            theme::init(window, cx);
            cx.new(|cx| {
                let mut desk = Desk::new(window, cx);
                // `desk inbox [row]` opens on the Inbox, and on one of its rows
                match slug.as_deref() {
                    Some("inbox") => {
                        desk.show_inbox(window, cx);
                        desk.pending_row = std::env::args().nth(2);
                    }
                    Some(slug) => desk.open(&Issue { slug: slug.to_string(), ..Issue::default() }, window, cx),
                    None => {}
                }
                desk
            })
        })
        .expect("open the window");
    });
}
