// desk's window, native: GPUI (Zed's toolkit) with gpui-component, on desk's Node server, which it reads as the page
// does (desk issue "Rebuild desk as a native Rust app like Zed, off Electron"). It copies the web app's frame, which
// copies Linear's: the open issues down the left, directly on the window's background, and the page beside them, one
// panel floating a few pixels in, with the picked issue's chat and, when its head's button says so, its steps.
mod chat;
mod live;
mod net;
mod steps;
mod sync;
mod theme;

use chat::Chat;
use gpui_kit::base::StyledExt;
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use steps::Steps;
use sync::{Event, Issue};

const OPEN: [&str; 5] = ["triage", "running", "review", "waiting", "backlog"];

struct Desk {
    issues: Vec<Issue>,
    picked: Option<String>,
    current: Issue, // the picked issue as last heard, open or closed, for the chat's head
    chat: Option<Entity<Chat>>,
    steps: Entity<Steps>,
    steps_open: bool,
    shows: smol::channel::Sender<String>,
    _appearance: Subscription,
}

impl Desk {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (send, events) = smol::channel::unbounded();
        let (shows, shown) = smol::channel::unbounded();
        sync::start(send, shown);
        cx.spawn(async move |this, cx| {
            while let Ok(event) = events.recv().await {
                if this.update(cx, |desk, cx| { desk.apply(event, cx); cx.notify() }).is_err() { break }
            }
        })
        .detach();
        // The system's light or dark, as the web app follows it.
        let appearance = cx.observe_window_appearance(window, |_, window, cx| theme::sync(window, cx));
        Self { issues: Vec::new(), picked: None, current: Issue::default(), chat: None, steps: cx.new(|_| Steps::new()), steps_open: std::env::var("DESK_HALF").as_deref() == Ok("steps"), shows, _appearance: appearance }
    }

    fn apply(&mut self, event: Event, cx: &mut Context<Self>) {
        match event {
            Event::Page { slug, page } => {
                if self.picked.as_deref() == Some(&slug) {
                    self.steps.update(cx, |steps, cx| steps.set(&page, cx));
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
        self.chat = Some(cx.new(|cx| Chat::new(slug, window, cx)));
        cx.notify();
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
    fn half_button(&self, glyph: &str, on: bool, cx: &mut Context<Self>) -> Stateful<Div> {
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

    // The chat's head: the issue's status and title, then the buttons that open the right half (desk-ui, The chat).
    fn head(&self, cx: &mut Context<Self>) -> Div {
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
            .child(self.half_button("steps", self.steps_open, cx).on_click(cx.listener(|desk, _, _, cx| {
                desk.steps_open = !desk.steps_open;
                cx.notify()
            })))
    }
}

impl Render for Desk {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let (window_bg, page_bg, fg, muted) = (theme.sidebar, theme.background, theme.foreground, theme.muted_foreground);
        let font = theme.font_family.clone();
        let divider = theme::text(cx).divider;
        let border = theme.border;
        let page = match &self.chat {
            Some(chat) => div()
                .v_flex()
                .size_full()
                .child(self.head(cx))
                .child(
                    div()
                        .h_flex()
                        .flex_1()
                        .min_h_0()
                        .child(div().flex_1().min_w_0().h_full().child(chat.clone()))
                        .when(self.steps_open, |row| {
                            row.child(div().flex_none().w(px(steps::HALF)).h_full().border_l_1().border_color(divider).child(self.steps.clone()))
                        }),
                ),
            None => div().size_full().flex().items_center().justify_center().text_color(muted).child("Pick an issue"),
        };
        div()
            .h_flex()
            .size_full()
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
