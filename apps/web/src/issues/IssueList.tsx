import * as stylex from "@stylexjs/stylex";
import { observer } from "mobx-react-lite";
import { issues, STATE_NAMES } from "../store/issues";
import { colors } from "../ui/tokens.stylex";

// The first screen: every issue, grouped by state, kept current by the sync socket. It proves the loop (desk's files,
// the watcher, the socket, the store, the screen) before the real pages move over.
export const IssueList = observer(function IssueList() {
  return (
    <main {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.header)}>
        <h1 {...stylex.props(styles.title)}>Issues</h1>
        <span {...stylex.props(styles.status)}>
          <span {...stylex.props(styles.dot, issues.connected && styles.dotLive)} />
          {issues.connected ? `Live · ${issues.bySlug.size} issues` : "Connecting…"}
        </span>
      </header>
      {issues.byState.map(([state, list]) => (
        <section key={state}>
          <h2 {...stylex.props(styles.group)}>
            {STATE_NAMES[state]} <span {...stylex.props(styles.count)}>{list.length}</span>
          </h2>
          {list.map((issue) => (
            <a key={issue.slug} href={issue.url} {...stylex.props(styles.row)}>
              <span {...stylex.props(styles.rowTitle)}>{issue.title}</span>
              {issue.priority !== "none" && <span {...stylex.props(styles.meta)}>{issue.priority}</span>}
            </a>
          ))}
        </section>
      ))}
    </main>
  );
});

const styles = stylex.create({
  page: { minHeight: "100vh", boxSizing: "border-box", padding: "24px 32px", backgroundColor: colors.bg, color: colors.text1 },
  header: { display: "flex", alignItems: "baseline", gap: 16, marginBottom: 16 },
  title: { margin: 0, fontSize: 20, fontWeight: 600 },
  status: { display: "inline-flex", alignItems: "center", gap: 6, color: colors.text3 },
  dot: { width: 7, height: 7, borderRadius: "50%", backgroundColor: colors.text3 },
  dotLive: { backgroundColor: colors.live },
  group: { margin: "16px 0 4px", fontSize: 13, fontWeight: 500, color: colors.text2 },
  count: { marginLeft: 6, color: colors.text3, fontWeight: 450 },
  row: {
    display: "flex", alignItems: "center", gap: 12, height: 36, padding: "0 8px",
    borderBottom: `1px solid ${colors.border}`, color: colors.text1, textDecoration: "none",
  },
  rowTitle: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  meta: { color: colors.text3, fontSize: 12 },
});
