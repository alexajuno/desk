// The window hidden and shown as Electron's was ("hide", the user, 8 Nov, so that the Inbox's pop-ups keep coming with
// it closed): Hyprland has no hiding, so a closed window goes to a workspace nobody looks at, special:desk, and comes
// back to the workspace you are on when the launcher's desk (bin/desk-app) or a pop-up asks for it. Hyprland 0.56
// takes Lua after `dispatch`. Each call waits on hyprctl, so it runs off the window's thread.
use std::process::Command;

use serde_json::Value;

const HIDDEN: &str = "special:desk";

fn dispatch(lua: String) {
    let _ = Command::new("hyprctl").arg("dispatch").arg(lua).output();
}

fn ask(what: &str) -> Value {
    Command::new("hyprctl").args([what, "-j"]).output().ok().and_then(|o| serde_json::from_slice(&o.stdout).ok()).unwrap_or(Value::Null)
}

// The workspace this window is on, by name, once Hyprland has it.
fn workspace() -> Option<String> {
    let pid = std::process::id();
    ask("clients").as_array()?.iter().find(|c| c["pid"] == pid).and_then(|c| c["workspace"]["name"].as_str().map(str::to_string))
}

pub fn hide() {
    dispatch(format!(r#"hl.dsp.window.move({{ workspace = "{HIDDEN}", window = "pid:{}", follow = false }})"#, std::process::id()));
}

// Hidden as it starts, at login: once Hyprland has the window, within five seconds.
pub fn start_hidden() {
    for _ in 0..50 {
        if workspace().is_some() { return hide() }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

// Back on the workspace you are on, if hidden, and focused.
pub fn show() {
    let pid = std::process::id();
    if workspace().as_deref() == Some(HIDDEN) {
        let name = ask("activeworkspace")["name"].as_str().unwrap_or("").to_string();
        let to = if name.parse::<i64>().is_ok() { name } else { format!("name:{name}") };
        dispatch(format!(r#"hl.dsp.window.move({{ workspace = "{to}", window = "pid:{pid}", follow = false }})"#));
    }
    dispatch(format!(r#"hl.dsp.focus({{ window = "pid:{pid}" }})"#));
}
