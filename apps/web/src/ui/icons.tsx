// desk's icons (templates/macros.html and desk.js's GLYPH): Linear's shapes, coloured by desk.css's variables so they
// follow the theme. Each renders the same SVG the old pages drew.
import { useId, type ReactNode } from "react";
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

// One of Linear's icons, drawn filled rather than stroked.
const filled = (path: ReactNode) => (
  <svg className="glyph" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">{path}</svg>
);

// Linear's project status icon, from its Change status menu on 20 Oct: a hexagon, dashed for Backlog, with a pie of how
// far along it is inside, which Completed fills with a tick and Canceled with a cross. Each is coloured by its status
// (desk.css, --project-*); an In Progress one shows the project's progress, or half when none is given, as the menu's.
const HEX = "M2.95778 3.02069L5.70777 1.36023C6.50244 0.88041 7.49756 0.88041 8.29223 1.36024L11.0422 3.02074C11.7918 3.47336 12.25 4.2852 12.25 5.16086V8.84803C12.25 9.7251 11.7904 10.5381 11.0388 10.9902L8.29114 12.6433C7.49693 13.1211 6.50355 13.1203 5.71011 12.6412L2.95775 10.9792C2.20815 10.5266 1.75 9.7148 1.75 8.83911V5.16082C1.75 4.28516 2.20816 3.47332 2.95778 3.02069Z";
const INNER = "M8.3779 4.74233C8.14438 4.60607 7.85562 4.60607 7.6221 4.74233L5.37209 6.05513C5.14168 6.18957 5 6.4363 5 6.70311V9.34216C5 9.60897 5.14168 9.85573 5.37209 9.99016L7.6221 11.303C7.85562 11.4392 8.14438 11.4392 8.3779 11.303L10.6279 9.99016C10.8583 9.85573 11 9.60897 11 9.34216V6.70311C11 6.4363 10.8583 6.18957 10.6279 6.05513L8.3779 4.74233Z";
const MARK: Record<string, string> = {
  completed: "M10.7803 5.28033C11.0732 4.98744 11.0732 4.51256 10.7803 4.21967C10.4874 3.92678 10.0126 3.92678 9.7197 4.21967L5.75 8.18934L4.28033 6.71967C3.98744 6.42678 3.51256 6.42678 3.21967 6.71967C2.92678 7.01256 2.92678 7.48744 3.21967 7.78033L5.21967 9.7803C5.51256 10.0732 5.98744 10.0732 6.28033 9.7803L10.7803 5.28033Z",
  canceled: "M3.73657 3.73657C4.05199 3.42114 4.56339 3.42114 4.87881 3.73657L5.93941 4.79716L7 5.85775L9.12117 3.73657C9.4366 3.42114 9.94801 3.42114 10.2634 3.73657C10.5789 4.05199 10.5789 4.56339 10.2634 4.87881L8.14225 7L10.2634 9.12118C10.5789 9.4366 10.5789 9.94801 10.2634 10.2634C9.94801 10.5789 9.4366 10.5789 9.12117 10.2634L7 8.14225L4.87881 10.2634C4.56339 10.5789 4.05199 10.5789 3.73657 10.2634C3.42114 9.94801 3.42114 9.4366 3.73657 9.12118L4.79716 8.06059L5.85775 7L3.73657 4.87881C3.42114 4.56339 3.42114 4.05199 3.73657 3.73657Z",
};

export function ProjectStatusIcon({ status, progress }: { status: string; progress?: number }) {
  const id = `ps${useId().replace(/[^\w-]/g, "")}`, full = status === "completed" || status === "canceled";
  const f = full ? 1 : status === "started" ? progress ?? 0.5 : 0;
  return (
    <svg className="project-status" width="16" height="16" viewBox="-1 -1 16 16" fill="none" style={{ color: `var(--project-${status})` }}>
      <path d={HEX} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="bevel" fill="none"
        {...(status === "backlog" ? { strokeDasharray: "1.65 1.35", strokeDashoffset: "2.3" } : { strokeDasharray: "3.14 0", strokeDashoffset: "1" })} />
      <g mask={`url(#${id})`}>
        <circle r="4" cx="7" cy="7" stroke="currentColor" fill="none" strokeWidth="8" strokeDasharray={`${(25.12 * f).toFixed(2)} 25.12`} transform="rotate(-90) translate(-14, 0)" />
      </g>
      <mask id={id} maskUnits="userSpaceOnUse">
        <path transform={full ? "translate(-7.5, -7.5) scale(1.8)" : "translate(-1, -1)"} d={INNER} fill="white" />
        {full && <path d={MARK[status]} fill="black" />}
      </mask>
    </svg>
  );
}

