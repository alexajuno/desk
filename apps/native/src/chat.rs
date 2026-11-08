// An issue's chat in the page, under its head (main.rs): its conversation, live over the session's socket (live.rs),
// the reply streaming in as it comes, and the composer, whose Enter sends (Shift+Enter breaks the line). Like the web
// app's, the conversation is a column a document's width, at a document's text size, with the user's own messages in
// a soft bubble on the right.
use gpui_kit::base::StyledExt;
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::component::message_scroller::{MessageScroller, MessageScrollerState};
use gpui_kit::component::text::TextView;
use gpui_kit::component::ActiveTheme;
use gpui_kit::*;

use crate::live::{self, Event, Item};
use crate::net;
use crate::theme;

// The web app's chat column and text (desk.css).
const COLUMN: f32 = 760.;
const DOCUMENT: f32 = 15.;

struct Block {
    msg: String,
    index: u64,
    kind: String,
    text: String,
}

pub struct Chat {
    session: Option<String>,
    items: Vec<Item>,
    partial: Vec<Block>,
    working: bool,
    error: Option<String>,
    rows: usize,
    scroller: Entity<MessageScrollerState>,
    composer: Entity<TextareaState>,
    _subscription: Subscription,
}

impl Chat {
    pub fn new(slug: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let scroller = cx.new(|cx| MessageScrollerState::new(0, cx));
        let composer = cx.new(|cx| {
            TextareaState::new(window, cx).auto_grow(1, 10).submit_on_enter(true).placeholder("Message the chat")
        });
        let subscription = cx.subscribe_in(&composer, window, |chat, _, event: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { shift: false, .. } = event {
                chat.submit(window, cx);
            }
        });
        composer.update(cx, |c, cx| c.focus(window, cx));
        let page = format!("/api/page/issue/{slug}");
        cx.spawn(async move |this, cx| {
            let found = cx.background_spawn(async move { net::get(&page) }).await;
            let session = match found {
                Ok(page) => page["issue"]["session"].as_str().map(str::to_string),
                Err(error) => {
                    let _ = this.update(cx, |chat, cx| { chat.error = Some(error); cx.notify() });
                    return;
                }
            };
            let Some(session) = session else {
                let _ = this.update(cx, |chat, cx| { chat.error = Some("This issue has no chat yet.".into()); cx.notify() });
                return;
            };
            let (send, events) = smol::channel::unbounded();
            live::follow(session.clone(), send);
            if this.update(cx, |chat, _| chat.session = Some(session)).is_err() { return }
            while let Ok(event) = events.recv().await {
                if this.update(cx, |chat, cx| chat.apply(event, cx)).is_err() { break }
            }
        })
        .detach();
        Self { session: None, items: Vec::new(), partial: Vec::new(), working: false, error: None, rows: 0, scroller, composer, _subscription: subscription }
    }

    fn streaming(&self) -> String {
        self.partial.iter().filter(|b| b.kind == "text" && !b.text.is_empty()).map(|b| b.text.as_str()).collect::<Vec<_>>().join("\n\n")
    }

    fn count(&self) -> usize {
        self.items.len() + usize::from(!self.streaming().is_empty())
    }

    // Each change touches the end of the conversation: the rows from the first one it changed are laid out again.
    fn apply(&mut self, event: Event, cx: &mut Context<Self>) {
        let before = self.items.len();
        let old_rows = self.rows;
        match event {
            Event::Hello { items, working } => {
                self.items = items;
                self.partial.clear();
                self.working = working;
                self.rows = self.count();
                self.scroller.update(cx, |s, cx| s.reset(self.rows, cx));
                return cx.notify();
            }
            Event::Items(items) => {
                for item in &items {
                    let kind = if item.kind == "tool" { "tool_use" } else { item.kind.as_str() };
                    if let Some(done) = self.partial.iter().find(|b| b.msg == item.msg && b.kind == kind).map(|b| b.index) {
                        self.partial.retain(|b| b.msg != item.msg || b.index > done);
                    }
                }
                self.items.extend(items);
            }
            Event::Stream { msg, index, kind, text } => {
                match self.partial.iter_mut().find(|b| b.msg == msg && b.index == index) {
                    Some(block) => block.text.push_str(&text),
                    None => self.partial.push(Block { msg, index, kind, text }),
                }
            }
            Event::Working(working) => {
                self.working = working;
                if !working { self.partial.clear() }
            }
        }
        self.rows = self.count();
        let start = before.min(self.items.len()).min(old_rows);
        let rows = self.rows;
        self.scroller.update(cx, |s, cx| { s.splice(start..old_rows, rows - start, cx); });
        cx.notify();
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.composer.read(cx).value().trim().to_string();
        let Some(session) = self.session.clone() else { return };
        if text.is_empty() { return }
        self.composer.update(cx, |c, cx| c.set_value("", window, cx));
        cx.spawn(async move |this, cx| {
            let sent = cx.background_spawn(async move { live::send(&session, &text) }).await;
            let _ = this.update(cx, |chat, cx| { chat.error = sent.err(); cx.notify() });
        })
        .detach();
    }

    // One row of the conversation, in the column.
    fn row(items: &[Item], streaming: &str, i: usize, cx: &App) -> AnyElement {
        let theme = cx.theme();
        let column = |child: AnyElement| div().w_full().flex().justify_center().px_6().child(div().w_full().max_w(px(COLUMN)).child(child));
        let Some(item) = items.get(i) else {
            return column(div().py_2().text_size(px(DOCUMENT)).child(TextView::markdown("streaming", streaming.to_string()).selectable(true)).into_any_element()).into_any_element();
        };
        let inner = match item.kind.as_str() {
            "you" => div()
                .h_flex()
                .justify_end()
                .py_3()
                .child(
                    div()
                        .max_w(relative(0.8))
                        .px_4()
                        .py_2()
                        .rounded(px(12.))
                        .bg(theme.muted)
                        .text_size(px(DOCUMENT))
                        .text_color(theme::text(cx).strong)
                        .child(item.text.clone()),
                )
                .into_any_element(),
            "text" => div()
                .py_2()
                .text_size(px(DOCUMENT))
                .line_height(relative(1.6))
                .child(TextView::markdown(("md", i), item.text.clone()).selectable(true))
                .into_any_element(),
            _ => div()
                .py_1()
                .text_color(theme.muted_foreground)
                .truncate()
                .child(item.text.lines().next().unwrap_or("").to_string())
                .into_any_element(),
        };
        column(inner).into_any_element()
    }
}

impl Render for Chat {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let items = self.items.clone();
        let streaming = self.streaming();
        let status = match (&self.error, self.working) {
            (Some(error), _) => error.clone(),
            (None, true) => "Working…".into(),
            (None, false) => String::new(),
        };
        let column = |child: Div| div().w_full().flex().justify_center().px_6().child(child.w_full().max_w(px(COLUMN)));
        div()
            .v_flex()
            .size_full()
            .child(
                div().flex_1().min_h_0().child(
                    MessageScroller::new("chat", self.scroller.clone(), move |i, _, cx| Self::row(&items, &streaming, i, cx)).size_full(),
                ),
            )
            .child(column(div().h(px(24.)).text_color(theme.muted_foreground).child(status)))
            .child(column(div().pb_4().child(Textarea::new(&self.composer).rounded(px(12.)).text_size(px(DOCUMENT)))))
    }
}
