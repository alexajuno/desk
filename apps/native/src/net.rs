// desk's API, as the page calls it: every call names desk itself as its Origin, which the server asks of a page's
// calls and sockets (app.ts, fromPage and fromDesk). The window runs beside desk, on loopback.
use std::{net::TcpStream, time::Duration};

use serde_json::Value;
use tungstenite::{client::IntoClientRequest, stream::MaybeTlsStream, WebSocket};

pub fn host() -> String {
    std::env::var("DESK_HOST").unwrap_or_else(|_| "127.0.0.1:8790".into())
}

pub type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

// A socket whose reads give up after `wait`, so its thread can see that nobody listens any more, or that it has
// something to say.
pub fn socket(path: &str, wait: Duration) -> Result<Socket, Box<dyn std::error::Error>> {
    let host = host();
    let mut request = format!("ws://{host}{path}").into_client_request()?;
    request.headers_mut().insert("Origin", format!("http://{host}").parse()?);
    let (socket, _) = tungstenite::connect(request)?;
    if let MaybeTlsStream::Plain(stream) = socket.get_ref() {
        stream.set_read_timeout(Some(wait))?;
    }
    Ok(socket)
}

pub fn timed_out(error: &tungstenite::Error) -> bool {
    matches!(error, tungstenite::Error::Io(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut))
}

pub fn get(path: &str) -> Result<Value, String> {
    let host = host();
    ureq::get(&format!("http://{host}{path}"))
        .header("Origin", &format!("http://{host}"))
        .call()
        .and_then(|mut r| r.body_mut().read_json::<Value>())
        .map_err(|e| e.to_string())
}

pub fn post(path: &str, body: Value) -> Result<Value, String> {
    let host = host();
    ureq::post(&format!("http://{host}{path}"))
        .header("Origin", &format!("http://{host}"))
        .config()
        .http_status_as_error(false)
        .build()
        .send_json(body)
        .map_err(|e| e.to_string())
        .and_then(|mut r| {
            let ok = r.status().is_success();
            let value = r.body_mut().read_json::<Value>().unwrap_or(Value::Null);
            if ok { Ok(value) } else { Err(value["detail"].as_str().unwrap_or("desk refused it").to_string()) }
        })
}

// A form route of the old pages, as the page's Start, Go and Approve post it (app.ts): desk answers with a redirect,
// whose address says what happened (msg, note) and, from the Inbox, the row to open next (i). The redirect is not
// followed: its address is the answer.
pub fn act(path: &str, body: Value) -> Result<String, String> {
    let host = host();
    let answer = ureq::post(&format!("http://{host}{path}"))
        .header("Origin", &format!("http://{host}"))
        .config()
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .send_json(body)
        .map_err(|e| e.to_string())?;
    if let Some(to) = answer.headers().get("location").and_then(|l| l.to_str().ok()) {
        return Ok(to.to_string());
    }
    if answer.status().is_success() { return Ok(String::new()) }
    let mut answer = answer;
    let value = answer.body_mut().read_json::<Value>().unwrap_or(Value::Null);
    Err(value["detail"].as_str().unwrap_or("desk refused it").to_string())
}

// A query's value in an address desk redirected to.
pub fn query(address: &str, name: &str) -> Option<String> {
    let query = address.split_once('?')?.1;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (key == name).then(|| decode(value))
    })
}

pub fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                match u8::from_str_radix(&text[i + 1..i + 3], 16) {
                    Ok(b) => { out.push(b); i += 2 }
                    Err(_) => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
