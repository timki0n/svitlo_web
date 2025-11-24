import type { Metadata } from "next";

import { SnakeDayTimeline } from "@/app/components/SnakeDayTimeline";
import { buildPlaceholderTimelineData, parseTimelineDataParam } from "@/app/utils/timelineData";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Snake Timeline Screenshot",
  description: "Повноекранний SnakeDayTimeline для генерації скріншотів.",
  robots: {
    index: false,
    follow: false,
  },
};

const CLI_SNIPPET = [
  "python - <<'EOF'",
  "import base64, json",
  'payload = json.dumps({"slots": []}).encode()',
  "print(base64.urlsafe_b64encode(payload).decode())",
  "EOF",
].join("\n");

type TimelineScreenshotPageProps = {
  searchParams?: {
    data?: string;
  };
};

export default function TimelineScreenshotPage({ searchParams }: TimelineScreenshotPageProps) {
  const { data, error } = parseTimelineDataParam(searchParams?.data ?? null);
  const timelineData = data ?? buildPlaceholderTimelineData();

  return (
    <main className="min-h-screen w-full bg-[#030512] px-4 py-6 text-white">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-6">
        {error ? (
          <div className="w-full max-w-2xl rounded-2xl border border-amber-200/40 bg-amber-500/10 px-6 py-4 text-sm text-amber-100 shadow-lg">
            <p className="font-semibold">Не вдалося розпарсити параметр `data`.</p>
            <p className="mt-2 text-amber-50/90">
              Передайте base64/URL-encoded JSON розкладу, згенерований ботом. Приклад CLI:
            </p>
            <pre className="mt-3 overflow-x-auto rounded-xl bg-black/40 px-3 py-2 font-mono text-xs text-white/80">{CLI_SNIPPET}</pre>
            <p className="mt-3 text-amber-50/80">Потім відкрийте /timeline/screenshot?data=&lt;base64&gt;.</p>
          </div>
        ) : null}

        <div data-test="snake-day-timeline-ready" className="w-full">
          <SnakeDayTimeline data={timelineData} />
        </div>
      </div>
    </main>
  );
}

