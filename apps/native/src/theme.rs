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

// The system's light or dark, as the web app follows it, unless Settings keeps the window light or dark, or DESK_THEME
// says which for this run.
pub fn sync(window: &mut Window, cx: &mut App) {
    let pinned = std::env::var("DESK_THEME").ok().filter(|t| t == "light" || t == "dark");
    match pinned.as_deref().unwrap_or(chosen()) {
        "light" => Theme::change(gpui_kit::component::theme::ThemeMode::Light, Some(window), cx),
        "dark" => Theme::change(gpui_kit::component::theme::ThemeMode::Dark, Some(window), cx),
        _ => Theme::sync_system_appearance(Some(window), cx),
    }
}

// Settings' Interface theme, which the web keeps in each browser (localStorage.theme) and the window in
// ~/.local/state/desk/native-theme: "light", "dark", or "system" with no file.
fn theme_file() -> Option<std::path::PathBuf> {
    let state = std::env::var_os("XDG_STATE_HOME").map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".local/state")))?;
    Some(state.join("desk").join("native-theme"))
}

pub fn chosen() -> &'static str {
    match theme_file().and_then(|f| std::fs::read_to_string(f).ok()).as_deref().map(str::trim) {
        Some("light") => "light",
        Some("dark") => "dark",
        _ => "system",
    }
}

pub fn choose(choice: &str, window: &mut Window, cx: &mut App) {
    if let Some(file) = theme_file() {
        if choice == "light" || choice == "dark" {
            if let Some(dir) = file.parent() { let _ = std::fs::create_dir_all(dir); }
            let _ = std::fs::write(file, choice);
        } else {
            let _ = std::fs::remove_file(file);
        }
    }
    sync(window, cx);
    window.refresh();
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
        // a chat with no issue: a ring in the backlog's grey (the web's Ring)
        ("chat", true) => 0xbec2c8,
        ("chat", false) => 0xa2a6ac,
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
    state_icon_sized(state, 14., cx)
}

pub fn state_icon_sized(state: &str, size: f32, cx: &App) -> Div {
    let dark = cx.theme().mode.is_dark();
    let own: Hsla = rgb(state_colour(state, dark)).into();
    let white: Hsla = rgb(0xffffff).into();
    let cross: Hsla = if dark { rgb(0x1a1a1a).into() } else { white };
    div().relative().flex_none().size(px(size)).children(state_layers(state).into_iter().enumerate().map(|(n, (_, ink))| {
        let colour = match ink { Ink::State => own, Ink::Mark => white, Ink::Cross => cross };
        layer(format!("desk/state/{state}/{n}.svg"), colour, size)
    }))
}

