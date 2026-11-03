// When a message in a chat was sent, as the chat shows it under the message and on the card of what came in (Came.tsx).

export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

// When a message was sent: its time today, with its weekday this past week, and with its day and month before:
// 12:07, Thu 12:07, 28 Oct 12:07.
export function sent(ms: number): string {
  const d = new Date(ms), midnight = new Date().setHours(0, 0, 0, 0);
  if (ms >= midnight) return clock(ms);
  if (ms >= midnight - 6 * 86400_000) return `${d.toLocaleDateString([], { weekday: "short" })} ${clock(ms)}`;
  return `${d.getDate()} ${d.toLocaleDateString([], { month: "short" })} ${clock(ms)}`;
}

// A moment whole, for a tooltip: Sunday, November 1, 2026, 15:55.
export const whole = (ms: number) =>
  `${new Date(ms).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" })}, ${clock(ms)}`;
