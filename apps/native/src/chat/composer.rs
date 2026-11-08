// The composer, as the web app's (Dock.tsx, Composer): a raised box where you type, Enter sends, or queues while Claude
// works, Ctrl C stops it, and Shift Tab flips Manual and Auto; under the text its foot, with + to attach files (Ctrl U),
// the context's gauge, the chat's mode, its model and effort, Stop while it works, and Send.
use std::path::PathBuf;

use base64::Engine;
use gpui_kit::base::StyledExt;
use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::input::{Copy, OutdentInline, Textarea};
use gpui_kit::component::menu::{DropdownMenu, PopupMenuItem};
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::json;

use super::Chat;
use crate::live::{self, Attachment, EFFORTS};
use crate::theme;

// The images Claude takes inline; any other file goes by its path.
fn inline(path: &std::path::Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn read(path: PathBuf) -> Result<Attachment, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Attachment {
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        media_type: inline(&path),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        path,
    })
}

impl Chat {
    // desk's own chat, which works an issue: the chats with an agent, and bare ones, have no mode.
    fn moded(&self) -> bool {
        let m = &self.meta;
        m["chat"].as_bool().unwrap_or(false) && m["agent"].is_null() && !m["bare"].as_bool().unwrap_or(false) && !m["issue"].is_null()
    }

    fn auto(&self) -> bool {
        self.meta["auto"].as_bool().unwrap_or(false)
    }

    // Manual or Auto: the chip shows it at once, and the server's next meta confirms it.
    fn set_auto(&mut self, auto: bool, cx: &mut Context<Self>) {
        self.meta["auto"] = json!(auto);
        cx.notify();
        self.call(cx, move |session| live::set_auto(session, auto));
    }

    // A model or an effort picked: the chip shows it at once.
    fn pick_runs(&mut self, model: Option<(String, String)>, effort: Option<String>, cx: &mut Context<Self>) {
        let mut set = json!({});
        if let Some((value, name)) = model {
            self.meta["runs"]["name"] = json!(name);
            self.meta["runs"]["model"] = json!(value.clone());
            set["model"] = json!(value);
        }
        if let Some(effort) = effort {
            self.meta["runs"]["effort"] = json!(effort.clone());
            set["effort"] = json!(effort);
        }
        cx.notify();
        self.call(cx, move |session| live::pick(session, set));
    }

