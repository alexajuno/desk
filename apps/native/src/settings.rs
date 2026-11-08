// Settings, as the web app's (settings/SettingsPage.tsx, after Linear's; desk.css holds what was measured): a sidebar
// of its own in place of the issues, Back to app over the list of pages, and each page a 640px column of cards, one
// row per setting. Preferences holds the theme, whether the stash comes back on send, the model and effort a new chat
// starts on and whether Haiku picks them, how many test desks run at once and how long a chat grows before it compacts;
// Workflows & automations holds the two auto-close switches. desk keeps them all (GET and PATCH /api/settings, the
// server's settings.ts) but the theme, which the web keeps in each browser and the window in a file of its own
// (theme.rs). Ctrl , opens it, as the web's.
use gpui_kit::base::StyledExt;
use gpui_kit::component::button::{Button, ButtonCustomVariant, ButtonVariants};
use gpui_kit::component::menu::{DropdownMenu, PopupMenuItem};
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::{json, Value};

use crate::filters::ring;
use crate::{live, net, theme, Desk, Page};

#[derive(Clone, Copy, PartialEq)]
pub enum Section {
    Preferences,
    Workflow,
}

impl Section {
    pub fn title(self) -> &'static str {
        match self {
            Section::Preferences => "Preferences",
            Section::Workflow => "Workflows & automations",
        }
    }
}

// The sidebar's pages, under their group's label.
const PAGES: [(&str, Section, &str); 2] = [("Personal", Section::Preferences, "sliders"), ("Issues", Section::Workflow, "parent")];

// Each setting's name and what it does, in the web's words (SETTINGS).
fn about(id: &str) -> (&'static str, &'static str) {
    match id {
        "theme" => ("Interface theme", "Follow the system, or keep desk light or dark"),
        "stash_back_on_send" => ("Bring the stash back on send",
            "What Ctrl S put away comes back into the box as soon as you send the next message, as in Claude Code. Off, it waits for Ctrl S"),
        "chat_pick" => ("Haiku picks the model",
            "Haiku reads a new chat's first message and picks its model and effort, unless you moved its chip first. Model and Effort below are what it falls back on"),
        "chat_model" => ("Model", "The model a new chat or issue session starts with"),
        "chat_effort" => ("Effort", "How hard a new chat or issue session thinks before it answers"),
        "test_slots" => ("Test desks at once",
            "How many sessions may test a branch at once, each on its own copy of your data, while more than 4 GB of memory is free"),
        "compact_over" => ("Compact a chat over", "A chat this long compacts as a turn ends on a step done, or when it marks a break itself"),
        "parent_auto_close" => ("Auto-close parent issues", "Automatically close an open parent issue when its last sub-issue is closed"),
        "sub_issue_auto_close" => ("Auto-close sub-issues", "Automatically close all sub-issues when their parent issue is closed"),
        _ => ("", ""),
    }
}

const THEMES: [(&str, &str); 3] = [("system", "System preference"), ("light", "Light"), ("dark", "Dark")];
const SLOTS: [u64; 4] = [1, 2, 3, 4]; // settings.ts, MAX_SLOTS
const COMPACTS: [u64; 6] = [100_000, 150_000, 200_000, 300_000, 400_000, 500_000];

fn thousands(tokens: u64) -> String {
    format!("{}k", (tokens as f64 / 1000.).round())
}

// desk.css's Settings tokens, its lch() values in hex: the card (--bg-card), its ring and shadow (--shadow-card), the
// hairline between rows, the switch off and on (--switch-off, --btn-primary) and its knob (--btn-primary-text), and the
// pick buttons (--btn, --btn-hover).
struct Look {
    card: Hsla,
    card_shadow: Vec<BoxShadow>,
    hairline: Hsla,
    off: Hsla,
    on: Hsla,
    knob: Hsla,
    button: Hsla,
    button_hover: Hsla,
}

fn look(cx: &App) -> Look {
    let c = |hex: u32| -> Hsla { rgb(hex).into() };
    let alpha = |hex: u32, a: f32| -> Hsla { let mut h: Hsla = rgb(hex).into(); h.a = a; h };
    let drop = |colour: Hsla, y: f32, blur: f32, spread: f32| BoxShadow { color: colour, offset: point(px(0.), px(y)), blur_radius: px(blur), spread_radius: px(spread), inset: false };
    if cx.theme().mode.is_dark() {
        Look {
            card: c(0x1a1a1b),
            card_shadow: vec![ring(alpha(0xffffff, 0.083), 0.5), drop(alpha(0x000000, 0.3), 0.5, 1., 1.)],
            hairline: alpha(0xffffff, 0.083),
            off: c(0x707172), on: c(0x5e6ad2), knob: c(0xfffeff), button: c(0x1b1c1d), button_hover: c(0x252527),
        }
    } else {
        Look {
            card: c(0xffffff),
            card_shadow: vec![ring(alpha(0x000000, 0.088), 0.5), drop(alpha(0x000000, 0.02), 3., 6., -2.), drop(alpha(0x000000, 0.04), 1., 1., 0.)],
            hairline: alpha(0x000000, 0.088),
            off: c(0xc6c6c9), on: c(0x6d78d5), knob: c(0xfffeff), button: c(0xffffff), button_hover: c(0xf3f3f3),
        }
    }
}

