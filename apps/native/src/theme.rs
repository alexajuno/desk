// desk's look in the native window: the web app's Linear palettes (apps/web/src/styles/desk.css, where they were
// measured) as a gpui-component theme, following the system's light or dark; and desk's status icons and glyphs
// (ui/icons.tsx), from the same SVG shapes in the same colours.
//
// The icons are drawn as Zed draws its own: each shape an SVG that GPUI renders as a mask at the screen's own pixels,
// then fills with a colour, so it stays round and sharp at 1x, 1.5x and 2x. An SVG drawn as a picture was rendered at
// its own size and shrunk with no smoothing, which left the circles' edges as steps (the user, 8 Nov: "why it's not
// rounded?", "the status icon"). An icon of two colours, such as a disc with a white tick, is two masks, one over the
// other. The shapes are served as assets under desk/, beside gpui-kit's own.
use std::borrow::Cow;
use std::rc::Rc;

use gpui_kit::component::theme::{Theme, ThemeSet};
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder;
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

// What desk.css names that the theme has no names for: the greys of the text by how much it matters (names and titles
// brightest, details grey, hints dim; the theme's foreground is --text-2 and its muted one --text-3), and the fills of
// the chat's own pieces.
pub struct Text {
    pub strong: Hsla,  // --text-1
    pub dim: Hsla,     // --text-4
    pub faint: Hsla,   // --text-5
    pub divider: Hsla,
    pub raised: Hsla,  // --bg-raised: the composer, a question's card
    pub hover: Hsla,   // --btn-ghost-hover: a quiet row under the mouse
    pub button: Hsla,  // --btn-hover: Stop
    pub edge: Hsla,    // --border-3: the composer's edge while it is typed in
    pub accent: Hsla,
    pub waiting: Hsla, // --state-waiting: a step that failed
    pub on_primary: Hsla,
}

pub fn text(cx: &App) -> Text {
    let c = |hex: u32| -> Hsla { rgb(hex).into() };
    if cx.theme().mode.is_dark() {
        Text {
            strong: c(0xffffff), dim: c(0x6a6a6c), faint: c(0x565759), divider: c(0x1a1b1d), raised: c(0x1a1a1b), hover: c(0x232424),
            button: c(0x252527), edge: c(0x28282b), accent: c(0x5e69d1), waiting: c(0xf2994a), on_primary: c(0xffffff),
        }
    } else {
        Text {
            strong: c(0x1b1b1b), dim: c(0x9c9d9f), faint: c(0x9c9d9f), divider: c(0xf1f1f1), raised: c(0xefeff0), hover: c(0xf0f0f1),
            button: c(0xf3f3f3), edge: c(0xd3d3d3), accent: c(0x6d78d5), waiting: c(0xf2994a), on_primary: c(0xffffff),
        }
    }
}

// desk.css's --state-* colours.
fn state_colour(state: &str, dark: bool) -> u32 {
    match (state, dark) {
        ("triage", _) => 0xfc7840,
        ("backlog" | "todo", true) => 0xbec2c8,
        ("backlog" | "todo", false) => 0xa2a6ac,
        ("running", _) => 0xf0bf00,
        ("review", true) => 0x4cb782,
        ("review", false) => 0x43bc58,
        ("done" | "landing", _) => 0x5e6ad2,
        ("waiting", _) => 0xf2994a,
        _ => 0x95a2b3,
    }
}

// What a layer of a status icon is filled with: the state's colour, the white of a mark on its disc, or the cross of
// Dropped, dark in dark.
#[derive(Clone, Copy)]
enum Ink {
    State,
    Mark,
    Cross,
}