// Linear's health icons, from a project update's health menu on linear.app, 20 Oct: a tinted disc with a line going up
// (On track), a zigzag (At risk) or a line going down (Off track); with no update, a dashed ring. Update missing shows the
// last one's, ringed, or the ring, as Linear's dashed outline over its icon; grey once a week overdue (stale).
const HEALTH_PATH: Record<string, string> = {
  on_track: "M12.6807 5.7029C12.9925 5.97566 13.0241 6.44948 12.7513 6.76121L9.71942 10.2263C9.56569 10.402 9.33892 10.4961 9.10596 10.4808C8.873 10.4656 8.66044 10.3427 8.53094 10.1485L6.76432 7.49855L4.37742 10.2263C4.10466 10.5381 3.63083 10.5696 3.31911 10.2969C3.00739 10.0241 2.97581 9.55028 3.24857 9.23856L6.28056 5.77356C6.43429 5.59788 6.66106 5.50379 6.89401 5.51905C7.12696 5.53432 7.33952 5.65718 7.46902 5.85142L9.23562 8.50133L11.6224 5.77347C11.8952 5.46174 12.369 5.43015 12.6807 5.7029Z",
  at_risk: "M9.62562 3.8314C9.85957 3.7977 10.0957 3.87627 10.2628 4.04341L12.5728 6.35341C12.8657 6.6463 12.8657 7.12117 12.5728 7.41407C12.28 7.70696 11.8051 7.70696 11.5122 7.41407L9.91096 5.81284L6.92594 11.2854C6.81276 11.4929 6.60838 11.6349 6.37442 11.6686C6.14047 11.7023 5.90433 11.6237 5.73719 11.4566L3.42719 9.14657C3.1343 8.85367 3.1343 8.3788 3.42719 8.08591C3.72008 7.79301 4.19496 7.79301 4.48785 8.08591L6.08908 9.68714L9.0741 4.2146C9.18728 4.00709 9.39166 3.86509 9.62562 3.8314Z",
  off_track: "M12.6807 10.297C12.9925 10.0242 13.0241 9.5504 12.7513 9.23866L9.71942 5.77356C9.56569 5.59786 9.33892 5.50377 9.10596 5.51903C8.873 5.53429 8.66044 5.65716 8.53094 5.8514L6.76432 8.50133L4.37742 5.77354C4.10466 5.46182 3.63083 5.43024 3.31911 5.703C3.00739 5.97577 2.97581 6.44959 3.24857 6.76132L6.28056 10.2263C6.43429 10.402 6.66106 10.4961 6.89401 10.4808C7.12696 10.4656 7.33952 10.3427 7.46902 10.1485L9.23562 7.49855L11.6224 10.2264C11.8952 10.5381 12.369 10.5697 12.6807 10.297Z",
};

export function HealthIcon({ health, state }: { health: string | null; state?: string }) {
  const color = state === "stale" ? "var(--text-5)" : health ? `var(--health-${health})` : "var(--text-5)";
  const missing = state === "missing" || state === "stale";
  return (
    <svg className="health-icon" width="16" height="16" viewBox="0 0 16 16" style={{ color }}>
      {health && HEALTH_PATH[health] ? (
        <><circle r="8" cx="8" cy="8" fill="currentColor" opacity="0.25" /><path fillRule="evenodd" clipRule="evenodd" d={HEALTH_PATH[health]} fill="currentColor" /></>
      ) : null}
      {(!health || missing) && <circle r="7.5" cx="8" cy="8" fill="none" strokeWidth="1" strokeDasharray="2.36 2.36" strokeLinecap="round" stroke={missing ? "var(--health-missing)" : "currentColor"} />}
    </svg>
  );
}

