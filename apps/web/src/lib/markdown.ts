// Claude's replies as HTML, drawn in the browser as they stream in. Raw HTML in a reply shows as text, and a link to
// another site opens in a new tab.
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

// A link an agent writes to desk on its own machine, http://localhost:8790/issue/x as desk's prompts give it: this
// desk's own page, so it opens here, as the phone reaches desk at another address (tailscale serve onto 8790).
const DESK_HERE = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)(\/[^]*)$/;

const linkOpen = md.renderer.rules.link_open ?? ((tokens, i, options, _env, self) => self.renderToken(tokens, i, options));
md.renderer.rules.link_open = (tokens, i, options, env, self) => {
  const here = DESK_HERE.exec(String(tokens[i].attrGet("href") ?? ""));
  if (here && (here[1] === "8790" || here[1] === location.port)) tokens[i].attrSet("href", here[2]);
  const href = String(tokens[i].attrGet("href") ?? "");
  if (/^https?:\/\//.test(href) && !href.startsWith(location.origin)) {
    tokens[i].attrSet("target", "_blank");
    tokens[i].attrSet("rel", "noreferrer");
  }
  return linkOpen(tokens, i, options, env, self);
};

export const markdown = (text: string) => md.render(text);
