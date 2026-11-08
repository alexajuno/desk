// desk's window, native: GPUI (Zed's toolkit) with gpui-component, on desk's Node server, which it reads as the page
// does (desk issue "Rebuild desk as a native Rust app like Zed, off Electron"). The open issues on the left, kept live
// over the sync socket, and the chat of the one picked in the middle.
mod chat;
mod live;
mod net;
mod steps;
mod sync;

use chat::Chat;
use steps::Steps;
use gpui_kit::base::StyledExt;
use gpui_kit::component::ActiveTheme;
use gpui_kit::*;
use gpui_kit::prelude::FluentBuilder;
use sync::{Event, Issue};

const OPEN: [&str; 5] = ["triage", "running", "review", "waiting", "backlog"];

struct Desk {
    issues: Vec<Issue>,
    picked: Option<String>,
    chat: Option<Entity<Chat>>,
    steps: Entity<Steps>,
    shows: smol::channel::Sender<String>,
}

impl Desk {
    fn new(cx: &mut Context<Self>) -> Self {
        let (send, events) = smol::channel::unbounded();
        let (shows, shown) = smol::channel::unbounded();
        sync::start(send, shown);
        cx.spawn(async move |this, cx| {
            while let Ok(event) = events.recv().await {
                if this.update(cx, |desk, cx| { desk.apply(event, cx); cx.notify() }).is_err() { break }
            }
        })
        .detach();
        Self { issues: Vec::new(), picked: None, chat: None, steps: cx.new(|_| Steps::new()), shows }
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
            Event::Issue { slug, row } => {
                self.issues.retain(|issue| issue.slug != slug);
                self.issues.extend(row);
            }
        }
        self.issues.retain(|issue| OPEN.contains(&issue.state.as_str()));
        let rank = |s: &str| OPEN.iter().position(|o| *o == s).unwrap_or(OPEN.len());
        self.issues.sort_by(|a, b| rank(&a.state).cmp(&rank(&b.state)).then_with(|| a.title.cmp(&b.title)));
    }

    fn open(&mut self, issue: &Issue, window: &mut Window, cx: &mut Context<Self>) {
        if self.picked.as_deref() == Some(&issue.slug) { return }
        self.picked = Some(issue.slug.clone());
        let (slug, title) = (issue.slug.clone(), issue.title.clone());
        let _ = self.shows.try_send(slug.clone());
        self.steps = cx.new(|_| Steps::new());
        self.chat = Some(cx.new(|cx| Chat::new(slug, title, window, cx)));
        cx.notify();
    }
}

impl Render for Desk {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let issues = self.issues.clone();
        let picked = self.picked.clone();
        let this = cx.entity().downgrade();
        let theme = cx.theme();
        let (muted, selected) = (theme.muted_foreground, theme.list_active);
        let rows = uniform_list("issues", issues.len(), move |range, _, _| {
            range
                .map(|i| {
                    let issue = issues[i].clone();
                    let this = this.clone();
                    div()
                        .id(("issue", i))
                        .h_flex()
                        .w_full()
                        .gap_2()
                        .px_3()
                        .h(px(32.))
                        .text_sm()
                        .when(picked.as_deref() == Some(&issue.slug), |row| row.bg(selected))
                        .child(div().flex_none().w(px(60.)).text_xs().text_color(muted).child(issue.state.clone()))
                        .child(div().flex_1().min_w_0().truncate().child(issue.title.clone()))
                        .on_click(move |_, window, cx| {
                            let _ = this.update(cx, |desk, cx| desk.open(&issue, window, cx));
                        })
                })
                .collect()
        })
        .flex_1();
        let sidebar = div()
            .v_flex()
            .flex_none()
            .w(px(320.))
            .h_full()
            .border_r_1()
            .border_color(theme.border)
            .bg(theme.sidebar)
            .child(div().px_3().py_3().text_sm().text_color(muted).child(format!("{} open issues", self.issues.len())))
            .child(rows);
        let middle = match &self.chat {
            Some(chat) => div().flex_1().min_w_0().h_full().child(chat.clone()),
            None => div().flex_1().h_full().flex().items_center().justify_center().text_color(muted).child("Pick an issue"),
        };
        let right = self.chat.is_some().then(|| {
            div().flex_none().w(px(440.)).h_full().border_l_1().border_color(theme.border).child(self.steps.clone())
        });
        div().h_flex().size_full().bg(theme.background).text_color(theme.foreground).child(sidebar).child(middle).children(right)
    }
}

fn main() {
    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);
        let options = WindowOptions { app_id: Some("desk-native".into()), ..Default::default() };
        // `desk <slug>` opens on that issue's chat.
        let slug = std::env::args().nth(1);
        gpui_kit::open_window(options, cx, |window, cx| {
            cx.new(|cx| {
                let mut desk = Desk::new(cx);
                if let Some(slug) = slug {
                    desk.open(&Issue { title: slug.clone(), slug, ..Issue::default() }, window, cx);
                }
                desk
            })
        })
        .expect("open the window");
    });
}