// Linear's milestone diamonds, from its icon sprite on 20 Oct: an outline for one not started, a quarter filled while
// its issues are under way, full once done. The current one, which its project works towards, is yellow, as Linear's.
export function MilestoneIcon({ progress, current }: { progress: number; current?: boolean }) {
  const color = progress >= 100 ? "var(--project-completed)" : current ? "var(--project-started)" : "var(--text-3)";
  const outline = "M6.679 1.122a1.715 1.715 0 0 1 2.642 0L14.104 6.9a1.726 1.726 0 0 1 0 2.2l-4.783 5.778a1.715 1.715 0 0 1-2.642 0L1.896 9.1a1.726 1.726 0 0 1 0-2.2zm1.706 2.006a.5.5 0 0 0-.77 0L3.845 7.68a.5.5 0 0 0 0 .638l3.77 4.553a.5.5 0 0 0 .77 0l3.77-4.553a.5.5 0 0 0 0-.638z";
  return (
    <svg className="milestone-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style={{ color }}>
      {progress >= 100 ? <path fillRule="evenodd" clipRule="evenodd" d="M6.679 1.122a1.715 1.715 0 0 1 2.642 0L14.104 6.9a1.726 1.726 0 0 1 0 2.2l-4.783 5.778a1.715 1.715 0 0 1-2.642 0L1.896 9.1a1.726 1.726 0 0 1 0-2.2z" />
        : progress > 0 ? <><path fillRule="evenodd" clipRule="evenodd" d={outline} opacity=".3" /><path d="M8 .5c.512 0 .996.23 1.321.622l2.516 3.04-1.42 1.42-2.032-2.454A.5.5 0 0 0 8 2.946z" /></>
        : <path fillRule="evenodd" clipRule="evenodd" d={outline} />}
    </svg>
  );
}

const glyph = (path: ReactNode) => (
  <svg className="glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">{path}</svg>
);

