// The bar along the window's bottom, as the web's (frame/StatusBar.tsx), which copies VS Code's status bar ("a bottom
// status bar like vs code", the user, 1 Nov): the Help menu's ? at its left end, where Linear keeps Help, and what holds
// for the whole account at its right. That is seat's live Claude profile by name, then that profile's own numbers, each
// a ring after its grey word: a plan's 5-hour and Week, or api's credits left. The name opens the profiles, to make one
// live, and Auto switch, seat's own switching. desk asks the server each minute, which reads seat at most each half
// minute (seat.ts there).
use chrono::{DateTime, Local, TimeZone};
use gpui_kit::base::StyledExt;
use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::menu::{DropdownMenu, PopupMenuItem};
use gpui_kit::component::ActiveTheme;
use gpui_kit::*;
use serde_json::{json, Value};

use crate::sidebar::menu_row;
use crate::tip::Tipped;
use crate::{net, theme, toast, Desk};

pub(crate) const BAR: f32 = 32.;

struct Meter {
    word: &'static str,
    percent: u32, // used, for its ring
    text: String, // "96%", "$64 left", or a dash for a meter seat could not read
    about: String, // when it resets, or what is spent
}

// Dollars, whole ones from ten up and cents under: "$64", "$4.20".
fn dollars(n: f64) -> String {
    if n >= 10. { format!("${}", n.round()) } else { format!("${:.2}", n.max(0.)) }
}

// When a window resets, to the nearest minute (seat says 05:59:59.9 for 06:00): the time today, or the day and time
// when it is further off.
fn resets(iso: &str) -> String {
    let Ok(at) = DateTime::parse_from_rfc3339(iso) else { return iso.to_string() };
    let minute = (at.timestamp_millis() as f64 / 60_000.).round() as i64 * 60;
    let Some(at) = Local.timestamp_opt(minute, 0).single() else { return iso.to_string() };
    if (at - Local::now()).num_hours() < 20 { at.format("%H:%M").to_string() } else { at.format("%a %H:%M").to_string() }
}

// A profile's own numbers: a plan's 5-hour and Week, or api's credits, each after its word.
fn meters(p: &Value) -> Vec<Meter> {
    if p["kind"] == "api" {
        let c = &p["credits"];
        if !c.is_object() {
            return vec![Meter { word: "Credits", percent: 0, text: "–".into(), about: "seat has not counted them".into() }];
        }
        let (budget, spent, out) = (c["budget"].as_f64().unwrap_or(0.), c["spent"].as_f64().unwrap_or(0.), c["out"] == true);
        let percent = if out || budget <= 0. { 100 } else { ((spent / budget) * 100.).round().min(100.) as u32 };
        return vec![Meter {
            word: "Credits",
            percent,
            text: if out { "out".into() } else { format!("{} left", dollars(budget - spent)) },
            about: if out { "the API said they are gone".into() } else { format!("${spent:.2} of {} spent", dollars(budget)) },
        }];
    }
    let limit = |word: &'static str, w: &Value| match w["percent"].as_u64() {
        Some(percent) => Meter {
            word,
            percent: percent as u32,
            text: format!("{percent}%"),
            about: w["resets"].as_str().map_or_else(|| "not started".into(), |at| format!("resets {}", resets(at))),
        },
        None => Meter { word, percent: 0, text: "–".into(), about: "seat has no number for it".into() },
    };
    vec![limit("5-hour", &p["five_hour"]), limit("Week", &p["week"])]
}

// The same numbers in a line, for a profile's row in the menu: "5-hour 67% · Week 59%", "$64 of $100 left".
fn summary(p: &Value) -> String {
    if p["kind"] == "api" {
        let c = &p["credits"];
        if !c.is_object() { return "Credits –".into() }
        if c["out"] == true { return "Credits out".into() }
        let (budget, spent) = (c["budget"].as_f64().unwrap_or(0.), c["spent"].as_f64().unwrap_or(0.));
        return format!("{} of {} left", dollars(budget - spent), dollars(budget));
    }
    let limit = |word: &str, w: &Value| format!("{word} {}", w["percent"].as_u64().map_or("–".into(), |p| format!("{p}%")));
    format!("{} · {}", limit("5-hour", &p["five_hour"]), limit("Week", &p["week"]))
}

