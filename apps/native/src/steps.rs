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
    pictures: Vec<Picture>,
    kids: Vec<Step>,
}

pub struct Steps {
    steps: Vec<Step>,
    toggled: HashSet<String>,
    scroll: ScrollHandle,
}

// The light version of each picture in a step's diagram_html, with the caption over it (Today, After) if any, and the
// size d2 drew it at, from its outer viewBox.
fn pictures(html: &str) -> Vec<Picture> {
    let mut found = Vec::new();
    let mut rest = html;
    while let Some(at) = rest.find("class=\"for-light\">") {
        let before = &rest[..at];
        let caption = before.rfind("<figcaption>").and_then(|c| {
            let text = &before[c + "<figcaption>".len()..];
            text.find("</figcaption>").map(|e| text[..e].to_string())
        });
        let body = &rest[at..];
        let (Some(start), Some(end)) = (body.find("<svg"), body.find("</svg></div>")) else { break };
        let svg = &body[start..end + "</svg>".len()];
        let size = svg
            .find("viewBox=\"")
            .map(|v| svg[v + 9..].split('"').next().unwrap_or("").split_whitespace().filter_map(|n| n.parse::<f32>().ok()).collect::<Vec<_>>())
            .filter(|n| n.len() == 4)
            .map(|n| (n[2], n[3]))
            .unwrap_or((400., 300.));
        found.push(Picture { caption, image: Arc::new(Image::from_bytes(ImageFormat::Svg, svg.as_bytes().to_vec())), size });
        rest = &body[end..];
    }
    found
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
                pictures: pictures(s["diagram_html"].as_str().unwrap_or("")),
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

    fn circle(state: &str, cx: &App) -> Div {
        let theme = cx.theme();
        let base = div().flex_none().mt(px(3.)).size(px(13.)).rounded_full().border_2();
        match state {
            "done" => base.border_color(theme.primary).bg(theme.primary),
            "running" => base.border_color(theme.warning).child(div().m(px(2.)).size(px(5.)).rounded_full().bg(theme.warning)),
            _ => base.border_color(theme.muted_foreground.opacity(0.5)),
        }
    }

    fn row(&self, step: &Step, depth: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let open = self.open(step);
        let path = step.path.clone();
        let drawn = !step.pictures.is_empty() || !step.said.is_empty();
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
            .child(Self::circle(&step.state, cx))
            .child(
                div()
                    .v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(div().text_sm().when(step.state == "done", |t| t.text_color(theme.muted_foreground)).child(step.title.clone()))
                    .when(!step.note.is_empty(), |c| c.child(div().text_xs().text_color(theme.muted_foreground).child(step.note.clone()))),
            );
        let mut column = div().v_flex().child(head);
        if open && drawn {
            let room = 400.;
            let mut body = div().v_flex().gap_2().pl(px(32. + 18. * depth as f32)).pr_3().pb_3();
            for (n, picture) in step.pictures.iter().enumerate() {
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
        let (border, muted) = (theme.border, theme.muted_foreground);
        let rows: Vec<AnyElement> = self.steps.iter().map(|s| self.row(s, 0, cx)).collect();
        let empty = rows.is_empty();
        div()
            .v_flex()
            .size_full()
            .child(div().px_4().py_3().border_b_1().border_color(border).font_semibold().child("Steps"))
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