pub struct SettingsPage {
    pub section: Section,
    shown: Option<Value>, // desk's settings, as last heard, with a change shown before desk answers
    models: Vec<live::Model>,
    notice: Option<String>, // what desk said when it refused a change
    scroll: ScrollHandle,
    hair: Pixels, // one pixel of the screen
}

impl SettingsPage {
    pub fn new(section: Section, cx: &mut Context<Self>) -> Self {
        cx.spawn(async move |this, cx| {
            let (got, models) = cx.background_spawn(async { (net::get("/api/settings"), live::models()) }).await;
            let _ = this.update(cx, |page, cx| {
                match got {
                    Ok(settings) => page.shown = Some(settings),
                    Err(error) => page.notice = Some(error),
                }
                page.models = models.unwrap_or_default();
                cx.notify();
            });
        })
        .detach();
        Self { section, shown: None, models: Vec::new(), notice: None, scroll: ScrollHandle::new(), hair: px(1.) }
    }

    // A change shows at once, and goes back if desk refuses it, saying why.
    fn change(&mut self, name: &'static str, value: Value, cx: &mut Context<Self>) {
        let Some(was) = self.shown.clone() else { return };
        let mut now = was.clone();
        now[name] = value.clone();
        self.shown = Some(now);
        self.notice = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let done = cx.background_spawn(async move { net::patch("/api/settings", json!({ name: value })) }).await;
            let _ = this.update(cx, |page, cx| {
                match done {
                    Ok(settings) => page.shown = Some(settings),
                    Err(error) => {
                        page.shown = Some(was);
                        page.notice = Some(error);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    // A card of rows under its section's heading, as Linear's: 48px under the card before it, 32px under the title. Its
    // rows are parted by a hairline, one pixel of the screen's (0.5px on a 2x screen, as the web's).
    fn section(hair: Pixels, first: bool, title: &'static str, note: Option<&'static str>, rows: Vec<Div>, cx: &App) -> Div {
        let l = look(cx);
        let (strong, muted) = (theme::text(cx).strong, cx.theme().muted_foreground);
        let mut card = div().v_flex().mt(px(16.)).rounded(px(10.)).bg(l.card).shadow(l.card_shadow);
        for (i, row) in rows.into_iter().enumerate() {
            // rows are parted by a hairline 16px in from each side
            card = card.child(row.when(i > 0, |row| row.child(div().absolute().top_0().left(px(16.)).right(px(16.)).h(hair).bg(l.hairline))));
        }
        div()
            .v_flex()
            .mt(px(if first { 32. } else { 48. }))
            .child(div().mx(px(16.)).text_size(px(15.)).line_height(px(23.)).font_medium().text_color(strong).child(title))
            .when_some(note, |s, note| s.child(div().mx(px(16.)).text_size(px(13.)).line_height(px(22.)).text_color(muted).child(note)))
            .child(card)
    }

    // A setting's row: its name and what it does, and its control at the right.
    fn row(id: &'static str, control: impl IntoElement, cx: &App) -> Div {
        let (name, note) = about(id);
        let (strong, muted) = (theme::text(cx).strong, cx.theme().muted_foreground);
        div()
            .relative()
            .h_flex()
            .gap(px(12.))
            .min_h(px(60.))
            .p(px(16.))
            .child(
                div()
                    .v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(px(2.))
                    .child(div().text_size(px(13.)).font_medium().text_color(strong).child(name))
                    .child(div().text_size(px(12.)).text_color(muted).child(note)),
            )
            .child(control)
    }

    // Linear's switch: a 30x20 pill, its 14px knob 3px in from the end it is at.
    fn switch(&self, id: &'static str, cx: &mut Context<Self>) -> Stateful<Div> {
        let l = look(cx);
        let on = self.shown.as_ref().and_then(|s| s[id].as_bool()).unwrap_or(false);
        div()
            .id(id)
            .relative()
            .flex_none()
            .w(px(30.))
            .h(px(20.))
            .mr(px(6.))
            .rounded(px(10.))
            .cursor_pointer()
            .bg(if on { l.on } else { l.off })
            .child(div().absolute().top(px(3.)).left(px(if on { 13. } else { 3. })).size(px(14.)).rounded_full().bg(l.knob))
            .on_click(cx.listener(move |page, _, _, cx| page.change(id, json!(!on), cx)))
    }

    // A setting picked from a menu: what it is now and a chevron, on a quiet raised button.
    fn pick(&self, id: &'static str, words: String, items: Vec<(String, Value, bool, Option<&'static str>)>, cx: &mut Context<Self>) -> AnyElement {
        let l = look(cx);
        let (strong, muted) = (theme::text(cx).strong, cx.theme().muted_foreground);
        let this = cx.entity().downgrade();
        let variant = ButtonCustomVariant::new(cx).color(l.button).hover(l.button_hover).active(l.button_hover).foreground(strong);
        Button::new(id)
            .custom(variant)
            .h(px(30.))
            .pl(px(10.))
            .pr(px(8.))
            .rounded(px(6.))
            .shadow(l.card_shadow)
            .child(div().h_flex().gap(px(6.)).text_size(px(13.)).font_normal().child(words).child(theme::glyph("chevron", muted).size(px(12.))))
            .dropdown_menu_with_anchor(Anchor::TopRight, move |mut menu, _, _| {
                for (label, value, current, glyph) in items.clone() {
                    let this = this.clone();
                    let item = match glyph {
                        Some(glyph) => PopupMenuItem::element(move |_, cx| {
                            div().h_flex().gap_2().child(theme::glyph(glyph, cx.theme().muted_foreground)).child(label.clone())
                        }),
                        None => PopupMenuItem::new(label),
                    };
                    menu = menu.item(item.checked(current).on_click(move |_, window, cx| {
                        let _ = this.update(cx, |page, cx| {
                            if id == "theme" {
                                theme::choose(value.as_str().unwrap_or("system"), window, cx);
                                cx.notify();
                            } else {
                                page.change(id, value.clone(), cx);
                            }
                        });
                    }));
                }
                menu
            })
            .into_any_element()
    }

    fn preferences(&self, cx: &mut Context<Self>) -> Vec<Div> {
        let chosen = theme::chosen();
        let themes = THEMES.iter().map(|(v, l)| (l.to_string(), json!(v), *v == chosen, Some(*v))).collect();
        let theme_name = THEMES.iter().find(|(v, _)| *v == chosen).map(|(_, l)| *l).unwrap_or("System preference").to_string();
        let mut sections = vec![Self::section(self.hair, true, "Interface and theme", None, vec![Self::row("theme", self.pick("theme", theme_name, themes, cx), cx)], cx)];
        let Some(shown) = self.shown.clone() else { return sections };
        sections.push(Self::section(self.hair, false, "Composer", None, vec![Self::row("stash_back_on_send", self.switch("stash_back_on_send", cx), cx)], cx));
        let model_now = shown["chat_model"].as_str().unwrap_or("").to_string();
        let effort_now = shown["chat_effort"].as_str().unwrap_or("").to_string();
        let model = self.models.iter().find(|m| m.value == model_now);
        let models = self.models.iter().map(|m| (m.name.clone(), json!(m.value), m.value == model_now, None)).collect();
        let efforts = live::EFFORTS.iter()
            .filter(|(v, _)| model.is_none_or(|m| m.efforts.iter().any(|e| e == v)))
            .map(|(v, l)| (l.to_string(), json!(v), *v == effort_now, None))
            .collect();
        let slots_now = shown["test_slots"].as_u64().unwrap_or(1);
        let slots = SLOTS.iter().map(|n| (n.to_string(), json!(n), *n == slots_now, None)).collect();
        let compact_now = shown["compact_over"].as_u64().unwrap_or(300_000);
        let compacts = COMPACTS.iter().map(|n| (thousands(*n), json!(n), *n == compact_now, None)).collect();
        let rows = vec![
            Self::row("chat_pick", self.switch("chat_pick", cx), cx),
            Self::row("chat_model", self.pick("chat_model", model.map(|m| m.name.clone()).unwrap_or(model_now.clone()), models, cx), cx),
            Self::row("chat_effort", self.pick("chat_effort", live::effort_name(&effort_now).to_string(), efforts, cx), cx),
            Self::row("test_slots", self.pick("test_slots", slots_now.to_string(), slots, cx), cx),
            Self::row("compact_over", self.pick("compact_over", thousands(compact_now), compacts, cx), cx),
        ];
        sections.push(Self::section(self.hair, false, "Sessions", None, rows, cx));
        sections
    }

    fn workflow(&self, cx: &mut Context<Self>) -> Vec<Div> {
        if self.shown.is_none() { return Vec::new() }
        let rows = vec![
            Self::row("parent_auto_close", self.switch("parent_auto_close", cx), cx),
            Self::row("sub_issue_auto_close", self.switch("sub_issue_auto_close", cx), cx),
        ];
        vec![Self::section(self.hair, true, "Auto-close automations", Some("Automate closing issues based on status changes to related issues."), rows, cx)]
    }
}

impl Render for SettingsPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.hair = px(1. / window.scale_factor());
        let t = theme::text(cx);
        let (fg, muted) = (cx.theme().foreground, cx.theme().muted_foreground);
        let sections = match self.section {
            Section::Preferences => self.preferences(cx),
            Section::Workflow => self.workflow(cx),
        };
        let column = div()
            .v_flex()
            .w(px(640.))
            .max_w_full()
            .pt(px(19.))
            .pb(px(120.))
            .child(div().mx(px(16.)).text_size(px(24.)).line_height(px(32.)).font_medium().text_color(t.strong).child(self.section.title()))
            .when(self.section == Section::Workflow, |c| {
                c.child(div().mx(px(16.)).text_size(px(13.)).line_height(px(22.)).text_color(muted).child("Manage issue automations and other workflows."))
            })
            .when_some(self.notice.clone(), |c, words| c.child(div().mx(px(16.)).mt(px(8.)).text_size(px(12.)).text_color(t.waiting).child(words)))
            .children(sections);
        div()
            .v_flex()
            .size_full()
            .child(div().h_flex().flex_none().h(px(44.)).px(px(16.)).border_b_1().border_color(t.divider).font_medium().text_color(fg).child("Settings"))
            .child(
                div()
                    .id("settings-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .child(div().h_flex().justify_center().px(px(16.)).child(column)),
            )
    }
}

// The sidebar while Settings shows, in place of the issues: Back to app, which returns to the page you left, then each
// group's pages.
impl Desk {
    pub(crate) fn open_settings(&mut self, section: Section, cx: &mut Context<Self>) {
        if self.page != Page::Settings { self.back_to = self.page }
        self.page = Page::Settings;
        match &self.settings {
            Some(page) if page.read(cx).section == section => {}
            _ => self.settings = Some(cx.new(|cx| SettingsPage::new(section, cx))),
        }
        cx.notify();
    }

    pub(crate) fn leave_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.settings = None;
        match self.back_to {
            Page::Inbox => self.show_inbox(window, cx),
            _ => {
                self.page = Page::Issue;
                self.tell_shown(cx);
            }
        }
        cx.notify();
    }

    pub(crate) fn settings_nav(&self, cx: &mut Context<Self>) -> Div {
        let theme = cx.theme();
        let (hover, active, muted, fg) = (theme.list_hover, theme.list_active, theme.muted_foreground, theme.foreground);
        let strong = theme::text(cx).strong;
        let here = self.settings.as_ref().map(|p| p.read(cx).section);
        let item = |id: &'static str, glyph: &'static str, words: &'static str, on: bool| {
            div()
                .id(id)
                .h_flex()
                .h(px(28.))
                .mx_2()
                .pl(px(6.))
                .pr(px(9.))
                .gap(px(8.))
                .rounded(px(8.))
                .font_medium()
                .cursor_pointer()
                .text_color(if on { strong } else { muted })
                .when(on, |n| n.bg(active))
                .when(!on, |n| n.hover(|s| s.bg(hover).text_color(fg)))
                .child(theme::glyph(glyph, muted))
                .child(words)
        };
        let mut nav = div()
            .v_flex()
            .flex_none()
            .w(px(240.))
            .h_full()
            .pt_3()
            .child(item("settings-back", "chevron-left", "Back to app", false).text_color(fg).mb(px(8.))
                .on_click(cx.listener(|desk, _, window, cx| desk.leave_settings(window, cx))));
        for (group, section, glyph) in PAGES {
            let id = if section == Section::Preferences { "settings-preferences" } else { "settings-workflow" };
            nav = nav
                .child(div().h_flex().h(px(40.)).pt(px(12.)).mx_2().px(px(6.)).text_xs().font_medium().text_color(muted).child(group))
                .child(item(id, glyph, section.title(), here == Some(section)).on_click(cx.listener(move |desk, _, _, cx| desk.open_settings(section, cx))));
        }
        nav
    }
}
