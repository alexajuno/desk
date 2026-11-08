// desk's window, native: GPUI (Zed's toolkit) with gpui-component, on desk's Node server, which it reads as the page
// does (desk issue "Rebuild desk as a native Rust app like Zed, off Electron"). It copies the web app's frame, which
// copies Linear's: the open issues down the left, directly on the window's background, and the page beside them, one
// panel floating a few pixels in, with the picked issue's chat and, when its head's buttons say so, its right half: its
// steps, its Changes, its terminal or its Browser.
mod browser;
mod changes;
mod chat;
mod hyprland;
mod command;
mod creator;
mod inbox;
mod issue;
mod emoji;
mod filters;
mod listing;
mod lists;
mod picker;
mod search;
mod notify;
mod statusbar;
mod tip;
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
    List, // My issues, or a team's Issues (lists.rs)
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
    focus: FocusHandle,                // the window's own, which holds the keys while nothing types
    teams: HashMap<String, String>,    // a team's name by its slug, for the Inbox's filters
    projects: HashMap<String, String>, // a project's name by its slug
    inbox_view: listing::View,         // Filter, Display options and Show unreads only
    inbox_popups: filters::Popups,
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
    search: Option<(Entity<search::Search>, Option<FocusHandle>, Subscription)>, // the search box while open, what had the keys before it
    notes: notify::Notes, // the Inbox's desktop notifications
    titled: String,       // the window's title, as the web's page title: what it shows, then desk
    seat: Option<serde_json::Value>, // seat's Claude profiles, as the server last read them, for the status bar
    tips: Entity<gpui_kit::base::TooltipOverlay>, // the one tip shown, over everything (tip.rs)
    list: Option<(Entity<lists::IssueList>, Subscription)>, // the issue list shown last, My issues' or a team's
    creator: Option<(Entity<creator::Creator>, Option<FocusHandle>, Subscription)>, // New issue, and what had the keys
    command: Option<(Entity<command::Command>, Option<FocusHandle>, Subscription)>, // O then T, P or I
    field_pick: Option<(Entity<picker::Picker>, &'static str, Option<FocusHandle>, Subscription)>, // S or P on a chat's issue: the status's or priority's menu
    o_pressed: Option<std::time::Instant>,
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
        search::load(cx); // the chats' titles, so that the first / finds them at once
        Desk::watch_seat(cx);
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
            focus: cx.focus_handle(),
            teams: HashMap::new(),
            projects: HashMap::new(),
            inbox_view: listing::View::load(),
            inbox_popups: Default::default(),
            anchors: Default::default(),
            stay: inbox::Stay::new(),
            hovered_row: None,
            reading: Default::default(),
            notice: None,
            inbox_focus: cx.focus_handle(),
            inbox_scroll: UniformListScrollHandle::new(),
            issues: Vec::new(), picked: None, current: Issue::default(), chat: None, steps: cx.new(|_| Steps::new()), changes: None, half, terminal: None, _terminal_events: None, tabs: Vec::new(), browser: None, tab_of: HashMap::new(), _browser_events: None, commits: None, shows, settings: None, back_to: Page::Issue, search: None, notes: notify::Notes::start(window, cx), titled: String::new(), seat: None, tips: tip::install(cx), list: None, creator: None, command: None, field_pick: None, o_pressed: None, _appearance: appearance }
    }

    fn apply(&mut self, event: Event, window: &mut Window, cx: &mut Context<Self>) {
        // an issue changed: the list shown is drawn again
        if matches!(event, Event::Issue { .. }) && self.page == Page::List {
            if let Some((list, _)) = &self.list { list.update(cx, |l, cx| l.refresh(cx)) }
        }
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

    // Whether something other than the window, the Inbox's list or an issue list holds the keys: a box typed in, the
    // terminal, the Browser's page; the window's own keys then leave them alone, as the web's do while typing.
    fn typing(&self, window: &Window, cx: &App) -> bool {
        let list = self.list.as_ref().map(|(l, _)| l.read(cx).focus.clone());
        window.focused(cx).is_some_and(|f| f != self.focus && f != self.inbox_focus && Some(&f) != list.as_ref())
    }

    // Linear's O then T, P or I: a team, a project or an issue, from its command menu.
    pub(crate) fn open_command(&mut self, kind: command::Kind, window: &mut Window, cx: &mut Context<Self>) {
        if self.command.is_some() || self.search.is_some() { return }
        let text = |r: &serde_json::Value, k: &str| r[k].as_str().unwrap_or("").to_string();
        let sources = command::Sources {
            teams: self.active_teams().iter().map(|t| (text(t, "slug"), text(t, "title"))).collect(),
            projects: self.rows.get("projects").into_iter().flatten().map(|(k, p)| (k.clone(), text(p, "title"), text(p, "status"))).collect(),
            issues: self.issues.clone(),
            here: (self.page == Page::Issue).then(|| self.current.clone()),
        };
        let back = window.focused(cx);
        let open = cx.new(|cx| command::Command::new(kind, sources, window, cx));
        let events = cx.subscribe_in(&open, window, |desk, _, event: &command::CommandEvent, window, cx| {
            let Some((_, back, _)) = desk.command.take() else { return };
            match event {
                command::CommandEvent::Open(row) => match row.kind {
                    command::Kind::Team => desk.open_list("", Some(row.slug.clone()), window, cx),
                    command::Kind::Project => desk.open_web(&format!("project/{}", row.slug), cx),
                    command::Kind::Issue => {
                        let issue = desk.all.get(&row.slug).cloned().unwrap_or_else(|| Issue { slug: row.slug.clone(), ..Default::default() });
                        desk.open(&issue, window, cx);
                    }
                },
                command::CommandEvent::Closed => if let Some(back) = back { window.focus(&back, cx) } else { window.focus(&desk.focus, cx) },
            }
            cx.notify();
        });
        self.command = Some((open, back, events));
        cx.notify();
    }

    // S or P in an issue's chat: its status's or priority's menu under the head, as the issue page's.
    pub(crate) fn open_field(&mut self, field: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        if self.field_pick.is_some() || self.page != Page::Issue || self.current.slug.is_empty() { return }
        let current = if field == "state" { self.current.state.clone() } else { self.current.priority.clone() };
        let back = window.focused(cx);
        let at = Bounds::new(point(px(self.side_width() + 16.), px(44.)), size(px(1.), px(1.)));
        let open = cx.new(|cx| picker::Picker::new(issue::field_choices(field, &current), at, window, cx));
        let slug = self.current.slug.clone();
        let events = cx.subscribe_in(&open, window, move |desk, _, event: &picker::PickerEvent, window, cx| {
            if let Some((_, _, back, _)) = desk.field_pick.take() {
                if let Some(back) = back { window.focus(&back, cx) } else { window.focus(&desk.focus, cx) }
            }
            if let picker::PickerEvent::Picked(value) = event {
                if value != &current {
                    let (path, body) = (format!("/issue/{slug}/set"), serde_json::json!({"field": field, "value": value}));
                    cx.background_spawn(async move { let _ = net::post(&path, body); }).detach();
                }
            }
            cx.notify();
        });
        self.field_pick = Some((open, field, back, events));
        cx.notify();
    }

    // New issue, with what its opener says: a team, a group's status or priority, or the parent of a sub-issue.
    pub(crate) fn new_issue(&mut self, mut preset: serde_json::Value, window: &mut Window, cx: &mut Context<Self>) {
        if self.creator.is_some() { return }
        for (k, names) in [("team", &self.teams), ("project", &self.projects)] {
            let title = preset[k].as_str().and_then(|v| names.get(v)).cloned();
            if let (Some(t), Some(o)) = (title, preset.as_object_mut()) { o.entry(format!("{k}Title")).or_insert(t.into()); }
        }
        let back = window.focused(cx);
        let open = cx.new(|cx| creator::Creator::new(&preset, window, cx));
        let this = cx.entity().downgrade();
        let events = cx.subscribe_in(&open, window, move |desk, _, event: &creator::CreatorEvent, window, cx| match event {
            creator::CreatorEvent::Made { slug, sub } => {
                let (this, slug) = (this.clone(), slug.clone());
                let view: toast::Run = std::rc::Rc::new(move |window, cx| {
                    let issue = Issue { slug: slug.clone(), ..Default::default() };
                    let _ = this.update(cx, |desk, cx| desk.open(&issue, window, cx));
                });
                toast::show(if *sub { "Sub-issue created" } else { "Issue created" }, Some(("View issue", view)), cx);
            }
            creator::CreatorEvent::Closed => {
                if let Some((_, back, _)) = desk.creator.take() {
                    if let Some(back) = back { window.focus(&back, cx) } else { window.focus(&desk.focus, cx) }
                }
                cx.notify();
            }
        });
        self.creator = Some((open, back, events));
        cx.notify();
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
        command::note_visit("issue", &issue.slug);
        self.current = self.issues.iter().find(|i| i.slug == issue.slug).cloned().unwrap_or_else(|| issue.clone());
        let slug = issue.slug.clone();
        self.tell_shown(cx);
        self.steps = cx.new(|_| Steps::new());
        let chat = cx.new(|cx| {
            let mut chat = Chat::new(slug.clone(), window, cx);
            chat.wants_focus = true;
            chat
        });
        let weak = chat.downgrade();
        self.changes = Some(cx.new(|cx| Changes::new(slug, weak, window, cx)));
        self.chat = Some(chat);
        self.commits = None;
        let half = self.half.filter(|h| *h != Half::Terminal && *h != Half::Browser); // the terminal and the tabs were the other chat's
        self.set_half(half, cx);
        give_back(cx); // what the chat left held
        cx.notify();
    }

    // The search box, over the page you are on: / and the sidebar's Search open it on Chats with nothing typed.
    pub(crate) fn open_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some((open, _, _)) = &self.search {
            let open = open.clone();
            return open.update(cx, |s, cx| s.focus(window, cx));
        }
        let back = window.focused(cx);
        let states = self.all.iter().map(|(slug, i)| (slug.clone(), i.state.clone())).collect();
        let open = cx.new(|cx| search::Search::new(states, window, cx));
        let events = cx.subscribe_in(&open, window, |desk, _, event: &search::SearchEvent, window, cx| match event {
            search::SearchEvent::Open(hit) => {
                let hit = hit.clone();
                desk.close_search(false, window, cx);
                desk.open_hit(&hit, window, cx);
            }
            search::SearchEvent::Closed => desk.close_search(true, window, cx),
        });
        self.search = Some((open, back, events));
        cx.notify();
    }

    // Esc or a click outside leaves you where you were; a hit opened takes you where it lives.
    fn close_search(&mut self, back: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some((open, had, _)) = self.search.take() else { return };
        open.read(cx).tell(cx);
        match had.filter(|_| back) {
            Some(had) => window.focus(&had, cx),
            None => window.focus(&self.focus, cx),
        }
        cx.notify();
    }

    // Where a hit opens: a chat in its issue's place, or its own; an issue's chat; a setting's page. Projects, teams and
    // milestones have pages of their own in a later step.
    fn open_hit(&mut self, hit: &serde_json::Value, window: &mut Window, cx: &mut Context<Self>) {
        let at = |v: &serde_json::Value, key: &str| v[key].as_str().unwrap_or("").to_string();
        let issue = |desk: &Desk, slug: String| desk.all.get(&slug).cloned().unwrap_or(Issue { slug, ..Issue::default() });
        match hit["kind"].as_str().unwrap_or("") {
            "chat" if hit["issue"]["slug"].is_string() => { let i = issue(self, at(&hit["issue"], "slug")); self.open(&i, window, cx) }
            "chat" => self.open_session(&at(hit, "session"), window, cx),
            "issue" => { let i = issue(self, at(&hit["issue"], "slug")); self.open(&i, window, cx) }
            "project" => self.open_web(&format!("project/{}", at(&hit["project"], "slug")), cx),
            "team" => self.open_web(&format!("team/{}", at(&hit["team"], "slug")), cx),
            "milestone" => self.open_web(&format!("project/{}/issues", at(&hit["project"], "slug")), cx),
            _ => self.open_settings(if at(hit, "page") == "workflow" { settings::Section::Workflow } else { settings::Section::Preferences }, cx),
        }
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
        let muted = cx.theme().muted_foreground;
        // A chat with no issue goes by the title desk gives it, with no status, and shows the folder it runs in, as the
        // web's head does.
        let session_chat = self.chat.as_ref().filter(|_| self.page == Page::Session).map(|c| c.read(cx));
        let title = session_chat.and_then(|c| c.title()).unwrap_or(issue.title.clone());
        let folder = session_chat.map(|c| c.starts_in()).filter(|f| !f.is_empty());
        div()
            .h_flex()
            .flex_none()
            .h(px(44.))
            .px_4()
            .gap_2()
            .border_b_1()
            .border_color(divider)
            .when(self.page != Page::Session, |head| {
                head.child(
                    div().id("head-state").cursor_pointer().child(theme::state_icon(&issue.state, cx))
                        .on_click(cx.listener(|desk, _, window, cx| desk.open_field("state", window, cx))),
                )
            })
            .child(
                div().h_flex().flex_1().min_w_0().gap_2()
                    .child(
                        div().id("head-title").min_w_0().truncate().font_medium().text_color(strong).child(title)
                            // a chat with no issue is renamed in its title, as the web's
                            .when_some(self.session_shown.clone().filter(|_| self.page == Page::Session), |t, session| {
                                t.cursor(CursorStyle::IBeam).on_click(cx.listener(move |desk, _, window, cx| desk.rename_chat(&session, window, cx)))
                            })
                            // an issue's chat: its title opens the issue's page, which the window shows in the browser
                            .when(self.page == Page::Issue && !issue.slug.is_empty(), |t| {
                                let slug = issue.slug.clone();
                                t.cursor_pointer().on_click(cx.listener(move |desk, _, _, cx| desk.open_web(&format!("issue/{slug}"), cx)))
                            }),
                    )
                    .when_some(folder, |row, folder| row.child(div().flex_none().max_w(relative(0.4)).truncate().text_xs().text_color(muted).child(folder))),
            )
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

impl Desk {
    // The window's title, as the web's page titles: the issue, the chat, the Inbox or the settings page, then desk. The
    // bar shows it, and a clicked notification finds the window by it (notify.rs).
    fn window_title(&self, cx: &App) -> String {
        let name = match self.page {
            Page::Issue => Some(self.current.title.clone()),
            Page::Session => self.chat.as_ref().and_then(|c| c.read(cx).title()),
            Page::Inbox => Some("Inbox".into()),
            Page::Settings => self.settings.as_ref().map(|s| s.read(cx).section.title().into()),
            Page::List => self.list.as_ref().map(|(l, _)| l.read(cx).title()),
        };
        name.filter(|n| !n.is_empty()).map_or_else(|| "desk".into(), |n| format!("{n} · desk"))
    }
}

impl Render for Desk {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let title = self.window_title(cx);
        if title != self.titled {
            window.set_window_title(&title);
            self.titled = title;
        }
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
            _ if self.page == Page::List => div().size_full().children(self.list.as_ref().map(|(l, _)| l.clone())),
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
        // With nothing focused, keys go to the window's root and pass this view by: the window holds them itself, as a
        // chat opens to read and Esc leaves a composer.
        if window.focused(cx).is_none() {
            cx.defer_in(window, |desk, window, cx| if window.focused(cx).is_none() { window.focus(&desk.focus, cx) });
        }
        div()
            .flex()
            .flex_col()
            .size_full()
            .track_focus(&self.focus)
            // Ctrl Shift O a new chat; Ctrl , Settings, as the web app's; and the half's: Ctrl ` its terminal, Ctrl Shift S
            // its steps, Ctrl Shift G its Changes, Ctrl Shift B its Browser. While nothing types: [ hides or shows the
            // sidebar, P, R and Delete act on the sidebar's chat under the mouse, and Enter or I goes into the composer.
            .on_key_down(cx.listener(move |desk, e: &KeyDownEvent, window, cx| {
                let k = &e.keystroke;
                // Ctrl Shift O, a new chat, from anywhere, a box typed in too
                if k.modifiers.control && k.modifiers.shift && !k.modifiers.alt && k.key.eq_ignore_ascii_case("o") {
                    desk.new_chat(window, cx);
                    return cx.stop_propagation();
                }
                if !desk.typing(window, cx) {
                    let bare = !(k.modifiers.control || k.modifiers.alt || k.modifiers.platform);
                    if bare && k.key == "[" {
                        desk.toggle_side(cx);
                        return cx.stop_propagation();
                    }
                    if bare && k.key == "/" {
                        desk.open_search(window, cx);
                        return cx.stop_propagation();
                    }
                    // O then T, P or I, within a second and a half
                    let then = desk.o_pressed.take().filter(|at| at.elapsed() < std::time::Duration::from_millis(1500));
                    if then.is_some() && bare && !k.modifiers.shift {
                        let kind = match k.key.as_str() { "t" => Some(command::Kind::Team), "p" => Some(command::Kind::Project), "i" => Some(command::Kind::Issue), _ => None };
                        if let Some(kind) = kind {
                            desk.open_command(kind, window, cx);
                            return cx.stop_propagation();
                        }
                    }
                    if bare && !k.modifiers.shift && k.key == "o" {
                        desk.o_pressed = Some(std::time::Instant::now());
                        return cx.stop_propagation();
                    }
                    if desk.chat_key(e, window, cx) { return cx.stop_propagation() }
                    // S or P in an issue's chat: its status or priority
                    if bare && !k.modifiers.shift && desk.page == Page::Issue && (k.key == "s" || k.key == "p") {
                        desk.open_field(if k.key == "s" { "state" } else { "priority" }, window, cx);
                        return cx.stop_propagation();
                    }
                    // C, a new issue, in the team whose list this is, as Linear's C does in a team's views
                    if bare && !k.modifiers.shift && k.key == "c" {
                        let team = desk.list.as_ref().filter(|_| desk.page == Page::List).and_then(|(l, _)| l.read(cx).team.clone());
                        desk.new_issue(team.map_or_else(|| serde_json::json!({}), |t| serde_json::json!({"team": t})), window, cx);
                        return cx.stop_propagation();
                    }
                    // Enter, or I as vim's insert, in a chat opened to read: into its composer
                    if bare && chat_page && !k.modifiers.shift && (k.key == "enter" || k.key == "i") {
                        if let Some(chat) = &desk.chat { chat.update(cx, |c, cx| c.focus_composer(window, cx)) }
                        return cx.stop_propagation();
                    }
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
            .child(
                div()
                    .h_flex()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .when(self.page == Page::Settings, |w| w.child(self.settings_nav(cx)))
                    .when(self.page != Page::Settings && !self.side.hidden, |w| w.child(self.sidebar(cx)))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .h_full()
                            .pt_2()
                            .pr_2()
                            .when(self.side.hidden && self.page != Page::Settings, |p| p.pl_2())
                            .child(div().size_full().rounded(px(8.)).border_1().border_color(border).bg(page_bg).overflow_hidden().child(page)),
                    ),
            )
            // the bar along the window's bottom, under the sidebar and the page
            .child(self.status_bar(cx))
            .child(self.tips.clone())
            .children(self.creator.as_ref().map(|(open, _, _)| deferred(open.clone()).with_priority(4)))
            .children(self.field_pick.as_ref().map(|(open, _, _, _)| deferred(div().absolute().top(px(44.)).left(px(self.side_width() + 16.)).child(open.clone())).with_priority(3)))
            .children(self.command.as_ref().map(|(open, _, _)| {
                let top = window.viewport_size().height * 0.13;
                deferred(div().absolute().top_0().left_0().size_full().flex().justify_center().pt(top).child(open.clone())).with_priority(3)
            }))
            .children(self.search.as_ref().map(|(open, _, _)| {
                let top = window.viewport_size().height * 0.13;
                deferred(div().absolute().top_0().left_0().size_full().flex().justify_center().pt(top).child(open.clone())).with_priority(3)
            }))
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
        // `desk --hidden`, as desk-app.service starts it at login, opens hidden, with no focus taken
        let hidden = std::env::args().any(|a| a == "--hidden");
        let args: Vec<String> = std::env::args().skip(1).filter(|a| !a.starts_with("--")).collect();
        // a test's window runs with DESK_APP_ID=desk-native-test, so that the Hyprland rule placing it never catches yours
        // (8 Nov: one left in Hyprland floated the real window at the test's size)
        let app_id = std::env::var("DESK_APP_ID").unwrap_or_else(|_| "desk-native".into());
        let options = WindowOptions { app_id: Some(app_id), focus: !hidden, ..Default::default() };
        // `desk <slug>` opens on that issue's chat.
        let slug = args.first().cloned();
        gpui_kit::open_window(options, cx, |window, cx| {
            theme::init(window, cx);
            // closing hides it, as Electron's did, so that the Inbox's pop-ups keep coming; it quits only with its
            // service (systemctl --user stop desk-app)
            window.on_window_should_close(cx, |_, cx| {
                cx.background_spawn(async { hyprland::hide() }).detach();
                false
            });
            if hidden { cx.background_spawn(async { hyprland::start_hidden() }).detach(); }
            cx.new(|cx| {
                let mut desk = Desk::new(window, cx);
                // `desk inbox [row]` opens on the Inbox, and on one of its rows
                match slug.as_deref() {
                    Some("inbox") => {
                        desk.show_inbox(window, cx);
                        desk.pending_row = args.get(1).cloned();
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
