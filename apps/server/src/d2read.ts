// Reading d2's text with no run of d2, as boxes.ts and narrow.ts do.

// One d2 statement: its key (a shape's id, a keyword such as style.fill, or an edge such as a -> b), its label, where
// that label stands in the text and the quote around it, and the map after it in braces.
export type Statement = { key: string; label?: string; block?: boolean; at?: { from: number; to: number; quote: string }; map?: Statement[] };

export const KEYWORDS = new Set(["label", "shape", "icon", "width", "height", "style", "near", "tooltip", "link", "direction",
  "constraint", "class", "classes", "vars", "top", "left", "grid-rows", "grid-columns", "grid-gap", "vertical-gap",
  "horizontal-gap", "source-arrowhead", "target-arrowhead", "layers", "scenarios", "steps"]);
export const ARROW = /<->|->|<-|--/;

export const isEdge = (key: string) => ARROW.test(key);
export const isKeyword = (key: string) => KEYWORDS.has(key.split(".")[0]) || /^(\*|&|!&|\.\.\.|\()/.test(key);

// The statements of one diagram, nested by their braces. Quoted strings, |md block strings and # comments are read as
// d2 reads them, so a brace, a semicolon or an arrow inside one is no statement of its own.
export function parse(src: string): Statement[] {
  let i = 0;
  const quoted = () => {
    const q = src[i++];
    let out = "";
    while (i < src.length && src[i] !== q && src[i] !== "\n") out += src[i] === "\\" ? src[i++] + (src[i++] ?? "") : src[i++];
    i++;
    return out;
  };
  // |md ... |, |||md ... |||, |`md ... `|: it ends at its opening pipes and backticks reversed.
  const block = () => {
    const open = /^[|`]+/.exec(src.slice(i))![0];
    const close = [...open].reverse().join("");
    const start = i + open.length;
    const end = src.indexOf(close, start);
    i = end === -1 ? src.length : end + close.length;
    return src.slice(start, end === -1 ? undefined : end);
  };
  const map = (): Statement[] => {
    const out: Statement[] = [];
    while (i < src.length) {
      const c = src[i];
      if (c === "}") return i++, out;
      if (" \t\r\n;".includes(c)) { i++; continue; }
      if (c === "#") { i = src.indexOf("\n", i) === -1 ? src.length : src.indexOf("\n", i); continue; }
      let key = "";
      while (i < src.length && !":{;\n}#".includes(src[i])) key += src[i] === '"' || src[i] === "'" ? quoted() : src[i++];
      const st: Statement = { key: key.trim() };
      if (src[i] === ":") {
        i++;
        while (src[i] === " " || src[i] === "\t") i++;
        const from = i;
        if (src[i] === '"' || src[i] === "'") {
          const quote = src[i];
          st.label = quoted();
          st.at = { from, to: i, quote };
        } else if (src[i] === "|") (st.label = block()), (st.block = true);
        else if (src[i] !== "{") {
          let label = "";
          while (i < src.length && !"{;\n}#".includes(src[i])) label += src[i++];
          st.label = label.trim();
          st.at = { from, to: from + label.trimEnd().length, quote: "" };
        }
        while (src[i] === " " || src[i] === "\t") i++;
      }
      if (src[i] === "{") (i++), (st.map = map());
      if (st.key) out.push(st);
    }
    return out;
  };
  return map();
}
