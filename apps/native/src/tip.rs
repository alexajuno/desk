// Linear's tooltip, as the web's (ui/tooltip.ts): 12px words in a card with a hairline edge, and, after two spaces in
// its text, the keys, each drawn as a cap, with "then" between the keys of a sequence as a small word: "Switch
// profile", "Settings  Ctrl ,". It shows 450 ms after the mouse comes onto its element, centred 8px under it, or above
// when the window has no room below, and from one tip to the next at once; a click hides it. gpui-base's overlay places
// it and keeps one at a time (Tips, which the window draws); an element takes one with `.tip(words)`.
use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::base::{Placement, TooltipOverlay, TooltipRequest};
use gpui_kit::*;

use crate::filters::{colours, pop_shadow};

const SHOW: Duration = Duration::from_millis(450);

struct Tip(SharedString);

impl Render for Tip {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = colours(cx);
        let (label, keys) = match self.0.split_once("  ") {
            Some((label, keys)) => (label.to_string(), Some(keys.trim().to_string())),
            None => (self.0.to_string(), None),
        };
        let caps = keys.map(|keys| {
            div().flex().items_center().gap(px(3.)).children(keys.split(' ').map(|key| {
                if key == "then" { return div().text_size(px(10.)).text_color(c.tip_key).child("then") }
                div().min_w(px(18.)).p(px(2.)).rounded(px(4.)).border(px(0.5)).border_color(c.key_edge).text_color(c.tip_key)
                    .line_height(px(13.)).flex().justify_center().child(key.to_string())
            }))
        });
        // the 8px between the element and the card
        div().p(px(8.)).child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .max_w(px(520.))
                .px(px(8.))
                .py(px(5.))
                .rounded(px(8.))
                .border(px(0.5))
                .border_color(c.tip_edge)
                .bg(c.tip)
                .shadow(pop_shadow(c.dark))
                .text_size(px(12.))
                .line_height(px(18.))
                .font_weight(FontWeight(450.))
                .text_color(c.tip_text)
                .whitespace_nowrap()
                .child(label)
                .children(caps),
        )
    }
}

// The window's one tip, which it draws over everything.
pub(crate) struct Tips(pub Entity<TooltipOverlay>);

impl Global for Tips {}

pub(crate) fn install(cx: &mut App) -> Entity<TooltipOverlay> {
    let overlay = cx.new(|_| TooltipOverlay::new());
    cx.set_global(Tips(overlay.clone()));
    overlay
}

pub(crate) trait Tipped: Sized {
    fn tip(self, text: impl Into<SharedString>) -> Self;
}

impl Tipped for Stateful<Div> {
    fn tip(self, text: impl Into<SharedString>) -> Self {
        let text = text.into();
        let at = Rc::new(Cell::new(Bounds::default())); // where the element was last drawn
        let probe = at.clone();
        self.relative()
            .child(canvas(move |bounds, _, _| probe.set(bounds), |_, _, _, _| {}).absolute().size_full())
            .on_hover(move |hovered, window, cx| {
                let Some(overlay) = cx.try_global::<Tips>().map(|t| t.0.clone()) else { return };
                let (text, bounds) = (text.clone(), at.get());
                overlay.update(cx, |overlay, cx| {
                    if *hovered {
                        let request = TooltipRequest::new(bounds, move |_, cx| cx.new(|_| Tip(text.clone())).into())
                            .with_placement(Placement::Bottom)
                            .with_show_delay(SHOW);
                        overlay.request_show(request, window, cx);
                    } else {
                        overlay.request_hide(window, cx);
                    }
                });
            })
            .capture_any_mouse_down(|_, _, cx| {
                if let Some(overlay) = cx.try_global::<Tips>().map(|t| t.0.clone()) { overlay.update(cx, |o, cx| o.hide(cx)) }
            })
    }
}
