import { IDEA_PIPELINE, IDEA_STAGE_LABELS } from "@ytw/shared/constants";

export function App() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 px-4 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">YouTube Channel Workspace</h1>
        <p className="text-neutral-600 dark:text-neutral-400">
          Ideas, scripts, packaging experiments and video metrics, shared by you and your agents.
        </p>
      </header>

      <section aria-labelledby="pipeline-heading" className="flex flex-col gap-3">
        <h2 id="pipeline-heading" className="text-lg font-medium">
          Idea pipeline
        </h2>
        <ol className="flex flex-wrap gap-2">
          {IDEA_PIPELINE.map((stage) => (
            <li
              key={stage}
              className="rounded-full border border-neutral-300 px-3 py-1 text-sm dark:border-neutral-700"
            >
              {IDEA_STAGE_LABELS[stage]}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