export const GLYPH = {
  // Linear's own, from linear.app's icon sprite on 20 Oct: Project, Team, Calendar, the start and target date chips',
  // Chat, and the Link on an issue's Copy issue URL.
  link: filled(<path d="M9.30558 10.206C9.57224 10.4726 9.59447 10.8912 9.37225 11.1831L9.30558 11.2594L6.84751 13.7175C5.58692 14.9781 3.54311 14.9781 2.28252 13.7175C1.0654 12.5004 1.02344 10.5531 2.15661 9.28564L2.28252 9.15251L4.74059 6.69443C5.0315 6.40353 5.50315 6.40353 5.79405 6.69443C6.06071 6.9611 6.08294 7.37963 5.86072 7.67161L5.79405 7.74789L3.33598 10.206C2.6572 10.8847 2.6572 11.9853 3.33598 12.664C3.98082 13.3089 5.00628 13.3411 5.68918 12.7608L5.79405 12.664L8.25212 10.206C8.54303 9.91506 9.01468 9.91506 9.30558 10.206ZM9.82982 6.17019C10.1207 6.46109 10.1207 6.93274 9.82982 7.22365L7.34921 9.70427C7.0583 9.99518 6.58665 9.99518 6.29575 9.70427C6.00484 9.41337 6.00484 8.94172 6.29575 8.65081L8.77637 6.17019C9.06727 5.87928 9.53892 5.87928 9.82982 6.17019ZM13.7175 2.2825C14.9346 3.49962 14.9766 5.44688 13.8434 6.71436L13.7175 6.84749L11.2594 9.30557C10.9685 9.59647 10.4969 9.59647 10.206 9.30557C9.93931 9.03891 9.91709 8.62037 10.1393 8.32839L10.206 8.25211L12.664 5.79403C13.3428 5.11525 13.3428 4.01474 12.664 3.33596C12.0192 2.69112 10.9938 2.65888 10.3109 3.23923L10.206 3.33596L7.74791 5.79403C7.457 6.08494 6.98535 6.08494 6.69445 5.79403C6.42779 5.52737 6.40556 5.10883 6.62778 4.81686L6.69445 4.74057L9.15252 2.2825C10.4131 1.02191 12.4569 1.02191 13.7175 2.2825Z" />),
  chat: filled(<path fillRule="evenodd" clipRule="evenodd" d="M11.869 11.52c.946-.767 1.631-1.956 1.631-3.77s-.685-3.003-1.631-3.77C10.879 3.178 9.486 2.75 8 2.75c-1.694 0-3.065.44-3.985 1.213-.88.74-1.515 1.918-1.515 3.787 0 1.104.255 1.96.641 2.622.541.81.224 1.65.119 1.906-.073.177-.16.344-.219.455l-.03.057a7 7 0 0 0-.136.268c.242.18.563.217 1.1.078a7 7 0 0 0 .893-.32l.027-.01c.124-.052.29-.12.438-.17.08-.027.21-.067.36-.092.09-.014.365-.057.695.03A7.3 7.3 0 0 0 8 12.75c1.486 0 2.88-.428 3.869-1.23m-5.852 2.507A8.8 8.8 0 0 0 8 14.25c3.501 0 7-2.005 7-6.5s-3.499-6.5-7-6.5c-3.866 0-7 2.005-7 6.5 0 1.372.326 2.512.878 3.434.168.222.003.535-.19.901-.3.565-.665 1.257.02 1.942 1.215 1.215 2.864.534 3.739.173.289-.119.493-.203.57-.173" />),
  project: filled(<path fillRule="evenodd" clipRule="evenodd" d="M7.331 1.07a3.2 3.2 0 0 1 1.338 0c.498.106.967.377 1.904.917l1.354.78c.937.541 1.406.812 1.747 1.19.301.334.53.728.669 1.156.157.484.157 1.025.157 2.107v1.56l-.003.718c-.007.63-.036 1.026-.154 1.389l-.057.158a3.2 3.2 0 0 1-.612.998l-.135.138c-.33.312-.792.578-1.612 1.051l-1.354.78-.623.357c-.55.309-.907.481-1.281.56l-.166.032a3.2 3.2 0 0 1-1.006 0l-.166-.031c-.374-.08-.73-.252-1.281-.561l-.623-.356-1.354-.78c-.82-.474-1.281-.74-1.612-1.052l-.135-.138a3.2 3.2 0 0 1-.612-.998l-.057-.158c-.118-.363-.147-.758-.154-1.39L1.5 8.78V7.22c0-.946 0-1.479.105-1.921l.052-.186c.122-.374.312-.723.56-1.028l.11-.128c.255-.284.583-.507 1.126-.83l.62-.36 1.354-.78c.82-.473 1.281-.739 1.718-.869zM3 7.22v1.56c0 1.183.018 1.439.084 1.643l.064.167q.11.246.292.449l.059.06c.151.143.427.318 1.323.835l1.354.78.632.36c.188.104.33.178.442.233V8.482l-4.247-1.93zm5.75 1.262v4.826c.212-.106.533-.282 1.074-.594l1.354-.78.628-.368c.499-.297.646-.407.754-.527l.113-.14q.158-.218.243-.476l.022-.081c.035-.144.051-.351.058-.835L13 8.78V7.22l-.004-.668zM7.82 2.51l-.177.027c-.159.034-.328.106-.835.39l-.632.359-1.354.78c-.896.517-1.172.692-1.323.834l-.059.06q-.046.051-.086.104l4.645 2.112 4.645-2.112-.084-.103c-.109-.12-.255-.23-.754-.528l-.628-.367-1.354-.78c-.897-.517-1.186-.668-1.386-.728l-.08-.021a1.7 1.7 0 0 0-.538-.027" />),
  team: filled(<><path d="M12.5 13.5V15h-9v-1.5zm1-1v-9a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1V15l-.256-.013a2.5 2.5 0 0 1-2.231-2.231L1 12.5v-9a2.5 2.5 0 0 1 2.244-2.487L3.5 1h9l.256.013A2.5 2.5 0 0 1 15 3.5v9l-.013.256a2.5 2.5 0 0 1-2.231 2.231L12.5 15v-1.5a1 1 0 0 0 1-1" /><path d="M10 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0m1.405 6h-6.81c-.407 0-.714-.336-.55-.693.362-.79 1.344-1.974 3.98-1.974 2.648 0 3.597 1.196 3.935 1.986.152.355-.153.681-.555.681" /></>),
  milestone: filled(<path d="m9.692 12.41 1.164.945-1.033 1.271a2.34 2.34 0 0 1-3.646 0l-1.034-1.27 1.164-.947 1.034 1.27a.84.84 0 0 0 1.318 0zM3.66 5.657l.582.474-1.032 1.27a.96.96 0 0 0 0 1.196l1.032 1.27-.582.474-.001-.001-.581.474-1.032-1.271a2.46 2.46 0 0 1 0-3.088l1.032-1.27zm10.295.798a2.46 2.46 0 0 1 0 3.088l-1.032 1.27-.582-.473-.582-.473h-.001l1.033-1.27a.96.96 0 0 0 .092-1.06l-.092-.136-1.033-1.27 1.165-.946zM6.267 1.268a2.34 2.34 0 0 1 3.556.106l1.033 1.27-1.165.947L8.66 2.32a.84.84 0 0 0-1.318 0L6.307 3.59l-1.164-.946 1.034-1.27z" />),
  calendar: filled(<path d="M11 1a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4V5a4 4 0 0 1 4-4zm2.5 5h-11v5A2.5 2.5 0 0 0 5 13.5h6a2.5 2.5 0 0 0 2.5-2.5z" />),
  start: filled(<><path d="M11 1C13.2091 1 15 2.79086 15 5V6.25C15 6.66421 14.6642 7 14.25 7C13.8358 7 13.5 6.66421 13.5 6.25V6H2.5V11C2.5 12.3807 3.61929 13.5 5 13.5H6.25C6.66421 13.5 7 13.8358 7 14.25C7 14.6642 6.66421 15 6.25 15H5C2.79086 15 1 13.2091 1 11V5C1 2.79086 2.79086 1 5 1H11Z" /><path fillRule="evenodd" clipRule="evenodd" d="M10.9118 8.16689C11.0947 7.96599 11.4153 7.94327 11.6279 8.11614L14.8823 10.7625C14.8952 10.7731 14.9073 10.7846 14.9185 10.7968C15.0402 10.931 15.0237 11.133 14.8818 11.2479L11.6272 13.8845C11.5351 13.959 11.4179 14 11.2967 14C11.0162 14 10.7889 13.7851 10.7889 13.5201L10.7903 12.1013C8.78103 11.922 6 11.3681 6 11.0389C6 10.79 6.26274 10.4027 10.7882 9.87701L10.7889 8.4799C10.7889 8.36503 10.8325 8.25396 10.9118 8.16689Z" /></>),
  target: filled(<path fillRule="evenodd" clipRule="evenodd" d="M15 5C15 2.79086 13.2091 1 11 1H5C2.79086 1 1 2.79086 1 5V11C1 13.2091 2.79086 15 5 15H6.25C6.66421 15 7 14.6642 7 14.25C7 13.8358 6.66421 13.5 6.25 13.5H5C3.61929 13.5 2.5 12.3807 2.5 11V6H13.5V6.25C13.5 6.66421 13.8358 7 14.25 7C14.6642 7 15 6.66421 15 6.25V5ZM11.5001 8C11.9143 8 12.2501 8.33579 12.2501 8.75V10.75L14.2501 10.75C14.6643 10.75 15.0001 11.0858 15.0001 11.5C15.0001 11.9142 14.6643 12.25 14.2501 12.25L12.2501 12.25V14.25C12.2501 14.6642 11.9143 15 11.5001 15C11.0859 15 10.7501 14.6642 10.7501 14.25V12.25H8.75C8.33579 12.25 8 11.9142 8 11.5C8 11.0858 8.33579 10.75 8.75 10.75L10.7501 10.75V8.75C10.7501 8.33579 11.0859 8 11.5001 8Z" />),
  parent: glyph(<path d="M4.5 2.5v6a2 2 0 0 0 2 2h6M10 8l2.5 2.5L10 13" />),
  plus: glyph(<path d="M8 3.5v9M3.5 8h9" />),
  triage: glyph(<><path d="M2 9.5h3.25l1 1.75h3.5l1-1.75H14" /><path d="M2 9.5l1.6-5.1c.13-.42.52-.65.95-.65h6.9c.43 0 .82.23.95.65L14 9.5v2.75c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1z" /><path d="M8 4.5v3.25M6.6 6.4 8 7.75 9.4 6.4" /></>),
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
