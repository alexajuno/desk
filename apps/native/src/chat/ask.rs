// What sits above the composer, as in the web app (Dock.tsx, Running and AskCard): what runs beside the conversation
// now, a quiet line each, and what waits on the user, a permission Claude asks for or its questions as buttons.
use gpui_kit::base::StyledExt;
use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{ActiveTheme, Disableable};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::{json, Map, Value};

use super::{elapsed, Chat, COLUMN};
use crate::live::{self, Ask, Running};
use crate::theme;

fn column(child: impl IntoElement) -> Div {
    div().w_full().flex().justify_center().px_6().child(div().w_full().max_w(px(COLUMN)).child(child))
}

// A task by what it is: a subagent by its type, a watch by the Monitor call that started it.
fn task_name(chat: &Chat, t: &Running) -> String {
    if t.kind == "local_agent" { return if !t.agent.is_empty() && t.agent != "general-purpose" { t.agent.clone() } else { "Agent".into() } }
    if chat.items.iter().any(|i| i.id == t.tool && i.name == "Monitor") { return "Watch".into() }
    if t.kind == "local_bash" { "Shell".into() } else if t.kind.contains("workflow") { "Workflow".into() } else { "Task".into() }
}

// The tasks counted by kind, in the order each kind first started: "3 shells · 1 scout · 1 watch".
fn counted(chat: &Chat) -> String {
    let mut kinds: Vec<(String, usize)> = Vec::new();
    for t in &chat.tasks {
        let name = task_name(chat, t).to_lowercase();
        match kinds.iter_mut().find(|(k, _)| *k == name) {
            Some((_, n)) => *n += 1,
            None => kinds.push((name, 1)),
        }
    }
    kinds.iter().map(|(name, n)| {
        let plural = if *n == 1 { name.clone() } else if ["s", "sh", "ch", "x"].iter().any(|e| name.ends_with(e)) { format!("{name}es") } else { format!("{name}s") };
        format!("{n} {plural}")
    }).collect::<Vec<_>>().join(" · ")
}

// A question of AskUserQuestion's.
struct Question {
    question: String,
    header: String,
    options: Vec<(String, String)>,
    multi: bool,
}

fn questions(ask: &Ask) -> Vec<Question> {
    ask.input["questions"].as_array().into_iter().flatten().map(|q| Question {
        question: q["question"].as_str().unwrap_or("").into(),
        header: q["header"].as_str().unwrap_or("").into(),
        options: q["options"].as_array().into_iter().flatten()
            .map(|o| (o["label"].as_str().unwrap_or("").into(), o["description"].as_str().unwrap_or("").into()))
            .collect(),
        multi: q["multiSelect"].as_bool().unwrap_or(false),
    }).collect()
}

fn key(ask: &str, question: &str) -> String {
    format!("{ask}\u{0}{question}")
}

impl Chat {
    // Each subagent, background command and watch running now, with its latest step and how long it has run. Two or
    // more fold into one line counting them by kind, which a click opens.
    pub(super) fn running(&self, cx: &mut Context<Self>) -> Div {
        if self.tasks.is_empty() { return div() }
        let theme = cx.theme();
        let text = theme::text(cx);
        let dot = || div().flex_none().size(px(6.)).rounded_full().bg(rgb(0xf0bf00));
        let row = |t: &Running| {
            div()
                .h_flex()
                .h(px(26.))
                .px_2()
                .gap_2()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(dot())
                .child(div().flex_none().font_medium().text_color(theme.foreground).child(task_name(self, t)))
                .child(div().min_w_0().truncate().child(t.description.clone()))
                .child(div().flex_1().min_w_0().truncate().text_color(text.dim).child(t.doing.clone()))
                .child(div().flex_none().ml_auto().text_color(text.dim).child(format!(
                    "{}{}",
                    if t.steps > 0 { format!("{} {} · ", t.steps, if t.steps == 1 { "step" } else { "steps" }) } else { String::new() },
                    elapsed(t.since)
                )))
        };
        let folds = self.tasks.len() > 1;
        let mut list = div().v_flex().pb_1();
        if folds {
            list = list.child(
                div()
                    .id("running-head")
                    .h_flex()
                    .h(px(26.))
                    .px_2()
                    .gap_2()
                    .rounded(px(6.))
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .cursor_pointer()
                    .hover(|s| s.bg(text.hover))
                    .on_click(cx.listener(|chat, _, _, cx| { chat.tasks_open = !chat.tasks_open; cx.notify() }))
                    .child(dot())
                    .child(div().font_medium().text_color(theme.foreground).child(counted(self)))
                    .child(div().ml_auto().child(theme::glyph(if self.tasks_open { "caret-open" } else { "caret" }, theme.muted_foreground).size(px(10.)))),
            );
        }
        if !folds || self.tasks_open {
            list = list.children(self.tasks.iter().map(row));
        }
        column(list)
    }

