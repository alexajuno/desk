// The composer, as the web app's (Dock.tsx, Composer): a raised box where you type, Enter sends, or queues while Claude
// works, Ctrl Enter sends now, Ctrl C stops it, Shift Tab flips Manual and Auto, ↑ takes back what waits, Ctrl S
// stashes, and Esc leaves it; / and @ complete from a list over it (typing.rs). Under the text its foot, with + to
// attach files (Ctrl U), a new chat's chips for what it becomes and where it runs (Ctrl D), the stash, the context's
// gauge, the chat's mode, its model and effort, Stop while it works, and Send.
use std::path::PathBuf;

use base64::Engine;
use gpui_kit::base::StyledExt;
use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::input::{Copy, Enter, Escape, IndentInline, MoveDown, MoveUp, OutdentInline, Textarea};
use gpui_kit::component::menu::{DropdownMenu, PopupMenuItem};
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::json;

use super::Chat;
use crate::live::{self, Attachment, EFFORTS};
use crate::picker::{Menu, Picker, PickerEvent, Source};
use crate::{theme, toast};

// Where the window keeps a new chat's chip as last picked, as the web keeps it in localStorage.startAs.
const START_AS: &str = "native-start-as";

pub(super) fn started_as_chat() -> bool {
    crate::state_dir().and_then(|d| std::fs::read_to_string(d.join(START_AS)).ok()).is_some_and(|s| s.trim() == "chat")
}

fn keep_start_as(chat: bool) {
    let Some(dir) = crate::state_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join(START_AS), if chat { "chat" } else { "issue" });
}

