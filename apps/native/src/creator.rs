// The new issue panel, as the web's (frame/Creator.tsx), which copies Linear's create panel: a title, a description,
// chips that open the same status, priority, parent, team and project menus as the rest of desk, and Create more
// beside Create issue. C, the sidebar's pencil, a group's + and Add sub-issue open it, the last two with what they
// say. Enter in the title moves to the description, Ctrl Enter creates, Esc or a click outside closes it, and what
// you typed waits as a draft until it is created, as Linear keeps its drafts.
use gpui_kit::base::StyledExt;
use gpui_kit::component::input::{Escape, InputEvent, Textarea, TextareaState};
use gpui_kit::component::menu::{PopupMenu, PopupMenuItem};
use gpui_kit::component::{ActiveTheme, Sizable, Size as InputSize};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::{json, Map, Value};

use crate::filters::{colours, pop_shadow, Anchors};
use crate::issue::{choices, parents, priority_icon, priority_name, state_name, PRIORITIES, STATES};
use crate::picker::{Menu, Picker, PickerEvent, Source};
use crate::tip::Tipped;
use crate::{net, theme, toast};

const DRAFT: &str = "native-new-issue.json";
const MORE: &str = "native-create-more";

pub(crate) enum CreatorEvent {
    Made { slug: String, sub: bool },
    Closed,
}

impl EventEmitter<CreatorEvent> for Creator {}

pub(crate) struct Creator {
    title: Entity<TextareaState>,
    body: Entity<TextareaState>,
    fields: Map<String, Value>, // state, priority, parent, team, project, each with its title: parentTitle...
    more: bool,
    sending: bool,
    anchors: Anchors,
    menu: Option<(AnyView, Point<Pixels>, Subscription)>,
    _typed: Vec<Subscription>,
}

fn file(name: &str) -> Option<std::path::PathBuf> {
    crate::state_dir().map(|d| d.join(name))
}

