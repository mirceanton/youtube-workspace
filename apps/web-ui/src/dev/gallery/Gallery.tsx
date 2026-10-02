import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  ConflictDialog,
  EmptyState,
  ErrorState,
  LastChangedBy,
  LoadingState,
  MarkdownView,
  NotesPanel,
  PageHeader,
  SelectField,
  Sparkline,
  TextField,
  TimeSeriesChart,
  WriteGuard,
  useOnlineStatus,
  type ChartSeries,
} from "@/kit/index.ts";
import { ConflictError, NetworkError } from "@/lib/errors.ts";
import { useSession } from "@/lib/session.ts";
import { PERSONAS } from "../mock-api.ts";
import { DEMO_IDEA_ID } from "../demo-data.ts";

const SAMPLE_MARKDOWN = `## Hook options

1. "I tried **every** editor so you don't have to"
2. A cold open with the result, then the setup

> Keep the first 15 seconds free of intros.

| Option | Retention |
| --- | --- |
| 1 | 62% |
| 2 | 71% |

Raw HTML is shown as text: <script>alert(1)</script> and [unsafe](javascript:alert(1)) links are neutralised.
`;

function sampleSeries(): ChartSeries[] {
  const start = new Date("2026-09-01T00:00:00Z").getTime();
  const day = 86_400_000;
  return [
    {
      label: "Views",
      points: Array.from({ length: 30 }, (_, i) => ({
        x: start + i * day,
        y: 900 + Math.round(400 * Math.sin(i / 3)) + i * 25,
      })),
    },
    {
      label: "Impressions / 10",
      points: Array.from({ length: 30 }, (_, i) => ({
        x: start + i * day,
        y: i % 11 === 5 ? null : 1500 + Math.round(300 * Math.cos(i / 4)) + i * 10,
      })),
    },
  ];
}

/** Development-only page that shows every UI kit component with mock data. Not part of production builds. */
export function Gallery() {
  const { user, levels } = useSession();
  const online = useOnlineStatus();
  const [conflictOpen, setConflictOpen] = useState(false);
  const [now] = useState(() => Date.now());
  const series = useMemo(() => sampleSeries(), []);
  const sparkValues = useMemo(() => [4, 6, 5, 9, 12, 11, 15, 14, 19, 22], []);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="UI kit"
        description="Every shared component with mock data. Development only."
        actions={<Badge tone="info">{online ? "Online" : "Offline"}</Badge>}
      />

      <Card>
        <h2 className="mb-2 text-lg font-semibold">Who am I</h2>
        <p>
          {user.username}
          {user.isAdmin ? " (admin)" : ""}. Levels:{" "}
          {Object.entries(levels)
            .map(([resource, level]) => `${resource}=${level}`)
            .join(", ")}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted">
          <span>
            Switch persona with <code>?mock_persona=</code>:
          </span>
          {Object.keys(PERSONAS).map((name) => (
            <a
              key={name}
              className="inline-flex min-h-11 min-w-11 items-center justify-center text-link underline"
              href={`?mock_persona=${name}`}
            >
              {name}
            </a>
          ))}
        </div>
      </Card>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Buttons, fields, alerts</h2>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="primary" busy>
            Saving
          </Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField
            label="Title"
            hint="Shown on the board"
            defaultValue="Why I switched editors"
          />
          <TextField
            label="Score"
            type="number"
            error="Score must be between 0 and 10"
            defaultValue="11"
          />
          <SelectField label="Stage" defaultValue="inbox">
            <option value="inbox">Inbox</option>
            <option value="shortlisted">Shortlisted</option>
          </SelectField>
        </div>
        <Alert tone="info" title="Heads up">
          Polling refreshes this page every 15 seconds.
        </Alert>
        <Alert tone="warn" title="Careful">
          This changes the live channel data.
        </Alert>
        <Alert tone="danger" title="Not saved">
          The server rejected the change.
        </Alert>
        <Alert tone="ok">Saved.</Alert>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">States</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Card>
            <EmptyState
              compact
              title="No ideas yet"
              description="Ideas from you and your agents show up here."
            />
          </Card>
          <Card>
            <LoadingState compact lines={3} label="Loading ideas" />
          </Card>
          <Card>
            <ErrorState compact error={new NetworkError()} onRetry={() => undefined} />
          </Card>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Write guard and last changed by</h2>
        <WriteGuard resource="ideas" className="flex flex-wrap gap-2">
          <Button variant="primary">Save idea</Button>
          <Button>Archive</Button>
        </WriteGuard>
        <LastChangedBy actor="research-agent" actorType="agent" at={new Date(now - 5 * 60_000)} />
        <LastChangedBy actor="owner" actorType="human" at={new Date(now - 3 * 86_400_000)} />
        <div>
          <Button onClick={() => setConflictOpen(true)}>Show conflict dialog</Button>
        </div>
        <ConflictDialog
          open={conflictOpen}
          entity="idea"
          error={new ConflictError("Version 4 is no longer the latest (now 5).", { version: 5 })}
          changedBy={<LastChangedBy actor="research-agent" actorType="agent" at={new Date(now)} />}
          yours={<p>Title: &quot;Why I switched editors&quot;</p>}
          latest={<p>Title: &quot;Why I switched video editors&quot;</p>}
          onKeepEditing={() => setConflictOpen(false)}
          onReload={() => setConflictOpen(false)}
          onMerge={() => setConflictOpen(false)}
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Charts</h2>
        <TimeSeriesChart
          title="Daily views and impressions"
          series={series}
          markers={[{ x: new Date("2026-09-12T00:00:00Z"), label: "Experiment started" }]}
          yMin={0}
        />
        <p className="flex items-center gap-2">
          Trend <Sparkline values={sparkValues} label="Views, last 10 snapshots" />
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Markdown</h2>
        <Card>
          <MarkdownView markdown={SAMPLE_MARKDOWN} />
        </Card>
      </section>

      <Card>
        <NotesPanel entityType="idea" entityId={DEMO_IDEA_ID} />
      </Card>
    </div>
  );
}

export function Component() {
  return <Gallery />;
}
