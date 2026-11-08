// desk's window, native: GPUI (Zed's toolkit) with gpui-component, on desk's Node server, which it reads as the page
// does (desk issue "Rebuild desk as a native Rust app like Zed, off Electron"). It copies the web app's frame, which
// copies Linear's: the open issues down the left, directly on the window's background, and the page beside them, one
// panel floating a few pixels in, with the picked issue's chat and, when its head's buttons say so, its right half: its
// steps or its Changes.
mod changes;
mod chat;
mod live;
mod net;
mod steps;
mod sync;
mod theme;

use changes::Changes;
use chat::Chat;
use gpui_kit::base::StyledExt;
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use steps::Steps;
use sync::{Event, Issue};

const OPEN: [&str; 5] = ["triage", "running", "review", "waiting", "backlog"];

// The chat is a column this wide beside its right half, and the half takes the rest; where the page can't give the half
// HALF beside it, the half takes the chat's place under the chat's head, one screen at a time (the web app's
// frame/oneScreen.ts). SIDE is the sidebar and the page's margin.
const CHAT: f32 = 480.;
const HALF: f32 = 780.;
const SIDE: f32 = 248.;

// What the right half shows.
#[derive(Clone, Copy, PartialEq)]
enum Half {
    Steps,
    Changes,
}

