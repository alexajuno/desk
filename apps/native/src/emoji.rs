// Slack's emoji by name, so that a reaction Slack names (+1, eyes, white_check_mark, pray::skin-tone-3) draws as its
// character, and the picker lists them by category (thread.rs). The table is the web app's (apps/web/src/inbox/emoji.ts,
// iamcal/emoji-data's short names), read from that file as it is so both apps keep one copy: a line per category, each
// entry its names, the first its own, then its codepoints in hex, then :t when it takes a skin tone.
use std::collections::HashMap;
use std::sync::LazyLock;

const TABLE: &str = include_str!("../../web/src/inbox/emoji.ts");

pub struct Emoji {
    pub name: String,
    pub names: Vec<String>,
    pub char: String,
    tones: bool,
    points: Vec<u32>,
}

pub struct Group {
    pub title: String,
    pub emoji: Vec<Emoji>,
}

fn entry(text: &str) -> Option<Emoji> {
    let mut parts = text.split(':');
    let names: Vec<String> = parts.next()?.split(',').map(str::to_string).collect();
    let points: Vec<u32> = parts.next()?.split('-').filter_map(|h| u32::from_str_radix(h, 16).ok()).collect();
    let tones = parts.next() == Some("t");
    Some(Emoji { name: names.first()?.clone(), char: points.iter().filter_map(|p| char::from_u32(*p)).collect(), names, tones, points })
}

static GROUPS: LazyLock<Vec<Group>> = LazyLock::new(|| {
    TABLE
        .lines()
        .filter_map(|line| {
            let line = line.trim().strip_prefix("[\"")?.strip_suffix("\"],")?;
            let (title, list) = line.split_once("\", \"")?;
            Some(Group { title: title.to_string(), emoji: list.split(' ').filter_map(entry).collect() })
        })
        .collect()
});

static BY_NAME: LazyLock<HashMap<&'static str, &'static Emoji>> =
    LazyLock::new(|| GROUPS.iter().flat_map(|g| &g.emoji).flat_map(|e| e.names.iter().map(move |n| (n.as_str(), e))).collect());

// The emoji by category, as the picker lists them.
pub fn groups() -> &'static [Group] {
    &GROUPS
}

// The character of an emoji Slack names, a skin tone after it as ::skin-tone-2 to 6 (Fitzpatrick's modifiers U+1F3FB to
// U+1F3FF, put after the emoji's first codepoint, its variation selector dropped); none for a name Slack's own table
// lacks, the workspace's own emoji.
pub fn char_of(name: &str) -> Option<String> {
    let (base, tone) = match name.split_once("::") {
        Some((base, tone)) => (base, Some(tone)),
        None => (name, None),
    };
    let e = BY_NAME.get(base)?;
    let tone = tone.and_then(|t| t.strip_prefix("skin-tone-")).and_then(|n| n.parse::<u32>().ok()).filter(|n| (2..=6).contains(n));
    match tone {
        Some(n) if e.tones => {
            let mut points = e.points.clone();
            if points.get(1) == Some(&0xfe0f) { points.remove(1); }
            points.insert(1, 0x1f3fb + n - 2);
            Some(points.iter().filter_map(|p| char::from_u32(*p)).collect())
        }
        _ => Some(e.char.clone()),
    }
}
