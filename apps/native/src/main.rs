// desk's window, native: GPUI (Zed's toolkit) with gpui-component, on desk's Node server, read over its sync socket.
// The first step of the issue "Rebuild desk as a native Rust app like Zed, off Electron": the open issues, kept live,
// and a composer to check typing through fcitx5.
mod sync;

use gpui_kit::component::input::{Textarea, TextareaState};
use gpui_kit::base::StyledExt;
use gpui_kit::component::ActiveTheme;
use gpui_kit::*;
use sync::{Event, Issue};

const OPEN: [&str; 5] = ["triage", "running", "review", "waiting", "backlog"];

struct Desk {
    issues: Vec<Issue>,
    composer: Entity<TextareaState>,
}

impl Desk {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let composer = cx.new(|cx| TextareaState::new(window, cx).auto_grow(2, 8));
        let (send, events) = smol::channel::unbounded();
        let host = std::env::var("DESK_HOST").unwrap_or_else(|_| "127.0.0.1:8790".into());
        sync::start(host, send);
        cx.spawn(async move |this, cx| {
            while let Ok(event) = events.recv().await {
                if this.update(cx, |desk, cx| { desk.apply(event); cx.notify() }).is_err() {
                    break;
                }
            }
        })
        .detach();
        Self { issues: Vec::new(), composer }
    }

    fn apply(&mut self, event: Event) {
        match event {
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
}

impl Render for Desk {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let issues = self.issues.clone();
        let muted = cx.theme().muted_foreground;
        let rows = uniform_list("issues", issues.len(), move |range, _, _| {
            range
                .map(|i| {
                    let issue = &issues[i];
                    div()
                        .h_flex()
                        .w_full()
                        .gap_3()
                        .px_4()
                        .h(px(36.))
                        .child(div().flex_none().w(px(84.)).text_color(muted).text_sm().child(issue.state.clone()))
                        .child(div().flex_1().min_w_0().overflow_hidden().truncate().child(issue.title.clone()))
                        .child(div().flex_none().text_color(muted).text_sm().child(issue.priority.clone()))
                })
                .collect()
        })
        .flex_1();
        div()
            .v_flex()
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(div().px_4().py_2().text_sm().text_color(muted).child(format!("{} open issues", self.issues.len())))
            .child(rows)
            .child(div().p_3().border_t_1().border_color(cx.theme().border).child(Textarea::new(&self.composer)))
    }
}

fn main() {
    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);
        let options = WindowOptions { app_id: Some("desk-native".into()), ..Default::default() };
        gpui_kit::open_window(options, cx, |window, cx| cx.new(|cx| Desk::new(window, cx))).expect("open the window");
    });
}
