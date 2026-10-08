import type { Note } from "@ytw/shared/api/notes";

/** An idea id the dev mock accepts notes for; the kit gallery shows its notes. */
export const DEMO_IDEA_ID = "0199c2a4-7b1e-7c3a-9d2f-3b8a1c4e5f60";

export function seedNotes(now: Date = new Date()): Note[] {
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  return [
    {
      id: "0199c2a4-7b1e-7c3a-9d2f-0000000000a1",
      entity_type: "idea",
      entity_id: DEMO_IDEA_ID,
      author: "research-agent",
      actor_type: "agent",
      body_md:
        "Checked the last 12 uploads: **tutorial** titles with a number get ~18% more clicks.\n\n- Source: [channel report](https://example.com/report)\n- Sample size is small, treat as a hint",
      created_at: at(90),
      updated_at: at(90),
    },
    {
      id: "0199c2a4-7b1e-7c3a-9d2f-0000000000a2",
      entity_type: "idea",
      entity_id: DEMO_IDEA_ID,
      author: "owner",
      actor_type: "human",
      body_md: "Good. Let's shortlist it and write the hook first.",
      created_at: at(12),
      updated_at: at(12),
    },
  ];
}