    // + or Ctrl U: the system's file picker, then the files read for the message.
    fn attach(&mut self, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: true, prompt: None });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else { return };
            let read = cx.background_spawn(async move { paths.into_iter().map(read).collect::<Result<Vec<_>, _>>() }).await;
            let _ = this.update(cx, |chat, cx| {
                match read {
                    Ok(files) => chat.attached.extend(files),
                    Err(error) => chat.error = Some(error),
                }
                cx.notify()
            });
        })
        .detach();
    }

    // A round button of the foot.
    fn round(id: &'static str, fill: Hsla, glyph: Svg) -> Stateful<Div> {
        div().id(id).flex_none().flex().items_center().justify_center().size(px(28.)).rounded_full().bg(fill).cursor_pointer().child(glyph)
    }

    // A chip of the foot: its words, and a chevron for the menu it opens.
    fn chip(id: &'static str, words: impl IntoElement, colour: Hsla, cx: &App) -> Button {
        Button::new(id)
            .ghost()
            .h(px(28.))
            .px(px(6.))
            .gap_1()
            .text_xs()
            .text_color(colour)
            .child(words)
            .child(theme::glyph("chevron", cx.theme().muted_foreground).size(px(10.)))
    }

    pub(super) fn composer_box(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        if self.queueing != self.working {
            self.queueing = self.working;
            let wanted = if self.working { "Queue a message for when it's ready…" } else { "Reply…" };
            self.composer.update(cx, |c, cx| c.set_placeholder(wanted, window, cx));
        }
        let theme = cx.theme();
        let text = theme::text(cx);
        let focused = self.composer.read(cx).focus_handle(cx).is_focused(window);
        let empty = self.composer.read(cx).value().trim().is_empty() && self.attached.is_empty();
        let muted = theme.muted_foreground;
        let primary = theme.primary;

        let attached = (!self.attached.is_empty()).then(|| {
            div().h_flex().flex_wrap().gap(px(6.)).mb_2().children(self.attached.iter().enumerate().map(|(n, a)| {
                let remove = div()
                    .id(("unattach", n))
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(18.))
                    .rounded_full()
                    .bg(theme.popover)
                    .cursor_pointer()
                    .on_click(cx.listener(move |chat, _, _, cx| { chat.attached.remove(n); cx.notify() }))
                    .child(theme::glyph("close", theme.foreground).size(px(12.)));
                let shown = match a.media_type {
                    Some(_) => div().size(px(56.)).child(img(a.path.clone()).size_full().object_fit(ObjectFit::Cover)),
                    None => div()
                        .h_flex()
                        .h(px(56.))
                        .max_w(px(220.))
                        .pl(px(10.))
                        .pr(px(28.))
                        .gap_2()
                        .child(theme::glyph("file", muted))
                        .child(
                            div()
                                .v_flex()
                                .min_w_0()
                                .child(div().truncate().text_xs().font_medium().text_color(text.strong).child(a.name.clone()))
                                .child(div().text_size(px(11.)).text_color(muted).child(a.path.extension().map(|e| e.to_string_lossy().to_uppercase()).unwrap_or_else(|| "File".into()))),
                        ),
                };
                div().relative().rounded(px(8.)).border_1().border_color(theme.border).overflow_hidden().child(shown)
                    .child(div().absolute().top(px(3.)).right(px(3.)).child(remove))
            }))
        });

        let context = self.meta["usage"]["context"]["percent"].as_f64().map(|p| p.round() as u32);
        let used = context.map(|percent| {
            div()
                .h_flex()
                .h(px(28.))
                .px(px(6.))
                .gap(px(5.))
                .text_xs()
                .text_color(muted)
                .child(div().mr(px(2.)).text_color(text.dim).child("Context"))
                .child(theme::ring(percent, muted, text.faint))
                .child(format!("{percent}%"))
        });

        let mode = self.moded().then(|| {
            let auto = self.auto();
            let this = cx.entity().downgrade();
            Self::chip(
                "mode",
                div().h_flex().gap_1().child(theme::glyph(if auto { "auto" } else { "manual" }, if auto { text.accent } else { muted }).size(px(14.))).child(if auto { "Auto" } else { "Manual" }),
                if auto { text.strong } else { muted },
                cx,
            )
            .dropdown_menu_with_anchor(Anchor::BottomRight, move |menu, _, _| {
                let (manual, automatic) = (this.clone(), this.clone());
                menu.label("Between steps")
                    .item(PopupMenuItem::new("Manual").checked(!auto).on_click(move |_, _, cx| { let _ = manual.update(cx, |c, cx| c.set_auto(false, cx)); }))
                    .item(PopupMenuItem::new("Auto").checked(auto).on_click(move |_, _, cx| { let _ = automatic.update(cx, |c, cx| c.set_auto(true, cx)); }))
            })
        });

        let runs = &self.meta["runs"];
        let runs_chip = runs.is_object().then(|| {
            let name = runs["name"].as_str().unwrap_or("").to_string();
            let effort = runs["effort"].as_str().unwrap_or("").to_string();
            let model = runs["model"].as_str().unwrap_or("").to_string();
            let picking = runs["picking"].as_bool().unwrap_or(false);
            let words = if picking { "Auto model".to_string() } else if effort.is_empty() { name.clone() } else { format!("{name} · {}", live::effort_name(&effort)) };
            let models = self.models.clone();
            let percent = context;
            let this = cx.entity().downgrade();
            Self::chip("runs", words, muted, cx).dropdown_menu_with_anchor(Anchor::BottomRight, move |mut menu, _, _| {
                let now = models.iter().find(|m| m.value == model || m.name == name).cloned();
                menu = menu.label("Model");
                for m in &models {
                    let this = this.clone();
                    let pick = (m.value.clone(), m.name.clone());
                    menu = menu.item(PopupMenuItem::new(m.name.clone()).checked(now.as_ref().is_some_and(|n| n.value == m.value)).on_click(move |_, _, cx| {
                        let _ = this.update(cx, |c, cx| c.pick_runs(Some(pick.clone()), None, cx));
                    }));
                }
                menu = menu.separator().label("Effort");
                for (value, label) in EFFORTS {
                    if now.as_ref().is_some_and(|n| !n.efforts.iter().any(|e| e == value)) { continue }
                    let this = this.clone();
                    menu = menu.item(PopupMenuItem::new(label).checked(value == effort).on_click(move |_, _, cx| {
                        let _ = this.update(cx, |c, cx| c.pick_runs(None, Some(value.to_string()), cx));
                    }));
                }
                if let Some(percent) = percent {
                    menu = menu.separator().label("Usage").item(PopupMenuItem::new(format!("Context · {percent}%")).disabled(true));
                }
                menu
            })
        });

        let foot = div()
            .h_flex()
            .gap(px(6.))
            .mt(px(6.))
            .child(
                Self::round("attach", transparent_black(), theme::glyph("plus", muted))
                    .hover(|s| s.bg(text.hover))
                    .on_click(cx.listener(|chat, _, _, cx| chat.attach(cx))),
            )
            .child(div().flex_1())
            .children(used)
            .children(mode)
            .children(runs_chip)
            .when(self.working, |f| {
                f.child(Self::round("stop", text.button, theme::glyph("stop", text.strong).size(px(10.))).on_click(cx.listener(|chat, _, _, cx| chat.interrupt(cx))))
            })
            .child(
                Self::round("send", primary, theme::glyph("send", text.on_primary).size(px(14.)))
                    .when(empty, |b| b.opacity(0.35))
                    .on_click(cx.listener(|chat, _, window, cx| chat.submit(window, cx))),
            );

        div()
            .v_flex()
            .pl_3()
            .pr_2()
            .pt(px(10.))
            .pb(px(6.))
            .rounded(px(14.))
            .border_1()
            .border_color(if focused { text.edge } else { theme.border })
            .bg(text.raised)
            // A terminal's Ctrl C while Claude works, which copies when text is selected; Shift Tab flips Manual and
            // Auto; Ctrl U attaches.
            .capture_action(cx.listener(|chat, _: &Copy, _, cx| {
                if chat.working && chat.composer.read(cx).selected_range().is_empty() {
                    chat.interrupt(cx);
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|chat, _: &OutdentInline, _, cx| {
                if chat.moded() {
                    let auto = !chat.auto();
                    chat.set_auto(auto, cx);
                    cx.stop_propagation();
                }
            }))
            .on_key_down(cx.listener(|chat, e: &KeyDownEvent, _, cx| {
                let k = &e.keystroke;
                if k.key == "u" && k.modifiers.control && !k.modifiers.shift && !k.modifiers.alt {
                    chat.attach(cx);
                    cx.stop_propagation();
                }
            }))
            .children(attached)
            .child(Textarea::new(&self.composer).appearance(false).text_size(px(14.)))
            .child(foot)
    }
}