// desk's glyphs (ui/icons.tsx, GLYPH), Linear's thin icons, in the grey of the text around them. Each is its path
// in a 16-unit box, stroked as GLYPH's `glyph` strokes it; the few filled ones say so, and the chat's own marks
// (Dock.tsx: the fold's caret, a chip's chevron, Send's arrow, Stop's square) are drawn here at 16 units too.
fn glyph_path(name: &str) -> &'static str {
    match name {
        "plus" => r##"<path d="M8 3.5v9M3.5 8h9"/>"##,
        "side" => r##"<rect x="2" y="2.75" width="12" height="10.5" rx="2.5"/><path d="M6.25 2.75v10.5"/>"##,
        "issues" => r##"<rect x="2.25" y="4.75" width="9" height="9" rx="2"/><path d="M4.75 2.25h7c1.1 0 2 .9 2 2v7"/>"##,
        "pin" => r##"<path d="M9.75 2.25l4 4-1.6.55-2.65 2.65.45 3.05-1.1 1.1L2.4 7.15l1.1-1.1 3.05.45L9.2 3.85zM5.35 10.65 2.25 13.75"/>"##,
        "pencil" => r##"<path d="M10.5 2.75l2.75 2.75L6 12.75H3.25V10zM9 4.25L11.75 7"/>"##,
        "trash" => r##"<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>"##,
        "search" => r##"<path fill="#000" stroke="none" fill-rule="evenodd" d="M7 2C9.76142 2 12 4.23858 12 7C12 8.11012 11.6375 9.13519 11.0254 9.96484L13.7803 12.7197L13.832 12.7764C14.0723 13.0709 14.0549 13.5057 13.7803 13.7803C13.5057 14.0549 13.0709 14.0723 12.7764 13.832L12.7197 13.7803L9.96484 11.0254C9.13519 11.6375 8.11012 12 7 12C4.23858 12 2 9.76142 2 7C2 4.23858 4.23858 2 7 2ZM7 3.5C5.067 3.5 3.5 5.067 3.5 7C3.5 8.933 5.067 10.5 7 10.5C8.933 10.5 10.5 8.933 10.5 7C10.5 5.067 8.933 3.5 7 3.5Z"/>"##,
        "new-issue" => r##"<g fill="#000" stroke="none" fill-rule="evenodd"><path d="M7.25 1C7.66414 1 7.99988 1.33589 8 1.75C8 2.16421 7.66421 2.5 7.25 2.5H4.75C3.50745 2.5 2.50012 3.50744 2.5 4.75V11.25C2.5 12.4926 3.50736 13.5 4.75 13.5H11.25C12.4926 13.5 13.5 12.4926 13.5 11.25V8.75C13.5001 8.33589 13.8359 8 14.25 8C14.6641 8 14.9999 8.33589 15 8.75V11.25C15 13.3211 13.3211 15 11.25 15H4.75C2.67893 15 1 13.3211 1 11.25V4.75C1.00012 2.67905 2.67899 1 4.75 1H7.25Z"/><path d="M13.4326 1.26953C13.7913 0.910937 14.3728 0.910883 14.7314 1.26953C15.0897 1.6282 15.0899 2.20981 14.7314 2.56836L9.2373 8.06152C8.68101 8.6177 7.94043 8.95161 7.15527 9C7.06754 9.0052 6.99468 8.93248 7 8.84473C7.04847 8.05961 7.38232 7.31897 7.93848 6.7627L13.4326 1.26953Z"/></g>"##,
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
        "unreads" => r##"<path fill-rule="evenodd" clip-rule="evenodd" fill="#000" stroke="none" d="M7.25 1C7.66421 1 8 1.33579 8 1.75C8 2.16421 7.66421 2.5 7.25 2.5H5.17969C4.79573 2.50003 4.45093 2.71902 4.28418 3.05469L4.22363 3.20605L2.74902 8H4.37305C5.32773 8 6.21946 8.47714 6.74902 9.27148L6.78809 9.32227C6.8848 9.43414 7.02582 9.49992 7.17578 9.5H8.82422C8.99571 9.49991 9.15584 9.41418 9.25098 9.27148L9.35449 9.12598C9.89229 8.41918 10.732 8 11.627 8H14.8115C14.8169 8.0002 14.8215 8.00369 14.8232 8.00879C14.9404 8.38972 15 8.78603 15 9.18457V11.5L14.9951 11.6797C14.9016 13.5292 13.3727 15 11.5 15H4.5C2.62727 15 1.09842 13.5292 1.00488 11.6797L1 11.5V9.18457C1.00002 8.88558 1.03338 8.5878 1.09961 8.29688L1.17676 8.00879L2.79004 2.76465C3.09264 1.78125 3.96362 1.09029 4.97559 1.00781L5.17969 1H7.25ZM2.5 11.5C2.5 12.6046 3.39543 13.5 4.5 13.5H11.5C12.6046 13.5 13.5 12.6046 13.5 11.5V9.5H11.627C11.2304 9.5 10.8572 9.6738 10.6016 9.96973L10.499 10.1035C10.1257 10.6635 9.49724 10.9999 8.82422 11H7.17578C6.54494 10.9999 5.95335 10.7043 5.57422 10.2061L5.50098 10.1035C5.24961 9.72647 4.8262 9.5 4.37305 9.5H2.5V11.5Z"/><path fill-rule="evenodd" clip-rule="evenodd" fill="#000" stroke="none" d="M12.5 1C13.8807 1 15 2.11929 15 3.5C15 4.88071 13.8807 6 12.5 6C11.1193 6 10 4.88071 10 3.5C10 2.11929 11.1193 1 12.5 1Z"/>"##,
        "read-all" => r##"<path fill-rule="evenodd" clip-rule="evenodd" fill="#000" stroke="none" d="M6.25 1C6.66421 1 7 1.33579 7 1.75C7 2.16421 6.66421 2.5 6.25 2.5H5.17969C4.79573 2.50003 4.45093 2.71902 4.28418 3.05469L4.22363 3.20605L2.74902 8H4.37305C5.32773 8 6.21946 8.47714 6.74902 9.27148L6.78809 9.32227C6.8848 9.43414 7.02582 9.49992 7.17578 9.5H8.82422C8.99571 9.49991 9.15584 9.41418 9.25098 9.27148L9.35449 9.12598C9.89229 8.41918 10.732 8 11.627 8H13.251C13.2527 8.0051 13.2574 8.00859 13.2627 8.00879H14.085C14.5238 8.00895 14.9247 8.29453 14.9746 8.73047C14.9918 8.88092 15 9.03274 15 9.18457V11.5L14.9951 11.6797C14.9016 13.5292 13.3727 15 11.5 15H4.5C2.62727 15 1.09842 13.5292 1.00488 11.6797L1 11.5V9.18457C1.00002 8.88558 1.03338 8.5878 1.09961 8.29688L1.17676 8.00879L2.79004 2.76465C3.09264 1.78125 3.96362 1.09029 4.97559 1.00781L5.17969 1H6.25ZM2.5 11.5C2.5 12.6046 3.39543 13.5 4.5 13.5H11.5C12.6046 13.5 13.5 12.6046 13.5 11.5V9.5H11.627C11.2304 9.5 10.8572 9.6738 10.6016 9.96973L10.499 10.1035C10.1257 10.6635 9.49724 10.9999 8.82422 11H7.17578C6.54494 10.9999 5.95335 10.7043 5.57422 10.2061L5.50098 10.1035C5.24961 9.72647 4.8262 9.5 4.37305 9.5H2.5V11.5Z"/><path fill-rule="evenodd" clip-rule="evenodd" fill="#000" stroke="none" d="M13.5088 1.43262C13.822 1.16157 14.2963 1.19568 14.5674 1.50879C14.8384 1.82196 14.8043 2.2963 14.4912 2.56738L10.7354 5.81738C10.4376 6.0747 9.99171 6.05807 9.71387 5.7793L8.21875 4.2793L8.16699 4.22266C7.92727 3.92768 7.94568 3.49286 8.2207 3.21875C8.4958 2.94467 8.93046 2.9281 9.22461 3.16895L9.28125 3.2207L10.2822 4.22461L13.5088 1.43262Z"/>"##,
        "delete" => r##"<path fill-rule="evenodd" clip-rule="evenodd" fill="#000" stroke="none" d="M7.25 1.00006C7.66421 1.00006 8 1.33585 8 1.75006C7.99997 2.16425 7.66419 2.50006 7.25 2.50006H5.17969C4.79573 2.50009 4.45093 2.71908 4.28418 3.05475L4.22363 3.20612L2.74902 8.00006H4.37305C5.32773 8.00006 6.21946 8.4772 6.74902 9.27155L6.78809 9.32233C6.8848 9.43418 7.02584 9.49999 7.17578 9.50006H8.82422C8.99569 9.49997 9.15584 9.41422 9.25098 9.27155L9.35449 9.12604C9.89229 8.41924 10.732 8.00006 11.627 8.00006H14.5L14.8232 8.00885C14.9404 8.38976 15 8.78611 15 9.18463V11.5001L14.9951 11.6797C14.9015 13.5292 13.3727 15.0001 11.5 15.0001H4.5C2.62729 15.0001 1.09845 13.5292 1.00488 11.6797L1 11.5001V9.18463C1.00002 8.88566 1.03339 8.58784 1.09961 8.29694L1.17676 8.00885L2.79004 2.76471C3.09264 1.78131 3.96362 1.09035 4.97559 1.00787L5.17969 1.00006H7.25ZM2.5 11.5001C2.50003 12.6046 3.39545 13.5001 4.5 13.5001H11.5C12.6045 13.5001 13.5 12.6046 13.5 11.5001V9.50006H11.627C11.2304 9.50006 10.8572 9.67386 10.6016 9.96979L10.499 10.1036C10.1257 10.6635 9.49722 11 8.82422 11.0001H7.17578C6.54495 11 5.95335 10.7043 5.57422 10.2061L5.50098 10.1036C5.24961 9.72653 4.8262 9.50006 4.37305 9.50006H2.5V11.5001Z"/><path fill-rule="evenodd" clip-rule="evenodd" fill="#000" stroke="none" d="M13.7197 1.21979C14.0126 0.926894 14.4874 0.926894 14.7803 1.21979C15.0731 1.51269 15.0731 1.98746 14.7803 2.28033L13.5605 3.50006L14.7803 4.71979C15.0732 5.01268 15.0732 5.48744 14.7803 5.78033C14.4874 6.07317 14.0126 6.07321 13.7197 5.78033L12.5 4.56061L11.2803 5.78033C10.9874 6.07321 10.5126 6.07317 10.2197 5.78033C9.92683 5.48744 9.92683 5.01268 10.2197 4.71979L11.4395 3.50006L10.2197 2.28033C9.92685 1.98746 9.92689 1.51269 10.2197 1.21979C10.5126 0.926894 10.9874 0.926894 11.2803 1.21979L12.5 2.43951L13.7197 1.21979Z"/>"##,
        "more" => r##"<path fill-rule="evenodd" clip-rule="evenodd" fill="#000" stroke="none" d="M3 6.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z"/>"##,
        "inbox" => r##"<path d="M2 9h3l1 2h4l1-2h3M3 3h10l1 6v4H2V9z" stroke-linecap="butt"/>"##,
        "archive" => r##"<rect x="2" y="3" width="12" height="3" rx="1"/><path d="M3 6v6.5c0 .28.22.5.5.5h9c.28 0 .5-.22.5-.5V6M6.5 8.75h3"/>"##,
        "triage" => r##"<path d="M2 9.5h3.25l1 1.75h3.5l1-1.75H14"/><path d="M2 9.5l1.6-5.1c.13-.42.52-.65.95-.65h6.9c.43 0 .82.23.95.65L14 9.5v2.75c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1z"/><path d="M8 4.5v3.25M6.6 6.4 8 7.75 9.4 6.4"/>"##,
        "tick-bold" => r##"<path d="M3.5 8.5l3 3 6-7" stroke-width="2"/>"##,
        "bubble" => r##"<path fill="#000" stroke="none" d="M8 2c3.6 0 6.5 2.4 6.5 5.4S11.6 12.8 8 12.8c-.6 0-1.2-.1-1.8-.2L3 14.1c-.4.2-.8-.2-.7-.6l.6-2.4C2 10.1 1.5 8.8 1.5 7.4 1.5 4.4 4.4 2 8 2z"/>"##,
        "calendar" => r##"<path fill="#000" stroke="none" d="M11 1a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4V5a4 4 0 0 1 4-4zm2.5 5h-11v5A2.5 2.5 0 0 0 5 13.5h6a2.5 2.5 0 0 0 2.5-2.5z"/>"##,
        "envelope" => r##"<g stroke-width="1.6"><rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5"/><path d="M2.25 4l5.75 4.5L13.75 4"/></g>"##,
        "key" => r##"<g stroke-width="1.8"><circle cx="5.5" cy="10.5" r="3"/><path d="M7.7 8.3 13.5 2.5M11 5l2 2"/></g>"##,
        "link" => r##"<path fill="#000" stroke="none" d="M9.30558 10.206C9.57224 10.4726 9.59447 10.8912 9.37225 11.1831L9.30558 11.2594L6.84751 13.7175C5.58692 14.9781 3.54311 14.9781 2.28252 13.7175C1.0654 12.5004 1.02344 10.5531 2.15661 9.28564L2.28252 9.15251L4.74059 6.69443C5.0315 6.40353 5.50315 6.40353 5.79405 6.69443C6.06071 6.9611 6.08294 7.37963 5.86072 7.67161L5.79405 7.74789L3.33598 10.206C2.6572 10.8847 2.6572 11.9853 3.33598 12.664C3.98082 13.3089 5.00628 13.3411 5.68918 12.7608L5.79405 12.664L8.25212 10.206C8.54303 9.91506 9.01468 9.91506 9.30558 10.206ZM9.82982 6.17019C10.1207 6.46109 10.1207 6.93274 9.82982 7.22365L7.34921 9.70427C7.0583 9.99518 6.58665 9.99518 6.29575 9.70427C6.00484 9.41337 6.00484 8.94172 6.29575 8.65081L8.77637 6.17019C9.06727 5.87928 9.53892 5.87928 9.82982 6.17019ZM13.7175 2.2825C14.9346 3.49962 14.9766 5.44688 13.8434 6.71436L13.7175 6.84749L11.2594 9.30557C10.9685 9.59647 10.4969 9.59647 10.206 9.30557C9.93931 9.03891 9.91709 8.62037 10.1393 8.32839L10.206 8.25211L12.664 5.79403C13.3428 5.11525 13.3428 4.01474 12.664 3.33596C12.0192 2.69112 10.9938 2.65888 10.3109 3.23923L10.206 3.33596L7.74791 5.79403C7.457 6.08494 6.98535 6.08494 6.69445 5.79403C6.42779 5.52737 6.40556 5.10883 6.62778 4.81686L6.69445 4.74057L9.15252 2.2825C10.4131 1.02191 12.4569 1.02191 13.7175 2.2825Z"/>"##,
        "project" => r##"<path fill="#000" stroke="none" fill-rule="evenodd" clip-rule="evenodd" d="M7.331 1.07a3.2 3.2 0 0 1 1.338 0c.498.106.967.377 1.904.917l1.354.78c.937.541 1.406.812 1.747 1.19.301.334.53.728.669 1.156.157.484.157 1.025.157 2.107v1.56l-.003.718c-.007.63-.036 1.026-.154 1.389l-.057.158a3.2 3.2 0 0 1-.612.998l-.135.138c-.33.312-.792.578-1.612 1.051l-1.354.78-.623.357c-.55.309-.907.481-1.281.56l-.166.032a3.2 3.2 0 0 1-1.006 0l-.166-.031c-.374-.08-.73-.252-1.281-.561l-.623-.356-1.354-.78c-.82-.474-1.281-.74-1.612-1.052l-.135-.138a3.2 3.2 0 0 1-.612-.998l-.057-.158c-.118-.363-.147-.758-.154-1.39L1.5 8.78V7.22c0-.946 0-1.479.105-1.921l.052-.186c.122-.374.312-.723.56-1.028l.11-.128c.255-.284.583-.507 1.126-.83l.62-.36 1.354-.78c.82-.473 1.281-.739 1.718-.869zM3 7.22v1.56c0 1.183.018 1.439.084 1.643l.064.167q.11.246.292.449l.059.06c.151.143.427.318 1.323.835l1.354.78.632.36c.188.104.33.178.442.233V8.482l-4.247-1.93zm5.75 1.262v4.826c.212-.106.533-.282 1.074-.594l1.354-.78.628-.368c.499-.297.646-.407.754-.527l.113-.14q.158-.218.243-.476l.022-.081c.035-.144.051-.351.058-.835L13 8.78V7.22l-.004-.668zM7.82 2.51l-.177.027c-.159.034-.328.106-.835.39l-.632.359-1.354.78c-.896.517-1.172.692-1.323.834l-.059.06q-.046.051-.086.104l4.645 2.112 4.645-2.112-.084-.103c-.109-.12-.255-.23-.754-.528l-.628-.367-1.354-.78c-.897-.517-1.186-.668-1.386-.728l-.08-.021a1.7 1.7 0 0 0-.538-.027"/>"##,
        "team" => r##"<path fill="#000" stroke="none" d="M12.5 13.5V15h-9v-1.5zm1-1v-9a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1V15l-.256-.013a2.5 2.5 0 0 1-2.231-2.231L1 12.5v-9a2.5 2.5 0 0 1 2.244-2.487L3.5 1h9l.256.013A2.5 2.5 0 0 1 15 3.5v9l-.013.256a2.5 2.5 0 0 1-2.231 2.231L12.5 15v-1.5a1 1 0 0 0 1-1"/><path fill="#000" stroke="none" d="M10 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0m1.405 6h-6.81c-.407 0-.714-.336-.55-.693.362-.79 1.344-1.974 3.98-1.974 2.648 0 3.597 1.196 3.935 1.986.152.355-.153.681-.555.681"/>"##,
        "milestone" => r##"<path fill="#000" stroke="none" d="m9.692 12.41 1.164.945-1.033 1.271a2.34 2.34 0 0 1-3.646 0l-1.034-1.27 1.164-.947 1.034 1.27a.84.84 0 0 0 1.318 0zM3.66 5.657l.582.474-1.032 1.27a.96.96 0 0 0 0 1.196l1.032 1.27-.582.474-.001-.001-.581.474-1.032-1.271a2.46 2.46 0 0 1 0-3.088l1.032-1.27zm10.295.798a2.46 2.46 0 0 1 0 3.088l-1.032 1.27-.582-.473-.582-.473h-.001l1.033-1.27a.96.96 0 0 0 .092-1.06l-.092-.136-1.033-1.27 1.165-.946zM6.267 1.268a2.34 2.34 0 0 1 3.556.106l1.033 1.27-1.165.947L8.66 2.32a.84.84 0 0 0-1.318 0L6.307 3.59l-1.164-.946 1.034-1.27z"/>"##,
        "folder" => r##"<path d="M2 4.5c0-.83.67-1.5 1.5-1.5h3l1.5 1.5h4.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9C2.67 13 2 12.33 2 11.5v-7z" stroke-width="1.2"/>"##,
        "clock" => r##"<circle cx="8" cy="8" r="5.75"/><path d="M8 5v3l2 1.25"/>"##,
        "prio-urgent" => r##"<path fill="#000" stroke="none" d="M3 1C1.91 1 1 1.91 1 3v10c0 1.09.91 2 2 2h10c1.09 0 2-.91 2-2V3c0-1.09-.91-2-2-2H3zm4 3h2l-.25 5H7.25L7 4zm2 7a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>"##,
        "prio-none" => r##"<g fill="#000" stroke="none"><rect x="1.5" y="7.25" width="3" height="1.5" rx=".5"/><rect x="6.5" y="7.25" width="3" height="1.5" rx=".5"/><rect x="11.5" y="7.25" width="3" height="1.5" rx=".5"/></g>"##,
        "prio-high" => r##"<g fill="#000" stroke="none"><rect x="1.5" y="8" width="3" height="6" rx="1"/><rect x="6.5" y="5" width="3" height="9" rx="1"/><rect x="11.5" y="2" width="3" height="12" rx="1"/></g>"##,
        "prio-medium" => r##"<g fill="#000" stroke="none"><rect x="1.5" y="8" width="3" height="6" rx="1"/><rect x="6.5" y="5" width="3" height="9" rx="1"/><rect x="11.5" y="2" width="3" height="12" rx="1" fill-opacity=".4"/></g>"##,
        "prio-low" => r##"<g fill="#000" stroke="none"><rect x="1.5" y="8" width="3" height="6" rx="1"/><rect x="6.5" y="5" width="3" height="9" rx="1" fill-opacity=".4"/><rect x="11.5" y="2" width="3" height="12" rx="1" fill-opacity=".4"/></g>"##,
        "out" => r##"<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>"##,
        "smile" => r##"<circle cx="8" cy="8" r="5.75"/><path d="M5.75 9.5c.5.8 1.3 1.25 2.25 1.25s1.75-.45 2.25-1.25"/><path d="M6 6.5h.01M10 6.5h.01" stroke-width="1.8"/>"##,
        "smile-plus" => r##"<path d="M13.6 7.2A5.75 5.75 0 1 1 8.8 2.3"/><path d="M5.75 9.5c.5.8 1.3 1.25 2.25 1.25s1.75-.45 2.25-1.25"/><path d="M6 6.5h.01M10 6.5h.01" stroke-width="1.8"/><path d="M12.5 1.5v4M10.5 3.5h4"/>"##,
        "filter" => r##"<path fill="#000" stroke="none" fill-rule="evenodd" d="M14.25 3a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1 0-1.5h12.5ZM4 8a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5h-6.5A.75.75 0 0 1 4 8Zm2.75 3.5a.75.75 0 0 0 0 1.5h2.5a.75.75 0 0 0 0-1.5h-2.5Z"/>"##,
        "display" => r##"<g fill="#000" stroke="none" fill-rule="evenodd"><path d="M7 2.5C8.11933 2.5 9.06613 3.23584 9.38477 4.25H14.75C15.1642 4.25 15.5 4.58579 15.5 5C15.5 5.41421 15.1642 5.75 14.75 5.75H9.38477C9.06613 6.76416 8.11933 7.5 7 7.5C5.88067 7.5 4.93387 6.76416 4.61523 5.75H2.25C1.83579 5.75 1.5 5.41421 1.5 5C1.5 4.58579 1.83579 4.25 2.25 4.25H4.61523C4.93387 3.23584 5.88067 2.5 7 2.5ZM7 4C6.44772 4 6 4.44772 6 5C6 5.55228 6.44772 6 7 6C7.55228 6 8 5.55228 8 5C8 4.44772 7.55228 4 7 4Z"/><path d="M10 13.5C8.88067 13.5 7.93387 12.7642 7.61523 11.75H2.25C1.83579 11.75 1.5 11.4142 1.5 11C1.5 10.5858 1.83579 10.25 2.25 10.25H7.61523C7.93387 9.23584 8.88067 8.5 10 8.5C11.1193 8.5 12.0661 9.23584 12.3848 10.25H14.75C15.1642 10.25 15.5 10.5858 15.5 11C15.5 11.4142 15.1642 11.75 14.75 11.75H12.3848C12.0661 12.7642 11.1193 13.5 10 13.5ZM10 12C10.5523 12 11 11.5523 11 11C11 10.4477 10.5523 10 10 10C9.44772 10 9 10.4477 9 11C9 11.5523 9.44772 12 10 12Z"/></g>"##,
        "none" => r##"<circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8l7.6-7.6"/>"##,
        "tick" => r##"<path transform="scale(1.142857)" stroke-width="1.3125" d="M3 7.5l2.5 2.5L11 4.5"/>"##,
        "chevron-right" => r##"<path d="M6 4l4 4-4 4" stroke-width="1.4"/>"##,
        "chevron-left" => r##"<path d="M10 4L6 8l4 4" stroke-width="1.4"/>"##,
        "select-chevron" => r##"<path fill="#000" stroke="none" transform="translate(0 3.556) scale(1.777778)" d="M1.915.557a.667.667 0 0 0-.943.943l2.862 2.862a.942.942 0 0 0 1.333 0L8.028 1.5a.667.667 0 0 0-.943-.943L4.5 3.14 1.915.557Z"/>"##,
        "sliders" => r##"<path d="M2.5 4.5h3M9.5 4.5h4M2.5 11.5h6M12.5 11.5h1M7.5 3v3M10.5 10v3"/>"##,
        "keys" => r##"<rect x="1.75" y="3.75" width="12.5" height="8.5" rx="1.5"/><path d="M4.5 6.5h.01M7 6.5h.01M9.5 6.5h.01M12 6.5h.01M5 9.5h6"/>"##,
        // the status bar's Help (frame/help.tsx) and the profile's chevron (frame/StatusBar.tsx)
        "help" => r##"<path fill="#000" stroke="none" d="M7.569 9.75c-.332 0-.614-.27-.578-.6.021-.188.061-.372.136-.62q.158-.51.447-.82a3.4 3.4 0 0 1 .703-.577q.284-.182.507-.396.229-.219.358-.486a1.4 1.4 0 0 0 .13-.606 1.2 1.2 0 0 0-.171-.653 1.2 1.2 0 0 0-.466-.429 1.360 1.360 0 0 0-.647-.152q-.33 0-.628.148a1.23 1.23 0 0 0-.587.622c-.123.295-.367.555-.686.555h-.472c-.337 0-.616-.28-.55-.611q.103-.513.363-.905a2.55 2.55 0 0 1 1.080-.915A3.6 3.6 0 0 1 7.998 3q.888 0 1.563.32.680.319 1.057.91.382.586.382 1.392 0 .543-.172.972a2.4 2.4 0 0 1-.48.763 3.5 3.5 0 0 1-.74.595 3.2 3.2 0 0 0-.62.496 1.7 1.7 0 0 0-.353.605l-.034.106c-.1.316-.35.591-.682.591zM8.75 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0"/>"##,
        "chevron-down" => r##"<path d="M4.5 6.5L8 10l3.5-3.5" stroke-width="1.5"/>"##,
        "parent" => r##"<path d="M4.5 2.5v6a2 2 0 0 0 2 2h6M10 8l2.5 2.5L10 13"/>"##,
        "system" => r##"<rect x="2" y="3" width="12" height="8.5" rx="1.5"/><path d="M6 14h4M8 11.5V14"/>"##,
        "light" => r##"<circle cx="8" cy="8" r="2.75"/><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05"/>"##,
        "dark" => r##"<path d="M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6z"/>"##,
        "globe" => r##"<circle cx="8" cy="8" r="5.75"/><path d="M2.25 8h11.5M8 2.25C9.6 3.85 10.4 5.75 10.4 8S9.6 12.15 8 13.75M8 2.25C6.4 3.85 5.6 5.75 5.6 8s.8 4.15 2.4 5.75"/>"##,
        "back" => r##"<path d="M9.5 3.5L5 8l4.5 4.5"/>"##,
        "forward" => r##"<path d="M6.5 3.5L11 8l-4.5 4.5"/>"##,
        "reload" => r##"<path d="M12.75 8a4.75 4.75 0 1 1-1.4-3.36"/><path d="M12 2.5v2.75H9.25"/>"##,
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

// Linear's project status icon (ui/icons.tsx, ProjectStatusIcon): a hexagon, dashed for Backlog, with a pie of how far
// along it is inside, which Completed fills with a tick and Canceled with a cross; In Progress shows the project's
// progress. Coloured by its status (desk.css's --project-*).
const HEX: &str = "M2.95778 3.02069L5.70777 1.36023C6.50244 0.88041 7.49756 0.88041 8.29223 1.36024L11.0422 3.02074C11.7918 3.47336 12.25 4.2852 12.25 5.16086V8.84803C12.25 9.7251 11.7904 10.5381 11.0388 10.9902L8.29114 12.6433C7.49693 13.1211 6.50355 13.1203 5.71011 12.6412L2.95775 10.9792C2.20815 10.5266 1.75 9.7148 1.75 8.83911V5.16082C1.75 4.28516 2.20816 3.47332 2.95778 3.02069Z";
const HEX_INNER: &str = "M8.3779 4.74233C8.14438 4.60607 7.85562 4.60607 7.6221 4.74233L5.37209 6.05513C5.14168 6.18957 5 6.4363 5 6.70311V9.34216C5 9.60897 5.14168 9.85573 5.37209 9.99016L7.6221 11.303C7.85562 11.4392 8.14438 11.4392 8.3779 11.303L10.6279 9.99016C10.8583 9.85573 11 9.60897 11 9.34216V6.70311C11 6.4363 10.8583 6.18957 10.6279 6.05513L8.3779 4.74233Z";
const HEX_MARK_DONE: &str = "M10.7803 5.28033C11.0732 4.98744 11.0732 4.51256 10.7803 4.21967C10.4874 3.92678 10.0126 3.92678 9.7197 4.21967L5.75 8.18934L4.28033 6.71967C3.98744 6.42678 3.51256 6.42678 3.21967 6.71967C2.92678 7.01256 2.92678 7.48744 3.21967 7.78033L5.21967 9.7803C5.51256 10.0732 5.98744 10.0732 6.28033 9.7803L10.7803 5.28033Z";
const HEX_MARK_CANCELED: &str = "M3.73657 3.73657C4.05199 3.42114 4.56339 3.42114 4.87881 3.73657L5.93941 4.79716L7 5.85775L9.12117 3.73657C9.4366 3.42114 9.94801 3.42114 10.2634 3.73657C10.5789 4.05199 10.5789 4.56339 10.2634 4.87881L8.14225 7L10.2634 9.12118C10.5789 9.4366 10.5789 9.94801 10.2634 10.2634C9.94801 10.5789 9.4366 10.5789 9.12117 10.2634L7 8.14225L4.87881 10.2634C4.56339 10.5789 4.05199 10.5789 3.73657 10.2634C3.42114 9.94801 3.42114 9.4366 3.73657 9.12118L4.79716 8.06059L5.85775 7L3.73657 4.87881C3.42114 4.56339 3.42114 4.05199 3.73657 3.73657Z";

fn project_svg(status: &str, percent: u32) -> String {
    let full = status == "completed" || status == "canceled";
    let f = if full { 1. } else if status == "started" { percent.min(100) as f32 / 100. } else { 0. };
    let dash = if status == "backlog" { r#"stroke-dasharray="1.65 1.35" stroke-dashoffset="2.3""# } else { r#"stroke-dasharray="3.14 0" stroke-dashoffset="1""# };
    let inner = if full { "translate(-7.5, -7.5) scale(1.8)" } else { "translate(-1, -1)" };
    let mark = match status { "completed" => format!(r##"<path d="{HEX_MARK_DONE}" fill="black"/>"##), "canceled" => format!(r##"<path d="{HEX_MARK_CANCELED}" fill="black"/>"##), _ => String::new() };
    format!(r##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="-1 -1 16 16" fill="none"><path d="{HEX}" stroke="#000" stroke-width="1.5" stroke-linejoin="bevel" fill="none" {dash}/><mask id="m" maskUnits="userSpaceOnUse"><path transform="{inner}" d="{HEX_INNER}" fill="white"/>{mark}</mask><g mask="url(#m)"><circle r="4" cx="7" cy="7" stroke="#000" fill="none" stroke-width="8" stroke-dasharray="{:.2} 25.12" transform="rotate(-90) translate(-14, 0)"/></g></svg>"##, 25.12 * f)
}

pub fn project_icon(status: &str, progress: u32, cx: &App) -> Svg {
    let dark = cx.theme().mode.is_dark();
    let colour = match status { "backlog" => 0xf2994a, "planned" if dark => 0xd7d8db, "planned" => 0xa2a6ac, "started" => 0xf0bf00, "completed" => 0x5e6ad2, _ => 0x8a8f98 };
    let status = if ["backlog", "planned", "started", "completed", "canceled"].contains(&status) { status } else { "planned" };
    svg().path(SharedString::from(format!("desk/project/{status}/{}.svg", progress.min(100)))).flex_none().size(px(16.)).text_color(rgb(colour))
}

// Linear's milestone icon (ui/icons.tsx, MilestoneIcon): a diamond, filled once done, a piece of it filled while under
// way; in the done blue, the started yellow for the project's current one, or the third grey.
const MILESTONE_FULL: &str = "M6.679 1.122a1.715 1.715 0 0 1 2.642 0L14.104 6.9a1.726 1.726 0 0 1 0 2.2l-4.783 5.778a1.715 1.715 0 0 1-2.642 0L1.896 9.1a1.726 1.726 0 0 1 0-2.2z";
const MILESTONE_OUTLINE: &str = "M6.679 1.122a1.715 1.715 0 0 1 2.642 0L14.104 6.9a1.726 1.726 0 0 1 0 2.2l-4.783 5.778a1.715 1.715 0 0 1-2.642 0L1.896 9.1a1.726 1.726 0 0 1 0-2.2zm1.706 2.006a.5.5 0 0 0-.77 0L3.845 7.68a.5.5 0 0 0 0 .638l3.77 4.553a.5.5 0 0 0 .77 0l3.77-4.553a.5.5 0 0 0 0-.638z";

fn milestone_svg(kind: &str) -> String {
    let body = match kind {
        "full" => format!(r##"<path fill-rule="evenodd" clip-rule="evenodd" d="{MILESTONE_FULL}"/>"##),
        "part" => format!(r##"<path fill-rule="evenodd" clip-rule="evenodd" d="{MILESTONE_OUTLINE}" opacity=".3"/><path d="M8 .5c.512 0 .996.23 1.321.622l2.516 3.04-1.42 1.42-2.032-2.454A.5.5 0 0 0 8 2.946z"/>"##),
        _ => format!(r##"<path fill-rule="evenodd" clip-rule="evenodd" d="{MILESTONE_OUTLINE}"/>"##),
    };
    format!(r##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="#000">{body}</svg>"##)
}

pub fn milestone_icon(progress: u32, current: bool, cx: &App) -> Svg {
    let dark = cx.theme().mode.is_dark();
    let colour = if progress >= 100 { 0x5e6ad2 } else if current { 0xf0bf00 } else if dark { 0x959597 } else { 0x5c5c5e };
    let kind = if progress >= 100 { "full" } else if progress > 0 { "part" } else { "none" };
    svg().path(SharedString::from(format!("desk/milestone/{kind}.svg"))).flex_none().size(px(16.)).text_color(rgb(colour))
}

// Slack's mark, in its four colours: a layer each.
const SLACK: [(&str, u32); 4] = [
    ("M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z", 0xe01e5a),
    ("M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z", 0x36c5f0),
    ("M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z", 0x2eb67d),
    ("M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z", 0xecb22e),
];

pub fn slack_mark(size: f32) -> Div {
    div().relative().flex_none().size(px(size)).children((0..SLACK.len()).map(|n| layer(format!("desk/slack/{n}.svg"), rgb(SLACK[n].1).into(), size)))
}

// Linear's empty Inbox: a tray in two greys, 78 by 80 units.
const EMPTY: [&str; 3] = [
    "M10.4 9.11A10 10 0 0 1 20.22 1h37.56a10 10 0 0 1 9.82 8.11l8.11 42.2a10 10 0 0 1-9.82 11.9H54.7a6.36 6.36 0 0 0-5.65 3.45 6.36 6.36 0 0 1-5.66 3.45H34.6a6.36 6.36 0 0 1-5.66-3.45 6.36 6.36 0 0 0-5.65-3.46H12.1a10 10 0 0 1-9.8-11.89l8.11-42.2Z",
    "M14.3 9.03a5 5 0 0 1 4.91-4.08H58.8a5 5 0 0 1 4.91 4.08l8.07 43.22a6 6 0 0 1-5.9 7.1H52.76a5.72 5.72 0 0 0-5.24 3.41 5.72 5.72 0 0 1-5.23 3.42h-6.58a5.72 5.72 0 0 1-5.23-3.42 5.72 5.72 0 0 0-5.24-3.4h-13.1a6 6 0 0 1-5.9-7.1L14.3 9.02Z",
    "m2.36 55.6 3.2 14.06A12 12 0 0 0 17.26 79h43.48a12 12 0 0 0 11.7-9.34l3.2-14.06",
];

pub fn empty_inbox(outer: Hsla, inner: Hsla) -> Div {
    let at = |n: usize, colour: Hsla| svg().path(SharedString::from(format!("desk/empty/{n}.svg"))).absolute().top_0().left_0().w(px(98.)).h(px(100.)).text_color(colour);
    div().relative().flex_none().w(px(98.)).h(px(100.)).child(at(0, outer)).child(at(1, inner)).child(at(2, outer))
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
        "slack" => (24, format!(r##"<path fill="#000" d="{}"/>"##, SLACK.get(rest.parse::<usize>().ok()?)?.0)),
        "project" => {
            let (status, percent) = rest.split_once('/')?;
            return Some(project_svg(status, percent.parse().ok()?));
        }
        "milestone" => return Some(milestone_svg(rest)),
        "empty" => {
            let d = EMPTY.get(rest.parse::<usize>().ok()?)?;
            return Some(format!(r##"<svg xmlns="http://www.w3.org/2000/svg" width="78" height="80" viewBox="0 0 78 80"><path d="{d}" fill="none" stroke="#000" stroke-width="1.5"/></svg>"##));
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