impl Creator {
    pub(crate) fn new(preset: &Value, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let draft: Map<String, Value> = file(DRAFT).and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let mut fields = Map::new();
        fields.insert("state".into(), "backlog".into());
        fields.insert("priority".into(), "none".into());
        for (k, v) in draft.iter().chain(preset.as_object().into_iter().flatten()) { fields.insert(k.clone(), v.clone()); }
        let text = |k: &str| fields.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let (title_text, body_text) = (text("title"), text("body"));
        let title = cx.new(|cx| TextareaState::new(window, cx).auto_grow(1, 6).submit_on_enter(true).placeholder("Issue title").default_value(title_text));
        let body = cx.new(|cx| TextareaState::new(window, cx).auto_grow(3, 16).placeholder("Add description…").default_value(body_text));
        let to_body = body.clone();
        let typed = vec![cx.subscribe_in(&title, window, move |_, _, event: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { secondary: false, .. } = event { to_body.update(cx, |b, cx| b.focus(window, cx)) }
        })];
        title.update(cx, |t, cx| t.focus(window, cx));
        let more = file(MORE).is_some_and(|f| f.exists());
        Self { title, body, fields, more, sending: false, anchors: Anchors::default(), menu: None, _typed: typed }
    }

    fn get(&self, k: &str) -> String {
        self.fields.get(k).and_then(Value::as_str).unwrap_or("").to_string()
    }

    fn set(&mut self, k: &str, v: String, title: Option<String>, cx: &mut Context<Self>) {
        self.fields.insert(k.into(), v.into());
        if let Some(t) = title { self.fields.insert(format!("{k}Title"), t.into()); }
        cx.notify();
    }

    // Closed, its words kept as the draft unless it was created.
    pub(crate) fn close(&mut self, keep: bool, cx: &mut Context<Self>) {
        let (title, body) = (self.title.read(cx).value().to_string(), self.body.read(cx).value().to_string());
        if let Some(f) = file(DRAFT) {
            if keep && !(title.trim().is_empty() && body.trim().is_empty()) {
                let mut d = self.fields.clone();
                d.insert("title".into(), title.into());
                d.insert("body".into(), body.into());
                if let Some(dir) = f.parent() { let _ = std::fs::create_dir_all(dir); }
                let _ = std::fs::write(f, Value::Object(d).to_string());
            } else {
                let _ = std::fs::remove_file(f);
            }
        }
        cx.emit(CreatorEvent::Closed);
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = self.title.read(cx).value().split_whitespace().collect::<Vec<_>>().join(" ");
        if name.is_empty() {
            toast::say("Give the issue a title first", cx);
            return self.title.update(cx, |t, cx| t.focus(window, cx));
        }
        if self.sending { return }
        self.sending = true;
        let or_null = |v: String| if v.is_empty() { Value::Null } else { v.into() };
        let body = json!({
            "title": name, "body": self.body.read(cx).value().to_string(), "state": self.get("state"), "priority": self.get("priority"),
            "parent": or_null(self.get("parent")), "team": or_null(self.get("team")), "project": or_null(self.get("project")),
        });
        cx.spawn_in(window, async move |this, cx| {
            let made = cx.background_spawn(async move { net::post("/api/issues", body) }).await;
            let _ = this.update_in(cx, |c, window, cx| {
                c.sending = false;
                match made {
                    Err(e) => toast::say(e, cx),
                    Ok(made) => {
                        let slug = made["slug"].as_str().unwrap_or("").to_string();
                        // said before it closes, which ends the window's listening
                        cx.emit(CreatorEvent::Made { slug, sub: made["parent"].is_string() });
                        if c.more {
                            if let Some(f) = file(DRAFT) { let _ = std::fs::remove_file(f); }
                            c.title.update(cx, |t, cx| { t.set_value("", window, cx); t.focus(window, cx) });
                            c.body.update(cx, |b, cx| b.set_value("", window, cx));
                        } else {
                            c.close(false, cx);
                        }
                    }
                }
            });
        })
        .detach();
    }

    // A chip's menu, under it: the status's and priority's as the rows' are, the rest a picker that is typed in.
    fn choose(&mut self, field: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        let at = self.anchors.get(&format!("chip-{field}")).map(|b| point(b.left(), b.bottom() + px(4.))).unwrap_or(point(px(400.), px(300.)));
        if self.menu.take().is_some() { return cx.notify() }
        if field == "state" || field == "priority" {
            let current = self.get(field);
            let this = cx.entity().downgrade();
            let menu = PopupMenu::build(window, cx, move |mut menu, _, _| {
                let values: &[&'static str] = if field == "state" { &STATES } else { &PRIORITIES };
                for value in values {
                    let value: &'static str = value;
                    let this = this.clone();
                    let item = PopupMenuItem::element(move |_, cx| {
                        let icon = if field == "state" { theme::state_icon(value, cx).into_any_element() } else { priority_icon(value, cx).size(px(14.)).into_any_element() };
                        div().h_flex().gap_2().child(div().flex().w(px(16.)).justify_center().child(icon)).child(if field == "state" { state_name(value) } else { priority_name(value) })
                    });
                    menu = menu.item(item.checked(value == current).on_click(move |_, _, cx| {
                        let _ = this.update(cx, |c, cx| c.set(field, value.into(), None, cx));
                    }));
                }
                menu
            });
            menu.focus_handle(cx).focus(window, cx);
            let gone = cx.subscribe_in(&menu, window, |c, menu, _: &DismissEvent, window, cx| {
                if c.menu.as_ref().is_some_and(|(open, _, _)| open.entity_id() == menu.entity_id()) { c.menu = None; c.title.update(cx, |t, cx| t.focus(window, cx)); cx.notify() }
            });
            self.menu = Some((menu.into(), at, gone));
            return cx.notify();
        }
        let (team, project, parent) = (self.get("team"), self.get("project"), self.get("parent"));
        let nonempty = |v: String| Some(v).filter(|v| !v.is_empty());
        cx.spawn_in(window, async move |this, cx| {
            let found = cx.background_spawn(async move {
                match field { "parent" => parents("", &parent), _ => choices(field, nonempty(team), nonempty(project), None) }
            }).await;
            let _ = this.update_in(cx, |c, window, cx| {
                let menu: Menu = match found { Ok(m) => m, Err(e) => return toast::say(e, cx) };
                let labels: Vec<(String, String)> = match &menu.source { Source::Fixed(p) => p.iter().map(|p| (p.value.clone(), p.label.clone())).collect(), _ => Vec::new() };
                let picker = cx.new(|cx| Picker::new(menu, Bounds::new(at, size(px(0.), px(0.))), window, cx));
                let events = cx.subscribe_in(&picker, window, move |c, _, event: &PickerEvent, window, cx| {
                    if let PickerEvent::Picked(v) = event {
                        let label = labels.iter().find(|(value, _)| value == v).map(|(_, l)| l.clone()).unwrap_or_default();
                        c.set(field, v.clone(), Some(if v.is_empty() { String::new() } else { label }), cx);
                    }
                    c.menu = None;
                    c.title.update(cx, |t, cx| t.focus(window, cx));
                    cx.notify();
                });
                c.menu = Some((picker.into(), at, events));
                cx.notify();
            });
        })
        .detach();
    }

    // A chip: its icon and what it is set to, or the property's name, dimmer, while it is not set.
    fn chip(&self, field: &'static str, tip: &'static str, icon: AnyElement, words: String, unset: bool, cx: &mut Context<Self>) -> Stateful<Div> {
        let c = colours(cx);
        div().id(field).relative().h_flex().flex_none().h(px(24.)).max_w(px(260.)).pl(px(6.)).pr(px(8.)).gap(px(4.)).rounded_full()
            .border(px(0.5)).border_color(c.edge_3).text_size(px(12.)).font_medium().text_color(if unset { c.text_3 } else { c.text_2 })
            .cursor_pointer().hover(|s| s.bg(c.active))
            .child(div().flex().flex_none().w(px(14.)).justify_center().child(icon))
            .child(div().min_w_0().truncate().child(words))
            .child(self.anchors.probe(format!("chip-{field}")))
            .on_click(cx.listener(move |c, _, window, cx| c.choose(field, window, cx)))
            .tip(tip)
    }
}

