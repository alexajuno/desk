// The right half's Steps: the issue's steps as desk keeps them (plan_steps), with the issues' status circles, each
// one's note under its title, and the open ones' pictures and decisions, as the page draws them (pages.ts). The step
// being worked on is open; a click opens or closes any other. desk sends the page again whenever it changes.
use std::collections::HashSet;
use std::sync::Arc;

use gpui_kit::base::StyledExt;
use gpui_kit::component::text::TextView;
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::Value;

struct Picture {
    caption: Option<String>,
    image: Arc<Image>,
    size: (f32, f32),
}

struct Step {
    path: String,
    title: String,
    state: String,
    note: String,
    said: String,
    dark: Vec<Picture>,
    light: Vec<Picture>,
    kids: Vec<Step>,
}

// The right half's width (main.rs).
pub const HALF: f32 = 420.;

pub struct Steps {
    steps: Vec<Step>,
    toggled: HashSet<String>,
    scroll: ScrollHandle,
}

// Each picture in a step's diagram_html in one theme ("for-dark" or "for-light"), with the caption over it (Today,
// After) if any, and the size d2 drew it at, from its outer viewBox. It is given that size, which GPUI renders at twice
// (SMOOTH_SVG_SCALE_FACTOR), sharp on a 2x screen; at four times, as before, shrinking it to the half left its lines
// and words jagged.
fn pictures(html: &str, version: &str) -> Vec<Picture> {
    let mut found = Vec::new();
    let mut rest = html;
    let marker = format!("class=\"{version}\">");
    while let Some(at) = rest.find(&marker) {
        let before = &rest[..at];
        let caption = before.rfind("<figcaption>").and_then(|c| {
            let text = &before[c + "<figcaption>".len()..];
            text.find("</figcaption>").map(|e| text[..e].to_string())
        });
        let body = &rest[at..];
        // The picture runs from its first <svg to the last </svg> before its version's </div>.
        let Some(start) = body.find("<svg") else { break };
        let Some(close) = body[start..].find("</div>").map(|c| start + c) else { break };
        let Some(end) = body[..close].rfind("</svg>") else { break };
        let svg = &body[start..end + "</svg>".len()];
        let size = svg
            .find("viewBox=\"")
            .map(|v| svg[v + 9..].split('"').next().unwrap_or("").split_whitespace().filter_map(|n| n.parse::<f32>().ok()).collect::<Vec<_>>())
            .filter(|n| n.len() == 4)
            .map(|n| (n[2], n[3]))
            .unwrap_or((400., 300.));
        let sharp = svg.replacen("<svg ", &format!("<svg width=\"{}\" height=\"{}\" ", size.0, size.1), 1);
        let sharp = with_our_fonts(&sharp);
        found.push(Picture { caption, image: Arc::new(Image::from_bytes(ImageFormat::Svg, sharp.into_bytes())), size });
        rest = &body[close..];
    }
    found
}

// d2 embeds its fonts in the SVG, which resvg does not read, so its labels fell back to a serif: they take the fonts
// the window has, JetBrains Mono for d2's mono and Inter for the rest.
fn with_our_fonts(svg: &str) -> String {
    use std::sync::LazyLock;
    static FONT: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r#""?d2-\d+-font-([a-z]+)"?"#).unwrap());
    FONT.replace_all(svg, |c: &regex::Captures| if &c[1] == "mono" { "\"JetBrains Mono\"" } else { "Inter" }).into_owned()
}

fn steps(list: &Value, prefix: &str) -> Vec<Step> {
    list.as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(i, s)| {
            let path = if prefix.is_empty() { format!("{}", i + 1) } else { format!("{prefix}.{}", i + 1) };
            let text = |k: &str| s[k].as_str().unwrap_or("").to_string();
            Step {
                title: text("title"),
                state: text("state"),
                note: text("note"),
                said: text("said_html"),
                dark: pictures(s["diagram_html"].as_str().unwrap_or(""), "for-dark"),
                light: pictures(s["diagram_html"].as_str().unwrap_or(""), "for-light"),
                kids: steps(&s["kids"], &path),
                path,
            }
        })
        .collect()
}

impl Steps {
    pub fn new() -> Self {
        Self { steps: Vec::new(), toggled: HashSet::new(), scroll: ScrollHandle::new() }
    }

    pub fn set(&mut self, page: &Value, cx: &mut Context<Self>) {
        self.steps = steps(&page["plan_steps"], "");
        cx.notify();
    }

    fn open(&self, step: &Step) -> bool {
        (step.state == "running") != self.toggled.contains(&step.path)
    }

    fn row(&self, step: &Step, depth: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let open = self.open(step);
        let path = step.path.clone();
        let pictures = if theme.mode.is_dark() { &step.dark } else { &step.light };
        let drawn = !pictures.is_empty() || !step.said.is_empty();
        let head = div()
            .id(SharedString::from(format!("step-{}", step.path)))
            .h_flex()
            .items_start()
            .gap_2()
            .pl(px(12. + 18. * depth as f32))
            .pr_3()
            .py_1()
            .rounded_md()
            .hover(|s| s.bg(theme.list_hover))
            .on_click(cx.listener(move |steps, _, _, cx| {
                if !steps.toggled.remove(&path) { steps.toggled.insert(path.clone()); }
                cx.notify();
            }))
            .child(div().pt(px(2.)).child(crate::theme::state_icon(&step.state, cx)))
            .child(
                div()
                    .v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(div().when(step.state != "done", |t| t.text_color(crate::theme::text(cx).strong)).child(step.title.clone()))
                    .when(!step.note.is_empty(), |c| c.child(div().text_xs().text_color(theme.muted_foreground).child(step.note.clone()))),
            );
        let mut column = div().v_flex().child(head);
        if open && drawn {
            let room = HALF - 32. - 18. * depth as f32 - 16.;
            let mut body = div().v_flex().gap_2().pl(px(32. + 18. * depth as f32)).pr_3().pb_3();
            for (n, picture) in pictures.iter().enumerate() {
                let scale = (room / picture.size.0).min(1.);
                body = body
                    .when_some(picture.caption.clone(), |b, caption| b.child(div().text_xs().font_semibold().text_color(theme.muted_foreground).child(caption)))
                    .child(
                        img(picture.image.clone())
                            .id(SharedString::from(format!("pic-{}-{n}", step.path)))
                            .w(px(picture.size.0 * scale))
                            .h(px(picture.size.1 * scale)),
                    );
            }
            if !step.said.is_empty() {
                body = body.child(div().text_sm().child(TextView::html(SharedString::from(format!("said-{}", step.path)), step.said.clone())));
            }
            column = column.child(body);
        }
        for kid in &step.kids {
            column = column.child(self.row(kid, depth + 1, cx));
        }
        column.into_any_element()
    }
}

impl Render for Steps {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let rows: Vec<AnyElement> = self.steps.iter().map(|s| self.row(s, 0, cx)).collect();
        let empty = rows.is_empty();
        div()
            .v_flex()
            .size_full()
            .child(
                div()
                    .id("steps")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .py_2()
                    .px_1()
                    .when(empty, |d| d.child(div().px_3().text_sm().text_color(muted).child("No steps yet")))
                    .children(rows),
            )
    }
}