// A row of the chip's menu: its glyph, its name and under it what it means.
fn start_row(icon: &'static str, label: &'static str, sub: &'static str) -> PopupMenuItem {
    PopupMenuItem::element(move |_, cx| {
        let muted = cx.theme().muted_foreground;
        div().h_flex().gap_2().py_1().child(theme::glyph(icon, muted)).child(div().v_flex().child(label).child(div().text_xs().text_color(muted).child(sub)))
    })
}

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
    // desk's own chat, which works an issue or files one: the chats with an agent, and bare ones, have no mode.
    fn moded(&self) -> bool {
        let m = &self.meta;
        m["chat"].as_bool().unwrap_or(false) && m["agent"].is_null() && !m["bare"].as_bool().unwrap_or(false)
            && (!m["issue"].is_null() || (self.fresh() && !self.start_as_chat))
    }

    // Issue is desk's agent, which files the talk in Triage and works it; Chat is a bare Claude, which the sidebar lists
    // under Chats (the server's chats.ts, becomeBare). The next new chat starts on the pick.
    fn pick_start_as(&mut self, chat: bool, cx: &mut Context<Self>) {
        self.start_as_chat = chat;
        keep_start_as(chat);
        cx.notify();
    }

    // The folder chip's menu, or Ctrl D: your repos and the folders used before, over the chip; again, it closes.
    fn open_folders(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.folder_menu.take().is_some() { return cx.notify() }
        if !self.fresh() { return toast::say("A chat's folder is picked before its first message.", cx) }
        let bounds = self.folder_chip.get().unwrap_or_default();
        let menu = Menu { source: Source::Folders(self.starts_in()), placeholder: "Search repos, or type ~/path…", empty: "No folder matches", width: 360., takes_typed: true, start: String::new() };
        let picker = cx.new(|cx| Picker::new(menu, bounds, window, cx));
        let picked = cx.subscribe_in(&picker, window, |chat, _, event: &PickerEvent, window, cx| {
            let folder = match event {
                PickerEvent::Picked(value) | PickerEvent::Typed(value) => value.trim().to_string(),
                PickerEvent::Closed => String::new(),
            };
            chat.folder_menu = None;
            chat.focus_composer(window, cx); // back to typing the first message
            if !folder.is_empty() { chat.start_in(folder, cx) }
            cx.notify();
        });
        self.folder_menu = Some((picker, picked));
        cx.notify();
    }

    // The chat's session starts again in the folder: the chip shows it at once, and desk's answer, or its reason.
    fn start_in(&mut self, folder: String, cx: &mut Context<Self>) {
        let Some(session) = self.session.clone() else { return };
        let was = self.meta.clone();
        self.meta["folder"] = json!(folder.clone());
        self.meta["picked"] = json!(true);
        let as_chat = self.start_as_chat;
        cx.spawn(async move |this, cx| {
            let done = cx.background_spawn(async move { live::start_in(&session, &folder, as_chat) }).await;
            let _ = this.update(cx, |chat, cx| {
                match done {
                    Ok(meta) if meta.is_object() => chat.meta = meta,
                    Ok(_) => {}
                    Err(reason) => {
                        chat.meta = was;
                        toast::say(reason, cx);
                    }
                }
                cx.notify()
            });
        })
        .detach();
    }

    // The folder chip's menu, opening up from the chip since the composer is at the window's foot.
    pub(super) fn folder_menu_shown(&self) -> Option<AnyElement> {
        let (picker, _) = self.folder_menu.as_ref()?;
        let at = self.folder_chip.get()?;
        let corner = point(at.origin.x, at.origin.y - px(4.));
        Some(deferred(anchored().position(corner).anchor(Anchor::BottomLeft).snap_to_window_with_margin(px(8.)).child(picker.clone())).with_priority(2).into_any_element())
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
    pub(super) fn pick_runs(&mut self, model: Option<(String, String)>, effort: Option<String>, cx: &mut Context<Self>) {
        let set = self.show_runs(model, effort, cx);
        self.call(cx, move |session| live::pick(session, set));
    }

    // The chip on the model and effort picked, before the server has them; what to send it.
    pub(super) fn show_runs(&mut self, model: Option<(String, String)>, effort: Option<String>, cx: &mut Context<Self>) -> serde_json::Value {
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
        set
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
        let (stash_chip, picks) = (self.stash_chip(cx), self.picks_list(cx));
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

        // A new chat's chips, until its first message: what it becomes, and the folder it runs in.
        let fresh = self.fresh();
        let start_as = fresh.then(|| {
            let chat = self.start_as_chat;
            let this = cx.entity().downgrade();
            Self::chip(
                "start-as",
                div().h_flex().gap_1().child(theme::glyph(if chat { "chat" } else { "triage" }, muted).size(px(14.))).child(if chat { "Chat" } else { "Issue" }),
                muted,
                cx,
            )
            .dropdown_menu_with_anchor(Anchor::BottomLeft, move |menu, _, _| {
                let (issue, bare) = (this.clone(), this.clone());
                menu.label("This chat becomes")
                    .item(start_row("triage", "Issue", "lands in Triage").checked(!chat).on_click(move |_, _, cx| { let _ = issue.update(cx, |c, cx| c.pick_start_as(false, cx)); }))
                    .item(start_row("chat", "Chat", "just talk, lands in Chats").checked(chat).on_click(move |_, _, cx| { let _ = bare.update(cx, |c, cx| c.pick_start_as(true, cx)); }))
            })
        });
        let start_in = fresh.then(|| {
            let at = self.folder_chip.clone();
            div()
                .relative()
                .min_w_0()
                .child(
                    Self::chip("start-in", div().h_flex().min_w_0().gap_1().child(theme::glyph("folder", muted).size(px(14.))).child(div().min_w_0().truncate().child(self.starts_in())), muted, cx)
                        .on_click(cx.listener(|chat, _, window, cx| chat.open_folders(window, cx))),
                )
                .child(canvas(move |bounds, _, _| at.set(Some(bounds)), |_, _, _, _| {}).absolute().top_0().left_0().size_full())
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
            .children(start_as)
            .children(start_in)
            .children(stash_chip)
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
                    .on_click(cx.listener(|chat, _, window, cx| chat.submit(false, window, cx))),
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
            // A terminal's Ctrl C while Claude works, which copies when text is selected; Shift Tab flips a new chat's
            // Issue and Chat, then Manual and Auto; Ctrl U attaches, Ctrl D picks a new chat's folder; Esc leaves the
            // box, for the window's own keys.
            .capture_action(cx.listener(|chat, _: &Copy, _, cx| {
                if chat.working && chat.composer.read(cx).selected_range().is_empty() {
                    chat.interrupt(cx);
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|chat, _: &OutdentInline, _, cx| {
                if chat.fresh() {
                    let bare = !chat.start_as_chat;
                    chat.pick_start_as(bare, cx);
                    cx.stop_propagation();
                } else if chat.moded() {
                    let auto = !chat.auto();
                    chat.set_auto(auto, cx);
                    cx.stop_propagation();
                }
            }))
            // While the list over the box shows, ↑ and ↓ walk it, Tab takes the row lit or the first, Enter the row
            // lit, and Esc closes it; ↑ on the first line takes back the messages that wait.
            .capture_action(cx.listener(|chat, _: &MoveDown, _, cx| {
                if chat.picks.is_empty() { return }
                chat.move_pick(1, cx);
                cx.stop_propagation();
            }))
            .capture_action(cx.listener(|chat, _: &MoveUp, window, cx| {
                if !chat.picks.is_empty() {
                    chat.move_pick(-1, cx);
                    return cx.stop_propagation();
                }
                let first_line = { let c = chat.composer.read(cx); !c.value()[..c.cursor().min(c.value().len())].contains('\n') };
                if chat.queued() && first_line {
                    chat.take_back(window, cx);
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|chat, _: &IndentInline, window, cx| {
                if chat.picks.is_empty() { return }
                chat.choose(chat.pick_at.unwrap_or(0), window, cx);
                cx.stop_propagation();
            }))
            .capture_action(cx.listener(|chat, e: &Enter, window, cx| {
                let Some(at) = chat.pick_at.filter(|_| !chat.picks.is_empty() && !e.secondary && !e.shift) else { return };
                chat.choose(at, window, cx);
                cx.stop_propagation();
            }))
            .capture_action(cx.listener(|chat, _: &Escape, window, cx| {
                if chat.picks.is_empty() { window.blur(cx) } else { chat.close_picks(cx) }
                cx.stop_propagation();
            }))
            .on_key_down(cx.listener(|chat, e: &KeyDownEvent, window, cx| {
                let k = &e.keystroke;
                if !k.modifiers.control || k.modifiers.shift || k.modifiers.alt { return }
                match k.key.as_str() {
                    "u" => chat.attach(cx),
                    "d" => chat.open_folders(window, cx),
                    "s" => chat.swap_stash(window, cx),
                    _ => return,
                }
                cx.stop_propagation();
            }))
            .children(picks)
            .children(attached)
            .child(Textarea::new(&self.composer).appearance(false).text_size(px(14.)))
            .child(foot)
            .child({
                let at = self.composer_at.clone();
                canvas(move |bounds, _, _| at.set(Some(bounds)), |_, _, _, _| {}).absolute().top_0().left_0().size_full()
            })
    }
}
