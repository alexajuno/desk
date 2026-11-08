// desk's look in the native window: the web app's Linear palettes (apps/web/src/styles/desk.css, where they were
// measured) as a gpui-component theme, following the system's light or dark; and desk's status icons (ui/icons.tsx),
// drawn from the same SVG shapes in the same colours.
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use gpui_kit::component::theme::{Theme, ThemeSet};
use gpui_kit::component::ActiveTheme;
use gpui_kit::*;

const THEMES: &str = include_str!("desk-theme.json");

pub fn init(window: &mut Window, cx: &mut App) {
    let set: ThemeSet = serde_json::from_str(THEMES).expect("desk-theme.json");
    for config in set.themes {
        let dark = config.mode.is_dark();
        let theme = Theme::global_mut(cx);
        if dark { theme.dark_theme = Rc::new(config) } else { theme.light_theme = Rc::new(config) }
    }
    sync(window, cx);
}

// The system's light or dark, as the web app follows it, unless DESK_THEME says which.
pub fn sync(window: &mut Window, cx: &mut App) {
    match std::env::var("DESK_THEME").as_deref() {
        Ok("light") => Theme::change(gpui_kit::component::theme::ThemeMode::Light, Some(window), cx),
        Ok("dark") => Theme::change(gpui_kit::component::theme::ThemeMode::Dark, Some(window), cx),
        _ => Theme::sync_system_appearance(Some(window), cx),
    }
}

// The greys of the text, by how much it matters, which the theme has no names for: names and titles brightest,
// details grey, hints dim (desk.css, --text-1 to --text-4).
pub struct Text {
    pub strong: Hsla,
    pub divider: Hsla,
}

pub fn text(cx: &App) -> Text {
    if cx.theme().mode.is_dark() {
        Text { strong: rgb(0xffffff).into(), divider: rgb(0x1a1b1d).into() }
    } else {
        Text { strong: rgb(0x1b1b1b).into(), divider: rgb(0xf1f1f1).into() }
    }
}

// desk.css's --state-* colours.
fn state_colour(state: &str, dark: bool) -> &'static str {
    match (state, dark) {
        ("triage", _) => "#fc7840",
        ("backlog" | "todo", true) => "#bec2c8",
        ("backlog" | "todo", false) => "#a2a6ac",
        ("running", _) => "#f0bf00",
        ("review", true) => "#4cb782",
        ("review", false) => "#43bc58",
        ("done" | "landing", _) => "#5e6ad2",
        ("waiting", _) => "#f2994a",
        _ => "#95a2b3",
    }
}

// The SVG of ui/icons.tsx's StateIcon, drawn four times its size so it stays sharp on a 2x screen.
fn state_svg(state: &str, dark: bool) -> String {
    let c = state_colour(state, dark);
    let cross = if dark { "#1a1a1a" } else { "#ffffff" };
    let body = match state {
        "done" => format!(r##"<circle cx="7" cy="7" r="6.25" fill="{c}"/><path d="M4.4 7.1l1.8 1.8 3.4-3.6" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>"##),
        "dropped" => format!(r#"<circle cx="7" cy="7" r="6.25" fill="{c}"/><path d="M5 5l4 4M9 5l-4 4" stroke="{cross}" stroke-width="1.5" stroke-linecap="round"/>"#),
        "triage" => format!(r##"<circle cx="7" cy="7" r="6.25" fill="{c}"/><path d="M4.25 5.6h5.5M8.1 3.95l1.65 1.65M9.75 8.4h-5.5M5.9 10.05L4.25 8.4" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>"##),
        "waiting" => format!(r#"<circle cx="7" cy="7" r="6" fill="none" stroke="{c}" stroke-width="1.5"/><path d="M5.6 4.9v4.2M8.4 4.9v4.2" stroke="{c}" stroke-width="1.5" stroke-linecap="round"/>"#),
        _ => {
            let fill = match state { "running" => 0.5, "review" => 0.75, "landing" => 0.9, _ => 0.0 };
            let dash = if state == "backlog" { r#" stroke-dasharray="1.4 1.74" stroke-dashoffset="0.65""# } else { "" };
            let mut s = format!(r#"<circle cx="7" cy="7" r="6" fill="none" stroke="{c}" stroke-width="1.5"{dash}/>"#);
            if fill > 0.0 {
                s += &format!(r#"<circle cx="7" cy="7" r="2" fill="none" stroke="{c}" stroke-width="4" stroke-dasharray="{:.3} 12.566" transform="rotate(-90 7 7)"/>"#, 12.566 * fill);
            }
            s
        }
    };
    format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 14 14">{body}</svg>"#)
}

thread_local! {
    static ICONS: RefCell<HashMap<(String, bool), Arc<Image>>> = RefCell::new(HashMap::new());
}

pub fn state_icon(state: &str, cx: &App) -> Img {
    let dark = cx.theme().mode.is_dark();
    let image = ICONS.with(|icons| {
        icons
            .borrow_mut()
            .entry((state.to_string(), dark))
            .or_insert_with(|| Arc::new(Image::from_bytes(ImageFormat::Svg, state_svg(state, dark).into_bytes())))
            .clone()
    });
    img(image).flex_none().size(px(14.))
}

// desk's glyphs (ui/icons.tsx, GLYPH), Linear's thin icons, in the grey of the text around them. Each is its path
// in a 16-unit box, stroked as GLYPH's `glyph` strokes it.
fn glyph_path(name: &str) -> &'static str {
    match name {
        "steps" => r#"<path d="M2.5 4.25l1.25 1.25 2-2.25M2.5 11.25l1.25 1.25 2-2.25"/><path d="M8 4.25h5.5M8 11.75h5.5"/>"#,
        "terminal" => r#"<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M4.5 6l2 2-2 2M8 10.5h3.5"/>"#,
        "changes" => r#"<path d="M9 1.75H4.75a1.25 1.25 0 0 0-1.25 1.25v10c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V5.25zM9 1.75v3.5h3.5M8 5.25v3M6.5 6.75h3M6.5 10.75h3"/>"#,
        _ => "",
    }
}

thread_local! {
    static GLYPHS: RefCell<HashMap<(String, u32), Arc<Image>>> = RefCell::new(HashMap::new());
}

pub fn glyph(name: &str, colour: Hsla) -> Img {
    let rgba = colour.to_rgb();
    let key = ((rgba.r * 255.) as u32) << 24 | ((rgba.g * 255.) as u32) << 16 | ((rgba.b * 255.) as u32) << 8 | (rgba.a * 255.) as u32;
    let image = GLYPHS.with(|glyphs| {
        glyphs
            .borrow_mut()
            .entry((name.to_string(), key))
            .or_insert_with(|| {
                let hex = format!("#{:06x}", key >> 8);
                let svg = format!(
                    r#"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 16 16" fill="none" stroke="{hex}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">{}</svg>"#,
                    glyph_path(name)
                );
                Arc::new(Image::from_bytes(ImageFormat::Svg, svg.into_bytes()))
            })
            .clone()
    });
    img(image).flex_none().size(px(16.))
}
