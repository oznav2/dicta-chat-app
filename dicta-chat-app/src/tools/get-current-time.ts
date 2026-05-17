// `get_current_time` — returns the current local time formatted as
// "HH:MM AM" / "HH:MM PM". The hour is 24-hour; the AM/PM suffix
// indicates morning (hour < 12) vs. afternoon/evening (hour ≥ 12).
// Used by `mathScenario`; the route's `isPureTimeQuery` short-circuit
// also synthesises this tool's canonical Lang server-side when the user
// asks for the time, so the model never has to.
import type { Tool } from "./types";

function formatTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ampm = d.getHours() >= 12 ? "PM" : "AM";
  return `${hh}:${mm} ${ampm}`;
}

export const getCurrentTime: Tool = {
  spec: {
    name: "get_current_time",
    description:
      'Returns the current local time formatted as "HH:MM AM" or "HH:MM PM" (e.g., "20:04 PM"). ' +
      "The hour is 24-hour; the AM/PM suffix indicates morning (hour < 12) vs. afternoon/evening (hour ≥ 12). " +
      "Display the value verbatim — do not reformat or convert to 12-hour time.",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: {
      type: "object",
      properties: {
        now: {
          type: "string",
          description: 'Time string in the format "HH:MM AM" or "HH:MM PM".',
        },
      },
      required: ["now"],
    },
  },
  impl: async () => ({ now: formatTime(new Date()) }),
};
