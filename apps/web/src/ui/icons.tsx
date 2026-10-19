// desk's icons (templates/macros.html and desk.js's GLYPH): Linear's shapes, coloured by desk.css's variables so they
// follow the theme. Each renders the same SVG the old pages drew.
import type { ReactNode } from "react";
import type { Priority, Protocol, State } from "../lib/desk";

const FILL: Record<string, number> = { backlog: 0, running: 0.5, review: 0.75, landing: 0.9 };

export function StateIcon({ state }: { state: State }) {
  if (state === "done")
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" style={{ color: "var(--state-done)" }}>
        <circle cx="7" cy="7" r="6.25" fill="currentColor" />
        <path d="M4.4 7.1l1.8 1.8 3.4-3.6" fill="none" style={{ stroke: "var(--on-accent)" }} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (state === "dropped")
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" style={{ color: "var(--state-dropped)" }}>
        <circle cx="7" cy="7" r="6.25" fill="currentColor" />
        <path d="M5 5l4 4M9 5l-4 4" style={{ stroke: "var(--state-cross)" }} strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  if (state === "triage")
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" style={{ color: "var(--state-triage)" }}>
        <circle cx="7" cy="7" r="6.25" fill="currentColor" />
        <path d="M4.25 5.6h5.5M8.1 3.95l1.65 1.65M9.75 8.4h-5.5M5.9 10.05L4.25 8.4" fill="none" style={{ stroke: "var(--on-accent)" }} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (state === "waiting")
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ color: "var(--state-waiting)" }}>
        <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5.6 4.9v4.2M8.4 4.9v4.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  const f = FILL[state] ?? 0;
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ color: `var(--state-${state})` }}>
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" {...(state === "backlog" ? { strokeDasharray: "1.4 1.74", strokeDashoffset: "0.65" } : {})} />
      {f > 0 && <circle cx="7" cy="7" r="2" stroke="currentColor" strokeWidth="4" strokeDasharray={`${(12.566 * f).toFixed(3)} 12.566`} transform="rotate(-90 7 7)" />}
    </svg>
  );
}

export function PrioIcon({ level }: { level: Priority }) {
  if (level === "urgent")
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={{ fill: "var(--urgent)" }}>
        <path d="M3 1C1.91 1 1 1.91 1 3v10c0 1.09.91 2 2 2h10c1.09 0 2-.91 2-2V3c0-1.09-.91-2-2-2H3zm4 3h2l-.25 5H7.25L7 4zm2 7a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" />
      </svg>
    );
  if (level === "none")
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" style={{ fill: "var(--text-3)" }}>
        <rect x="1.5" y="7.25" width="3" height="1.5" rx=".5" />
        <rect x="6.5" y="7.25" width="3" height="1.5" rx=".5" />
        <rect x="11.5" y="7.25" width="3" height="1.5" rx=".5" />
      </svg>
    );
  const n = { high: 3, medium: 2, low: 1 }[level];
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" style={{ fill: "var(--prio)" }}>
      <rect x="1.5" y="8" width="3" height="6" rx="1" />
      <rect x="6.5" y="5" width="3" height="9" rx="1" {...(n < 2 ? { fillOpacity: ".4" } : {})} />
      <rect x="11.5" y="2" width="3" height="12" rx="1" {...(n < 3 ? { fillOpacity: ".4" } : {})} />
    </svg>
  );
}

// A protocol: a bolt for quick, a few lines for a brief, a page for a design doc.
export function ProtoIcon({ name }: { name: Protocol }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-2)" }}>
      {name === "quick" ? <path d="M9 1.75L3.75 9h4l-1 5.25L12.25 7h-4z" />
        : name === "brief" ? <path d="M3 4.5h10M3 8h10M3 11.5h6" />
        : <><path d="M4 1.75h5l3 3v9.5H4z" /><path d="M9 1.75v3h3M6.25 8.25h3.5M6.25 10.75h3.5" /></>}
    </svg>
  );
}

// An open session that is idle: the status circle with nothing in it.
export function Ring() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ color: "var(--state-backlog)" }}>
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function fieldIcon(field: "state" | "priority" | "protocol", value: string): ReactNode {
  if (field === "state") return <StateIcon state={value as State} />;
  if (field === "priority") return <PrioIcon level={value as Priority} />;
  return <ProtoIcon name={value as Protocol} />;
}

