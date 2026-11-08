// The edges you drag to resize (desk issue "Native window: the bars can't be resized"): the sidebar's right edge, and
// the line between the chat and its right half, as the web's half-grip (Half.tsx). The widths stay between runs in
// ~/.local/state/desk/native-widths.json, as the web keeps the chat's in localStorage.
use crate::Desk;
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

pub(crate) const SIDE: f32 = 244.; // the sidebar's width until dragged
pub(crate) const CHAT: f32 = 480.; // the chat's, beside its half, until dragged
const SIDE_MIN: f32 = 200.;
const SIDE_MAX: f32 = 420.;
const CHAT_MIN: f32 = 360.; // the web's CHAT.min
const HALF_MIN: f32 = 320.; // the web's .half min-width
const GRIP: f32 = 8.;
const FILE: &str = "native-widths.json";

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Edge {
    Side,
    Chat,
}

#[derive(Clone, Copy)]
pub(crate) struct Widths {
    pub side: f32,
    chat: f32,
    pub dragging: Option<Edge>,
}

impl Widths {
    pub fn load() -> Widths {
        let kept: serde_json::Value = crate::state_dir()
            .and_then(|d| std::fs::read_to_string(d.join(FILE)).ok())
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        let side = kept["side"].as_f64().map_or(SIDE, |w| (w as f32).clamp(SIDE_MIN, SIDE_MAX));
        let chat = kept["chat"].as_f64().map_or(CHAT, |w| (w as f32).max(CHAT_MIN));
        Widths { side, chat, dragging: None }
    }

    fn save(&self) {
        let Some(dir) = crate::state_dir() else { return };
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join(FILE), serde_json::json!({ "side": self.side, "chat": self.chat }).to_string());
    }

    // The chat's width on a page this wide: what it was dragged to, leaving the half its least.
    pub fn chat(&self, page_width: f32) -> f32 {
        self.chat.min(page_width - HALF_MIN).max(CHAT_MIN)
    }
}

// What a drag shows under the mouse: nothing, since the edge itself moves.
struct Dragged;

impl Render for Dragged {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        Empty
    }
}

impl Desk {
    // An edge's grip, 8px wide around the line at x, from top down: a 2px line shows while the mouse is on it or drags it.
    pub(crate) fn grip(&self, edge: Edge, x: f32, top: f32, cx: &mut Context<Self>) -> Stateful<Div> {
        let id: &'static str = if edge == Edge::Side { "grip-side" } else { "grip-chat" };
        let line = cx.theme().border;
        let held = self.widths.dragging == Some(edge);
        div()
            .id(id)
            .group(id)
            .absolute()
            .top(px(top))
            .bottom_0()
            .left(px(x - GRIP / 2.))
            .w(px(GRIP))
            .cursor(CursorStyle::ResizeLeftRight)
            .child(
                div().absolute().top_0().bottom_0().left(px(GRIP / 2. - 1.)).w(px(2.))
                    .when(held, |l| l.bg(line))
                    .when(!held, |l| l.group_hover(id, move |s| s.bg(line))),
            )
            .on_drag(edge, |_, _, _, cx| cx.new(|_| Dragged))
    }

    // The mouse moved while an edge is dragged: the edge follows it. x is the mouse's from the window's left.
    pub(crate) fn drag_edge(&mut self, edge: Edge, x: f32, window: &Window, cx: &mut Context<Self>) {
        match edge {
            Edge::Side => self.widths.side = x.clamp(SIDE_MIN, SIDE_MAX),
            Edge::Chat => {
                let page_width = window.viewport_size().width.as_f32() - self.side_width();
                // the page's panel starts at the sidebar's edge, inside its 1px border
                self.widths.chat = (x - self.side_width() + 8. - 1.).min(page_width - HALF_MIN).max(CHAT_MIN);
            }
        }
        self.widths.dragging = Some(edge);
        cx.notify();
    }

    // The mouse let go: a drag that moved an edge keeps its width.
    pub(crate) fn drop_edge(&mut self, cx: &mut Context<Self>) {
        if self.widths.dragging.take().is_some() {
            self.widths.save();
            cx.notify();
        }
    }
}