// The layers of ui/icons.tsx's StateIcon, in its 14-unit box.
fn state_layers(state: &str) -> Vec<(String, Ink)> {
    let disc = r##"<circle cx="7" cy="7" r="6.25"/>"##.to_string();
    match state {
        "done" => vec![(disc, Ink::State), (r##"<path d="M4.4 7.1l1.8 1.8 3.4-3.6" fill="none" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>"##.into(), Ink::Mark)],
        "dropped" => vec![(disc, Ink::State), (r##"<path d="M5 5l4 4M9 5l-4 4" stroke="#000" stroke-width="1.5" stroke-linecap="round"/>"##.into(), Ink::Cross)],
        "triage" => vec![(disc, Ink::State), (r##"<path d="M4.25 5.6h5.5M8.1 3.95l1.65 1.65M9.75 8.4h-5.5M5.9 10.05L4.25 8.4" fill="none" stroke="#000" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>"##.into(), Ink::Mark)],
        "waiting" => vec![(r##"<circle cx="7" cy="7" r="6" fill="none" stroke="#000" stroke-width="1.5"/><path d="M5.6 4.9v4.2M8.4 4.9v4.2" stroke="#000" stroke-width="1.5" stroke-linecap="round"/>"##.into(), Ink::State)],
        _ => {
            let fill = match state { "running" => 0.5, "review" => 0.75, "landing" => 0.9, _ => 0.0 };
            let dash = if state == "backlog" { r##" stroke-dasharray="1.4 1.74" stroke-dashoffset="0.65""## } else { "" };
            let mut s = format!(r##"<circle cx="7" cy="7" r="6" fill="none" stroke="#000" stroke-width="1.5"{dash}/>"##);
            if fill > 0.0 {
                s += &format!(r##"<circle cx="7" cy="7" r="2" fill="none" stroke="#000" stroke-width="4" stroke-dasharray="{:.3} 12.566" transform="rotate(-90 7 7)"/>"##, 12.566 * fill);
            }
            vec![(s, Ink::State)]
        }
    }
}

// A mask of one colour, laid over the others of its icon.
fn layer(path: String, colour: Hsla, size: f32) -> Svg {
    svg().path(SharedString::from(path)).absolute().top_0().left_0().size(px(size)).text_color(colour)
}

pub fn state_icon(state: &str, cx: &App) -> Div {
    let dark = cx.theme().mode.is_dark();
    let own: Hsla = rgb(state_colour(state, dark)).into();
    let white: Hsla = rgb(0xffffff).into();
    let cross: Hsla = if dark { rgb(0x1a1a1a).into() } else { white };
    div().relative().flex_none().size(px(14.)).children(state_layers(state).into_iter().enumerate().map(|(n, (_, ink))| {
        let colour = match ink { Ink::State => own, Ink::Mark => white, Ink::Cross => cross };
        layer(format!("desk/state/{state}/{n}.svg"), colour, 14.)
    }))
}

// desk's glyphs (ui/icons.tsx, GLYPH), Linear's thin icons, in the grey of the text around them. Each is its path
// in a 16-unit box, stroked as GLYPH's `glyph` strokes it; the few filled ones say so, and the chat's own marks
// (Dock.tsx: the fold's caret, a chip's chevron, Send's arrow, Stop's square) are drawn here at 16 units too.
fn glyph_path(name: &str) -> &'static str {
    match name {
        "plus" => r##"<path d="M8 3.5v9M3.5 8h9"/>"##,
        "manual" => r##"<path d="M4 3.5v9l6-4.5z"/><path d="M12.5 3.5v9"/>"##,
        "auto" => r##"<path d="M2 3.5v9l6-4.5z"/><path d="M8 3.5v9l6-4.5z"/>"##,
        "file" => r##"<path d="M9 1.75H4.75a1.25 1.25 0 0 0-1.25 1.25v10c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V5.25z"/><path d="M9 1.75v3.5h3.5"/>"##,
        "close" => r##"<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>"##,
        "caret" => r##"<path d="M4.8 2.4l6.4 5.6-6.4 5.6z" fill="#000" stroke="none"/>"##,
        "caret-open" => r##"<path d="M2.4 4.8l5.6 6.4 5.6-6.4z" fill="#000" stroke="none"/>"##,
        "chevron" => r##"<path d="M4.5 6.5L8 10l3.5-3.5" stroke-width="1.5"/>"##,
        "send" => r##"<path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" stroke-width="1.6"/>"##,
        "stop" => r##"<rect x="2.4" y="2.4" width="11.2" height="11.2" rx="2.1" fill="#000" stroke="none"/>"##,
        "steps" => r##"<path d="M2.5 4.25l1.25 1.25 2-2.25M2.5 11.25l1.25 1.25 2-2.25"/><path d="M8 4.25h5.5M8 11.75h5.5"/>"##,
        "terminal" => r##"<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M4.5 6l2 2-2 2M8 10.5h3.5"/>"##,
        "triangle" => r##"<path d="M6.75194 10.6239C6.41861 10.8183 6 10.5779 6 10.192V5.80802C6 5.42212 6.41861 5.18169 6.75194 5.37613L10.5096 7.56811C10.8404 7.76105 10.8404 8.23895 10.5096 8.43189L6.75194 10.6239Z" fill="#000" stroke="none"/>"##,
        "triangle-open" => r##"<path d="M6.75194 10.6239C6.41861 10.8183 6 10.5779 6 10.192V5.80802C6 5.42212 6.41861 5.18169 6.75194 5.37613L10.5096 7.56811C10.8404 7.76105 10.8404 8.23895 10.5096 8.43189L6.75194 10.6239Z" fill="#000" stroke="none" transform="rotate(90 8 8)"/>"##,
        "open-down" => r##"<path d="M4 3h8M8 5.5v7M5.5 10 8 12.5 10.5 10"/>"##,
        "open-up" => r##"<path d="M4 13h8M8 10.5v-7M5.5 6 8 3.5 10.5 6"/>"##,
        "open-all" => r##"<path d="M4 8h8M8 5.5V1.75M6 3.75l2-2 2 2M8 10.5v3.75M6 12.25l2 2 2-2"/>"##,
        "whole-file" => r##"<path d="M9 1.75H4.75a1.25 1.25 0 0 0-1.25 1.25v10c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V5.25z"/><path d="M9 1.75v3.5h3.5M5.75 7.75h4.5M5.75 10h4.5M5.75 12.25h2.5"/>"##,
        "chat" => r##"<path fill-rule="evenodd" clip-rule="evenodd" fill="#000" stroke="none" d="M11.869 11.52c.946-.767 1.631-1.956 1.631-3.77s-.685-3.003-1.631-3.77C10.879 3.178 9.486 2.75 8 2.75c-1.694 0-3.065.44-3.985 1.213-.88.74-1.515 1.918-1.515 3.787 0 1.104.255 1.96.641 2.622.541.81.224 1.65.119 1.906-.073.177-.16.344-.219.455l-.03.057a7 7 0 0 0-.136.268c.242.18.563.217 1.1.078a7 7 0 0 0 .893-.32l.027-.01c.124-.052.29-.12.438-.17.08-.027.21-.067.36-.092.09-.014.365-.057.695.03A7.3 7.3 0 0 0 8 12.75c1.486 0 2.88-.428 3.869-1.23m-5.852 2.507A8.8 8.8 0 0 0 8 14.25c3.501 0 7-2.005 7-6.5s-3.499-6.5-7-6.5c-3.866 0-7 2.005-7 6.5 0 1.372.326 2.512.878 3.434.168.222.003.535-.19.901-.3.565-.665 1.257.02 1.942 1.215 1.215 2.864.534 3.739.173.289-.119.493-.203.57-.173"/>"##,
        "changes" => r##"<path d="M9 1.75H4.75a1.25 1.25 0 0 0-1.25 1.25v10c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V5.25zM9 1.75v3.5h3.5M8 5.25v3M6.5 6.75h3M6.5 10.75h3"/>"##,
        _ => "",
    }
}

// A glyph, 16px unless sized otherwise, drawn at whatever size it is given.
pub fn glyph(name: &str, colour: Hsla) -> Svg {
    svg().path(SharedString::from(format!("desk/glyph/{name}.svg"))).flex_none().size(px(16.)).text_color(colour)
}

// A number shown outright, as the web app's Gauge: a ring filled to its percent over a dim track, in black and white.
pub fn ring(percent: u32, colour: Hsla, track: Hsla) -> Div {
    let percent = percent.min(100);
    div()
        .relative()
        .flex_none()
        .size(px(14.))
        .child(layer("desk/ring/track.svg".into(), track, 14.))
        .when(percent > 0, |r| r.child(layer(format!("desk/ring/{percent}.svg"), colour, 14.)))
}

// The SVG of a shape under desk/: a status icon's layer, a glyph, or a ring's track or arc.
fn drawn(path: &str) -> Option<String> {
    let path = path.strip_suffix(".svg")?;
    let (kind, rest) = path.split_once('/')?;
    let (view, body) = match kind {
        "state" => {
            let (state, n) = rest.rsplit_once('/')?;
            (14, state_layers(state).into_iter().nth(n.parse().ok()?)?.0)
        }
        "glyph" => (16, format!(r##"<g fill="none" stroke="#000" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">{}</g>"##, glyph_path(rest))),
        "ring" if rest == "track" => (14, r##"<circle cx="7" cy="7" r="5.25" fill="none" stroke="#000" stroke-width="1.75"/>"##.into()),
        "ring" => {
            let percent: f32 = rest.parse().ok()?;
            let round = 2. * std::f32::consts::PI * 5.25;
            (14, format!(r##"<circle cx="7" cy="7" r="5.25" fill="none" stroke="#000" stroke-width="1.75" stroke-linecap="round" transform="rotate(-90 7 7)" stroke-dasharray="{:.3} {round:.3}"/>"##, round * percent / 100.))
        }
        _ => return None,
    };
    Some(format!(r##"<svg xmlns="http://www.w3.org/2000/svg" width="{view}" height="{view}" viewBox="0 0 {view} {view}">{body}</svg>"##))
}

// gpui-kit's icons, and desk's shapes under desk/.
pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        match path.strip_prefix("desk/") {
            Some(rest) => Ok(drawn(rest).map(|svg| Cow::Owned(svg.into_bytes()))),
            None => gpui_kit::assets::Assets.load(path),
        }
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        gpui_kit::assets::Assets.list(path)
    }
}