impl Render for Creator {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = colours(cx);
        let theme = cx.theme();
        let (fill, hover) = (theme.primary, theme.primary_hover);
        let mut overlay: Hsla = rgb(0x000000).into();
        overlay.a = if c.dark { 0.4 } else { 0.25 };
        let viewport = window.viewport_size();
        let (state, priority) = (self.get("state"), self.get("priority"));
        let named = |k: &str, none: &str| { let t = self.get(&format!("{k}Title")); if !t.is_empty() { t } else if !self.get(k).is_empty() { self.get(k) } else { none.into() } };
        let chips = div().flex().flex_wrap().gap(px(6.)).mt(px(6.))
            .child(self.chip("state", "Change status", theme::state_icon(&state, cx).into_any_element(), state_name(&state).into(), false, cx))
            .child(self.chip("priority", "Change priority", priority_icon(&priority, cx).size(px(14.)).into_any_element(),
                if priority == "none" { "Priority".into() } else { priority_name(&priority).into() }, priority == "none", cx))
            .child(self.chip("parent", "Set parent", theme::glyph("parent", c.text_3).size(px(14.)).into_any_element(), named("parent", "Parent"), self.get("parent").is_empty(), cx))
            .child(self.chip("team", "Set team", theme::glyph("team", c.text_3).size(px(14.)).into_any_element(), named("team", "Team"), self.get("team").is_empty(), cx))
            .child(self.chip("project", "Set project", theme::glyph("project", c.text_3).size(px(14.)).into_any_element(), named("project", "Project"), self.get("project").is_empty(), cx));
        let on = self.more;
        let switch = div().id("create-more").h_flex().gap(px(6.)).text_size(px(12.)).text_color(c.text_3).cursor_pointer()
            .child(div().relative().w(px(22.)).h(px(14.)).rounded_full().bg(if on { c.accent } else { c.active })
                .when(!on, |s| s.border(px(0.5)).border_color(c.edge_3))
                .child(div().absolute().top(px(if on { 2. } else { 1.5 })).left(px(if on { 10. } else { 1.5 })).size(px(10.)).rounded_full().bg(if on { rgb(0xffffff).into() } else { c.text_3 })))
            .child("Create more")
            .on_click(cx.listener(|c, _, _, cx| {
                c.more = !c.more;
                if let Some(f) = file(MORE) { if c.more { let _ = std::fs::write(f, "1"); } else { let _ = std::fs::remove_file(f); } }
                cx.notify();
            }));
        let create = div().id("create").h_flex().h(px(28.)).px(px(10.)).rounded_full().bg(fill).text_size(px(12.)).font_medium().text_color(rgb(0xffffff))
            .cursor_pointer().hover(move |s| s.bg(hover))
            .child("Create issue")
            .on_click(cx.listener(|c, _, window, cx| c.submit(window, cx)))
            .tip("Create issue  Ctrl Enter");
        let close = div().id("create-close").flex().items_center().justify_center().size(px(28.)).ml_auto().rounded_full().cursor_pointer()
            .hover(|s| s.bg(c.active))
            .child(theme::glyph("close", c.text_3))
            .on_click(cx.listener(|c, _, _, cx| c.close(true, cx)))
            .tip("Close  Esc");
        let panel = div()
            .id("create-panel")
            .occlude()
            .v_flex()
            .w(px(750.).min(viewport.width - px(32.)))
            .p(px(13.))
            .rounded(px(21.))
            .border(px(0.5))
            .border_color(c.pop_edge)
            .bg(c.pop)
            .shadow(pop_shadow(c.dark))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(div().h_flex().h(px(28.)).pl(px(6.)).text_color(c.text_2).child("New issue").child(close))
            .child(div().mt(px(17.)).px(px(6.)).text_size(px(18.)).line_height(px(26.)).font_semibold().text_color(c.text_1)
                .child(Textarea::new(&self.title).appearance(false).with_size(InputSize::XSmall).text_size(px(18.)).line_height(px(26.))))
            .child(div().px(px(6.)).pt(px(6.)).pb(px(12.)).min_h(px(76.)).text_size(px(15.)).line_height(px(22.5)).text_color(c.text_2)
                .child(Textarea::new(&self.body).appearance(false).with_size(InputSize::XSmall).text_size(px(15.)).line_height(px(22.5))))
            .child(chips)
            .child(div().h_flex().justify_end().gap(px(12.)).mt(px(24.)).child(switch).child(create));
        div()
            .id("creator")
            .occlude()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .bg(overlay)
            .flex()
            .flex_col()
            .items_center()
            .pt(viewport.height * 0.13)
            // Esc closes the menu open, else the panel; Ctrl Enter creates
            .capture_action(cx.listener(|c, _: &Escape, _, cx| {
                if c.menu.is_some() { return }
                cx.stop_propagation();
                c.close(true, cx);
            }))
            .capture_key_down(cx.listener(|c, e: &KeyDownEvent, window, cx| {
                let k = &e.keystroke;
                if c.menu.is_none() && k.key == "enter" && k.modifiers.control {
                    cx.stop_propagation();
                    c.submit(window, cx);
                }
            }))
            .on_mouse_down(MouseButton::Left, cx.listener(|c, _, _, cx| { if c.menu.is_none() { c.close(true, cx) } }))
            .child(panel)
            .children(self.menu.as_ref().map(|(menu, at, _)| anchored().position(*at).snap_to_window_with_margin(px(8.)).child(menu.clone())))
    }
}
