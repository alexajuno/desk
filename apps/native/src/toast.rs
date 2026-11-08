// desk's toast at the bottom right of the window, as the web's (ui/toast.tsx; desk.css .toast): what an action did, and
// Undo where it can be undone. One at a time, a new one taking the old one's place; it goes after 3 s, or 8 s with an
// action. Any part of the window shows one; the window draws it over everything (main.rs).
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::base::StyledExt;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

use crate::filters::{colours, pop_shadow};

pub type Run = Rc<dyn Fn(&mut Window, &mut App)>;

// About as wide as a toast gets, for whether it would cover the composer.
const WIDE: f32 = 360.;

struct Toast {
    text: SharedString,
    action: Option<(SharedString, Run)>,
    id: u64,
}

#[derive(Default)]
struct Toasts {
    current: Option<Toast>,
    count: u64,
}

impl Global for Toasts {}

pub fn say(text: impl Into<SharedString>, cx: &mut App) {
    show(text, None, cx)
}

pub fn show(text: impl Into<SharedString>, action: Option<(&'static str, Run)>, cx: &mut App) {
    let toasts = cx.default_global::<Toasts>();
    toasts.count += 1;
    let id = toasts.count;
    let wait = if action.is_some() { 8000 } else { 3000 };
    toasts.current = Some(Toast { text: text.into(), action: action.map(|(label, run)| (label.into(), run)), id });
    cx.refresh_windows();
    cx.spawn(async move |cx| {
        cx.background_executor().timer(Duration::from_millis(wait)).await;
        cx.update(|cx| hide(id, cx));
    })
    .detach();
}

fn hide(id: u64, cx: &mut App) {
    let toasts = cx.default_global::<Toasts>();
    if toasts.current.as_ref().is_some_and(|t| t.id == id) {
        toasts.current = None;
        cx.refresh_windows();
    }
}

// The toast, 16px in from the window's right and 32px up, 40px tall: its words, then · and its action. In that corner
// it would cover a chat's composer, the model chip and Send at its right end, so it rises 8px above one there.
pub fn render(composer: Option<Bounds<Pixels>>, window: &Window, cx: &mut App) -> Option<AnyElement> {
    let toast = cx.try_global::<Toasts>()?.current.as_ref()?;
    let (text, action, id) = (toast.text.clone(), toast.action.clone(), toast.id);
    let c = colours(cx);
    let card = div()
        .id("toast")
        .occlude()
        .h_flex()
        .h(px(40.))
        .gap(px(8.))
        .pl(px(14.))
        .pr(px(if action.is_some() { 8. } else { 14. }))
        .rounded(px(8.))
        .border(px(0.5))
        .border_color(c.pop_edge)
        .bg(c.pop)
        .shadow(pop_shadow(c.dark))
        .text_size(px(13.))
        .text_color(c.text_1)
        .child(text)
        .when_some(action, |card, (label, run)| {
            card.child(div().text_color(crate::theme::text(cx).dim).child("·")).child(
                div().id("toast-action").h_flex().h(px(26.)).px(px(8.)).rounded(px(6.)).cursor_pointer().hover(|s| s.bg(c.pop_on)).child(label)
                    .on_click(move |_, window, cx| {
                        hide(id, cx);
                        run(window, cx);
                    }),
            )
        });
    let view = window.viewport_size();
    let bottom = match composer {
        Some(b) if b.right() > view.width - px(16. + WIDE) && b.bottom() > view.height - px(32. + 40.) => view.height - b.top() + px(8.),
        _ => px(32.),
    };
    Some(deferred(div().absolute().right(px(16.)).bottom(bottom).child(card)).with_priority(4).into_any_element())
}
