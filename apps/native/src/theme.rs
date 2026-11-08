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
        "tick-bold" => r##"<path d="M3.5 8.5l3 3 6-7" stroke-width="2"/>"##,
        "bubble" => r##"<path fill="#000" stroke="none" d="M8 2c3.6 0 6.5 2.4 6.5 5.4S11.6 12.8 8 12.8c-.6 0-1.2-.1-1.8-.2L3 14.1c-.4.2-.8-.2-.7-.6l.6-2.4C2 10.1 1.5 8.8 1.5 7.4 1.5 4.4 4.4 2 8 2z"/>"##,
        "calendar" => r##"<path fill="#000" stroke="none" d="M11 1a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4V5a4 4 0 0 1 4-4zm2.5 5h-11v5A2.5 2.5 0 0 0 5 13.5h6a2.5 2.5 0 0 0 2.5-2.5z"/>"##,
        "envelope" => r##"<g stroke-width="1.6"><rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5"/><path d="M2.25 4l5.75 4.5L13.75 4"/></g>"##,
        "key" => r##"<g stroke-width="1.8"><circle cx="5.5" cy="10.5" r="3"/><path d="M7.7 8.3 13.5 2.5M11 5l2 2"/></g>"##,
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