    pub(super) fn ask_cards(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Vec<Div> {
        let asks = self.asks.clone();
        asks.iter().map(|ask| {
            let theme = cx.theme();
            let text = theme::text(cx);
            let card = div()
                .id(SharedString::from(format!("ask-{}", ask.id)))
                .max_h(px(360.))
                .overflow_y_scroll()
                .mb_2()
                .p_3()
                .rounded(px(12.))
                .border_1()
                .border_color(theme.border)
                .bg(text.raised);
            let inside = if ask.tool == "AskUserQuestion" { self.questions(ask, window, cx) } else { self.permission(ask, cx) };
            column(card.child(inside))
        }).collect()
    }

    fn answer(&mut self, ask: String, result: Value, cx: &mut Context<Self>) {
        self.asks.retain(|a| a.id != ask);
        self.asks_changed();
        self.relayout(cx);
        cx.notify();
        self.call(cx, move |session| live::answer(session, &ask, result));
    }

    // Claude asks to use a tool: what it would run, and Deny or Allow.
    fn permission(&mut self, ask: &Ask, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let text = theme::text(cx);
        let input = serde_json::to_string_pretty(&ask.input).unwrap_or_default();
        let input = if input.chars().count() > 1200 { input.chars().take(1200).collect::<String>() + "…" } else { input };
        let (deny, allow) = (ask.id.clone(), ask.id.clone());
        let given = ask.input.clone();
        div()
            .v_flex()
            .gap_2()
            .child(div().h_flex().gap_1().text_size(px(13.)).text_color(text.strong).child("Claude wants to use").child(div().font_semibold().child(ask.tool.clone())))
            .child(
                div()
                    .p_2()
                    .rounded(px(6.))
                    .bg(theme.background)
                    .font_family(theme.mono_font_family.clone())
                    .text_size(px(11.5))
                    .line_height(relative(1.5))
                    .text_color(theme.foreground)
                    .child(input),
            )
            .child(
                div()
                    .h_flex()
                    .justify_end()
                    .gap_2()
                    .child(Button::new("deny").ghost().label("Deny").on_click(cx.listener(move |chat, _, _, cx| {
                        chat.answer(deny.clone(), json!({"behavior": "deny", "message": "The user said no in desk's panel."}), cx)
                    })))
                    .child(Button::new("allow").primary().label("Allow").on_click(cx.listener(move |chat, _, _, cx| {
                        chat.answer(allow.clone(), json!({"behavior": "allow", "updatedInput": given.clone()}), cx)
                    }))),
            )
            .into_any_element()
    }

    // Claude's questions: each its options as buttons and a box for something else. One question with one answer is
    // answered by picking it, as in Claude Code's terminal; otherwise Answer sends them all.
    fn questions(&mut self, ask: &Ask, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let list = questions(ask);
        for q in &list {
            let k = key(&ask.id, &q.question);
            if !self.others.contains_key(&k) {
                let input = cx.new(|cx| InputState::new(window, cx).placeholder("Something else…"));
                let id = ask.id.clone();
                cx.subscribe_in(&input, window, move |chat, _, event: &InputEvent, _, cx| {
                    if let InputEvent::PressEnter { .. } = event { chat.submit_answers(id.clone(), cx) }
                    if let InputEvent::Change = event { cx.notify() }
                })
                .detach();
                self.others.insert(k, input);
            }
        }
        let theme = cx.theme();
        let text = theme::text(cx);
        let typed = list.iter().any(|q| !self.other(&ask.id, &q.question, cx).is_empty());
        let done = self.answered(&ask.id, &list, cx);
        let single = list.len() == 1 && !list[0].multi;
        let mut card = div().v_flex().gap(px(14.));
        for q in &list {
            let picked = self.picked.get(&key(&ask.id, &q.question)).cloned().unwrap_or_default();
            let mut options = div().v_flex().gap(px(6.));
            for (n, (label, about)) in q.options.iter().enumerate() {
                let on = picked.contains(label);
                let (id, question, label_, multi) = (ask.id.clone(), q.question.clone(), label.clone(), q.multi);
                options = options.child(
                    div()
                        .id(SharedString::from(format!("option-{}-{n}-{}", ask.id, q.question.len())))
                        .v_flex()
                        .min_h(px(36.))
                        .px_3()
                        .py(px(7.))
                        .gap(px(2.))
                        .rounded(px(8.))
                        .border_1()
                        .border_color(if on { text.accent } else { theme.border })
                        .bg(theme.background)
                        .cursor_pointer()
                        .hover(|s| s.bg(text.hover))
                        .on_click(cx.listener(move |chat, _, _, cx| chat.pick(id.clone(), question.clone(), label_.clone(), multi, single, cx)))
                        .child(div().text_size(px(13.)).font_medium().text_color(text.strong).child(label.clone()))
                        .when(!about.is_empty(), |o| o.child(div().text_xs().line_height(relative(1.4)).text_color(theme.muted_foreground).child(about.clone()))),
                );
            }
            if let Some(input) = self.others.get(&key(&ask.id, &q.question)) {
                options = options.child(Input::new(input).text_size(px(13.)));
            }
            card = card.child(
                div()
                    .v_flex()
                    .when(!q.header.is_empty(), |c| c.child(div().mb_1().text_size(px(11.)).font_medium().text_color(theme.muted_foreground).child(q.header.clone())))
                    .child(div().mb_2().text_size(px(13.)).font_medium().line_height(relative(1.45)).text_color(text.strong).child(q.question.clone()))
                    .child(options),
            );
        }
        if !single || typed {
            let id = ask.id.clone();
            card = card.child(
                div().h_flex().justify_end().child(
                    Button::new("answer").primary().label("Answer").disabled(!done)
                        .on_click(cx.listener(move |chat, _, _, cx| chat.submit_answers(id.clone(), cx))),
                ),
            );
        }
        card.into_any_element()
    }

    fn other(&self, ask: &str, question: &str, cx: &App) -> String {
        self.others.get(&key(ask, question)).map(|i| i.read(cx).value().trim().to_string()).unwrap_or_default()
    }

    fn answered(&self, ask: &str, list: &[Question], cx: &App) -> bool {
        list.iter().all(|q| self.picked.get(&key(ask, &q.question)).is_some_and(|p| !p.is_empty()) || !self.other(ask, &q.question, cx).is_empty())
    }

    fn pick(&mut self, ask: String, question: String, label: String, multi: bool, single: bool, cx: &mut Context<Self>) {
        let now = self.picked.entry(key(&ask, &question)).or_default();
        if multi {
            if let Some(at) = now.iter().position(|l| *l == label) { now.remove(at); } else { now.push(label.clone()) }
        } else {
            *now = vec![label.clone()];
        }
        if single {
            let mut answers = Map::new();
            answers.insert(question, Value::String(label));
            return self.send_answers(ask, answers, cx);
        }
        cx.notify();
    }

    fn submit_answers(&mut self, ask: String, cx: &mut Context<Self>) {
        let Some(found) = self.asks.iter().find(|a| a.id == ask).cloned() else { return };
        let list = questions(&found);
        if !self.answered(&ask, &list, cx) { return }
        let mut answers = Map::new();
        for q in &list {
            let mut said = self.picked.get(&key(&ask, &q.question)).cloned().unwrap_or_default();
            let other = self.other(&ask, &q.question, cx);
            if !other.is_empty() { said.push(other) }
            answers.insert(q.question.clone(), Value::String(said.join(", ")));
        }
        self.send_answers(ask, answers, cx);
    }

    fn send_answers(&mut self, ask: String, answers: Map<String, Value>, cx: &mut Context<Self>) {
        let Some(found) = self.asks.iter().find(|a| a.id == ask) else { return };
        let mut input = found.input.clone();
        input["answers"] = Value::Object(answers);
        self.answer(ask, json!({"behavior": "allow", "updatedInput": input}), cx);
    }
}