impl Desk {
    // seat, as the server reads it, now and each minute after.
    pub(crate) fn watch_seat(cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| loop {
            let seat = cx.background_spawn(async { net::get("/api/seat") }).await;
            let gone = this.update(cx, |desk, cx| {
                desk.seat = seat.ok().filter(Value::is_object);
                cx.notify();
            });
            if gone.is_err() { break }
            cx.background_executor().timer(std::time::Duration::from_secs(60)).await;
        })
        .detach();
    }

    // Makes a profile the live one, or turns seat's own switching on or off; the bar then shows what seat says.
    fn ask_seat(&mut self, what: &'static str, body: Value, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let answer = cx.background_spawn(async move { net::post(&format!("/api/seat/{what}"), body) }).await;
            let _ = this.update(cx, |desk, cx| {
                match answer {
                    Ok(seat) => desk.seat = Some(seat).filter(Value::is_object),
                    Err(e) => toast::say(e, cx),
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn status_bar(&self, cx: &mut Context<Self>) -> Div {
        let theme = cx.theme();
        let (fg, muted) = (theme.foreground, theme.muted_foreground);
        let text = theme::text(cx);
        let strong = text.strong;
        let icon_hover = if theme.mode.is_dark() { rgb(0x1b1c1d).into() } else { hsla(0., 0., 0., 0.06) };
        // Linear's Help menu, cut to the keyboard shortcuts, and Settings, which Linear opens from its workspace menu
        let this = cx.entity().downgrade();
        let help = Button::new("help-open")
            .ghost()
            .size(px(28.))
            .rounded_full()
            .child(theme::glyph("help", muted))
            .dropdown_menu_with_anchor(Anchor::BottomLeft, move |menu, _, _| {
                let (keys, settings) = (this.clone(), this.clone());
                menu.item(menu_row("keys", "Keyboard shortcuts", Some("Ctrl /")).on_click(move |_, _, cx| {
                    let _ = keys.update(cx, |desk, cx| desk.show_soon("keyboard shortcuts", cx));
                }))
                .item(menu_row("sliders", "Settings", Some("Ctrl ,")).on_click(move |_, _, cx| {
                    let _ = settings.update(cx, |desk, cx| desk.open_settings(crate::settings::Section::Preferences, cx));
                }))
            });
        let help = div().id("help-tip").ml(px(1.)).child(help).tip("Help, shortcuts and settings");
        let live = self.seat.as_ref().and_then(|s| s["profiles"].as_array()?.iter().find(|p| p["active"] == true).cloned());
        let used = live.map(|live| {
            let seat = self.seat.clone().unwrap_or_default();
            let this = cx.entity().downgrade();
            // seat's live profile by name: a quiet chip, filled only under the mouse, its name a step brighter than the
            // numbers
            let profile = Button::new("profile")
                .ghost()
                .h(px(24.))
                .px(px(6.))
                .gap(px(4.))
                .rounded(px(6.))
                .text_xs()
                .text_color(fg)
                .child(live["name"].as_str().unwrap_or("").to_string())
                .child(theme::glyph("chevron-down", text.dim).size(px(10.)))
                .dropdown_menu_with_anchor(Anchor::BottomRight, move |mut menu, _, _| {
                    menu = menu.label("Profile");
                    for p in seat["profiles"].as_array().into_iter().flatten() {
                        let (name, hint, active) = (p["name"].as_str().unwrap_or("").to_string(), summary(p), p["active"] == true);
                        let this = this.clone();
                        let row = name.clone();
                        menu = menu.item(
                            PopupMenuItem::element(move |_, cx| {
                                let muted = cx.theme().muted_foreground;
                                div().h_flex().w_full().gap_2().child(div().flex_1().child(row.clone()))
                                    .child(div().pl_4().text_xs().text_color(muted).child(hint.clone()))
                            })
                            .checked(active)
                            .on_click(move |_, _, cx| {
                                if !active { let _ = this.update(cx, |desk, cx| desk.ask_seat("switch", json!({"name": name}), cx)); }
                            }),
                        );
                    }
                    // Auto switch, once seat says whether it is on
                    if let Some(auto) = seat["auto"].as_bool() {
                        let this = this.clone();
                        menu = menu.separator().item(
                            PopupMenuItem::element(|_, cx| {
                                let muted = cx.theme().muted_foreground;
                                div().h_flex().w_full().gap_2().child(div().flex_1().child("Auto switch"))
                                    .child(div().pl_4().text_xs().text_color(muted).child("seat picks when one is full"))
                            })
                            .checked(auto)
                            .on_click(move |_, _, cx| { let _ = this.update(cx, |desk, cx| desk.ask_seat("auto", json!({"on": !auto}), cx)); }),
                        );
                    }
                    menu
                });
            let profile = div().id("profile-tip").child(profile).tip("Switch profile");
            div().h_flex().flex_none().gap(px(2.)).child(profile).children(meters(&live).into_iter().enumerate().map(|(n, m)| {
                div()
                    .id(("meter", n))
                    .h_flex()
                    .gap(px(5.))
                    .h(px(24.))
                    .px(px(6.))
                    .rounded(px(6.))
                    .text_xs()
                    .text_color(muted)
                    .hover(move |s| s.bg(icon_hover).text_color(strong))
                    .child(div().mr(px(2.)).text_color(text.dim).child(m.word))
                    .child(theme::ring(m.percent, muted, text.faint))
                    .child(m.text)
                    .tip(format!("{} · {}", m.word, m.about))
            }))
        });
        div().h_flex().flex_none().h(px(BAR)).px(px(9.)).child(help).child(div().flex_1()).children(used)
    }
}