const glyph = (path: ReactNode) => (
  <svg className="glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">{path}</svg>
);

export const GLYPH = {
  project: glyph(<path d="M8 2l5.5 3v6L8 14l-5.5-3V5z" />),
  parent: glyph(<path d="M4.5 2.5v6a2 2 0 0 0 2 2h6M10 8l2.5 2.5L10 13" />),
  plus: glyph(<path d="M8 3.5v9M3.5 8h9" />),
  link: glyph(<path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.5.5M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.5-.5" />),
  triage: glyph(<><path d="M2 9.5h3.25l1 1.75h3.5l1-1.75H14" /><path d="M2 9.5l1.6-5.1c.13-.42.52-.65.95-.65h6.9c.43 0 .82.23.95.65L14 9.5v2.75c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1z" /><path d="M8 4.5v3.25M6.6 6.4 8 7.75 9.4 6.4" /></>),
  chat: glyph(<path d="M8 2.5c3.3 0 6 2.2 6 4.9s-2.7 4.9-6 4.9c-.6 0-1.1-.1-1.6-.2L3 13.5l.6-2.3C2.6 10.3 2 9 2 7.4 2 4.7 4.7 2.5 8 2.5z" />),
  terminal: glyph(<><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" /><path d="M4.5 6l2 2-2 2M8 10.5h3.5" /></>),
  id: glyph(<path d="M6.5 2.5l-1 11M10.5 2.5l-1 11M3 6h10.5M2.5 10H13" />),
  archive: glyph(<><rect x="2" y="3" width="12" height="3" rx="1" /><path d="M3 6v6.5c0 .28.22.5.5.5h9c.28 0 .5-.22.5-.5V6M6.5 8.75h3" /></>),
  trash: glyph(<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />),
  pencil: glyph(<path d="M10.5 2.75l2.75 2.75L6 12.75H3.25V10zM9 4.25L11.75 7" />),
  none: glyph(<><circle cx="8" cy="8" r="5.5" /><path d="M4.2 11.8l7.6-7.6" /></>),
  folder: glyph(<path d="M2 4.5c0-.83.67-1.5 1.5-1.5h3l1.5 1.5h4.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9C2.67 13 2 12.33 2 11.5v-7z" />),
  system: glyph(<><rect x="2" y="3" width="12" height="8.5" rx="1.5" /><path d="M6 14h4M8 11.5V14" /></>),
  light: glyph(<><circle cx="8" cy="8" r="2.75" /><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05" /></>),
  dark: glyph(<path d="M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6z" />),
  sliders: glyph(<path d="M2.5 4.5h3M9.5 4.5h4M2.5 11.5h6M12.5 11.5h1M7.5 3v3M10.5 10v3" />),
  keys: glyph(<><rect x="1.75" y="3.75" width="12.5" height="8.5" rx="1.5" /><path d="M4.5 6.5h.01M7 6.5h.01M9.5 6.5h.01M12 6.5h.01M5 9.5h6" /></>),
  close: glyph(<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />),
  pin: glyph(<path d="M9.75 2.25l4 4-1.6.55-2.65 2.65.45 3.05-1.1 1.1L2.4 7.15l1.1-1.1 3.05.45L9.2 3.85zM5.35 10.65 2.25 13.75" />),
  clock: glyph(<><circle cx="8" cy="8" r="5.75" /><path d="M8 5v3.25l2 1.25" /></>),
};

export const TICK = (
  <svg className="tick" viewBox="0 0 14 14" width="14" height="14">
    <path d="M3 7.5l2.5 2.5L11 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const CHEVRON = (
  <svg className="chev" viewBox="0 0 16 16" width="12" height="12">
    <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
// Linear's triangle beside a group's or a section's heading (macros.html's toggle and fold).
export const TRIANGLE = (
  <svg width="16" height="16" viewBox="0 0 16 16">
    <path d="M6.75194 10.6239C6.41861 10.8183 6 10.5779 6 10.192V5.80802C6 5.42212 6.41861 5.18169 6.75194 5.37613L10.5096 7.56811C10.8404 7.76105 10.8404 8.23895 10.5096 8.43189L6.75194 10.6239Z" />
  </svg>
);
export const PLUS = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><path d="M8 3.5v9M3.5 8h9" /></svg>
);
export const SIDE_ICON = (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="2" y="2.75" width="12" height="10.5" rx="2.5" /><path d="M6.25 2.75v10.5" /></svg>
);