struct Desk {
    issues: Vec<Issue>,
    picked: Option<String>,
    current: Issue, // the picked issue as last heard, open or closed, for the chat's head
    chat: Option<Entity<Chat>>,
    steps: Entity<Steps>,
    changes: Option<Entity<Changes>>,
    half: Option<Half>,
    commits: Option<Vec<String>>, // the picked issue's steps' commits, once its page came
    shows: smol::channel::Sender<String>,
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
        Self { issues: Vec::new(), picked: None, current: Issue::default(), chat: None, steps: cx.new(|_| Steps::new()), changes: None, half, commits: None, shows, _appearance: appearance }
    }

    fn apply(&mut self, event: Event, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            Event::Page { slug, page } => {
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
            Event::Snapshot(issues) => self.issues = issues,
            Event::Issue { slug, row } if self.picked.as_deref() == Some(&slug) => {
                if let Some(row) = &row { self.current = row.clone() }
                self.issues.retain(|issue| issue.slug != slug);
                self.issues.extend(row);
            }
            Event::Issue { slug, row } => {
                self.issues.retain(|issue| issue.slug != slug);
                self.issues.extend(row);
            }
        }
        if let Some(found) = self.issues.iter().find(|i| Some(&i.slug) == self.picked.as_ref()) { self.current = found.clone() }
        self.issues.retain(|issue| OPEN.contains(&issue.state.as_str()));
        let rank = |s: &str| OPEN.iter().position(|o| *o == s).unwrap_or(OPEN.len());
        self.issues.sort_by(|a, b| rank(&a.state).cmp(&rank(&b.state)).then_with(|| a.title.cmp(&b.title)));
    }

    fn open(&mut self, issue: &Issue, window: &mut Window, cx: &mut Context<Self>) {
        if self.picked.as_deref() == Some(&issue.slug) { return }
        self.picked = Some(issue.slug.clone());
        self.current = self.issues.iter().find(|i| i.slug == issue.slug).cloned().unwrap_or_else(|| issue.clone());
        let slug = issue.slug.clone();
        let _ = self.shows.try_send(slug.clone());
        self.steps = cx.new(|_| Steps::new());
        let chat = cx.new(|cx| Chat::new(slug.clone(), window, cx));
        let weak = chat.downgrade();
        self.changes = Some(cx.new(|cx| Changes::new(slug, weak, window, cx)));
        self.chat = Some(chat);
        self.commits = None;
        let half = self.half;
        self.set_half(half, cx);
        cx.notify();
    }

    // The half shown, or none: Changes reads its diffs only while it shows them.
    fn set_half(&mut self, half: Option<Half>, cx: &mut Context<Self>) {
        self.half = half;
        if let Some(changes) = &self.changes { changes.update(cx, |c, cx| c.show(half == Some(Half::Changes), cx)) }
        cx.notify();
    }

    fn flip(&mut self, half: Half, cx: &mut Context<Self>) {
        let next = if self.half == Some(half) { None } else { Some(half) };
        self.set_half(next, cx);
    }

    // Whether the page can't give the chat its column and the half its room beside it.
    fn one_screen(&self, window: &Window) -> bool {
        window.viewport_size().width.as_f32() - SIDE < CHAT + HALF
    }

    fn sidebar(&self, cx: &mut Context<Self>) -> Div {
        let issues = self.issues.clone();
        let picked = self.picked.clone();
        let this = cx.entity().downgrade();
        let theme = cx.theme();
        let (hover, active, muted) = (theme.list_hover, theme.list_active, theme.muted_foreground);
        let strong = theme::text(cx).strong;
        let rows = uniform_list("issues", issues.len(), move |range, _, cx| {
            range
                .map(|i| {
                    let issue = issues[i].clone();
                    let this = this.clone();
                    let on = picked.as_deref() == Some(&issue.slug);
                    div()
                        .id(("issue", i))
                        .h(px(30.))
                        .px_2()
                        .child(
                            div()
                                .h_flex()
                                .size_full()
                                .gap_2()
                                .px_2()
                                .rounded_md()
                                .when(on, |row| row.bg(active).text_color(strong))
                                .when(!on, |row| row.hover(|s| s.bg(hover)))
                                .child(theme::state_icon(&issue.state, cx))
                                .child(div().flex_1().min_w_0().truncate().child(issue.title.clone())),
                        )
                        .on_click(move |_, window, cx| {
                            let _ = this.update(cx, |desk, cx| desk.open(&issue, window, cx));
                        })
                })
                .collect()
        })
        .flex_1();
        div()
            .v_flex()
            .flex_none()
            .w(px(240.))
            .h_full()
            .pt_3()
            .child(div().px_4().pb_1().text_xs().font_medium().text_color(muted).child(format!("Issues · {}", self.issues.len())))
            .child(rows)
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
            .child(self.half_button("steps", self.half == Some(Half::Steps), cx).on_click(cx.listener(|desk, _, _, cx| desk.flip(Half::Steps, cx))))
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
        let page_width = window.viewport_size().width.as_f32() - SIDE;
        let half: Option<AnyView> = match self.half {
            Some(Half::Steps) => Some(self.steps.clone().into()),
            Some(Half::Changes) => self.changes.clone().map(Into::into),
            None => None,
        };
        let half_width = if one_screen { page_width } else { page_width - CHAT };
        self.steps.update(cx, |steps, _| steps.width = half_width);
        let page = match &self.chat {
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
        div()
            .h_flex()
            .size_full()
            // the half's keys, as the web app's: Ctrl Shift S its steps, Ctrl Shift G its Changes
            .on_key_down(cx.listener(|desk, e: &KeyDownEvent, _, cx| {
                let k = &e.keystroke;
                if !(k.modifiers.control && k.modifiers.shift) || k.modifiers.alt || desk.chat.is_none() { return }
                match k.key.to_lowercase().as_str() {
                    "s" => desk.flip(Half::Steps, cx),
                    "g" if desk.commits.as_ref().is_some_and(|c| !c.is_empty()) => desk.flip(Half::Changes, cx),
                    _ => return,
                }
                cx.stop_propagation();
            }))
            .font_family(font)
            .text_size(px(13.))
            .bg(window_bg)
            .text_color(fg)
            .child(self.sidebar(cx))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .py_2()
                    .pr_2()
                    .child(div().size_full().rounded(px(8.)).border_1().border_color(border).bg(page_bg).overflow_hidden().child(page)),
            )
    }
}

fn main() {
    gpui_kit::application().with_assets(theme::Assets).run(move |cx| {
        gpui_kit::init(cx);
        let options = WindowOptions { app_id: Some("desk-native".into()), ..Default::default() };
        // `desk <slug>` opens on that issue's chat.
        let slug = std::env::args().nth(1);
        gpui_kit::open_window(options, cx, |window, cx| {
            theme::init(window, cx);
            cx.new(|cx| {
                let mut desk = Desk::new(window, cx);
                if let Some(slug) = slug {
                    desk.open(&Issue { slug, ..Issue::default() }, window, cx);
                }
                desk
            })
        })
        .expect("open the window");
    });
}
