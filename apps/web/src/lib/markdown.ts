// Claude's replies as HTML, drawn in the browser as they stream in. Raw HTML in a reply shows as text, and a link to
// another site opens in a new tab.
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

const linkOpen = md.renderer.rules.link_open ?? ((tokens, i, options, _env, self) => self.renderToken(tokens, i, options));
md.renderer.rules.link_open = (tokens, i, options, env, self) => {
  const href = String(tokens[i].attrGet("href") ?? "");
  if (/^https?:\/\//.test(href) && !href.startsWith(location.origin)) {
    tokens[i].attrSet("target", "_blank");
    tokens[i].attrSet("rel", "noreferrer");
  }
  return linkOpen(tokens, i, options, env, self);
};

export const markdown = (text: string) => md.render(text);
