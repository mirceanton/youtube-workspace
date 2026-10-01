import { MarkdownView, NotesPanel, PageHeader, Sparkline, TimeSeriesChart } from "@/kit/index.ts";

const IDEA_ID = "0199c2a4-7b1e-7c3a-9d2f-3b8a1c4e5f60";

export function Component() {
  return (
    <>
      <PageHeader title="Heavy" />
      <TimeSeriesChart
        title="Views"
        series={[{ label: "Views", points: [{ x: 1_700_000_000_000, y: 1 }] }]}
      />
      <Sparkline values={[1, 2, 3]} label="Views" />
      <MarkdownView markdown="**hi**" />
      <NotesPanel entityType="idea" entityId={IDEA_ID} />
    </>
  );
}
