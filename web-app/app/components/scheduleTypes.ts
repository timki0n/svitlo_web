type OutageSegment = {
  id: string;
  source: "plan" | "actual";
  startHour: number;
  endHour: number;
  type: string;
  label: string;
  durationHours: number;
};

type DayForChart = {
  key: string;
  title: string;
  plannedHours: number;
  actualHours: number;
  segments: OutageSegment[];
  nowHour?: number | null;
  dateISO: string | null;
  isPlaceholder?: boolean;
  status?: string | null;
};

type WeekForChart = {
  id: string;
  startISO: string;
  endISO: string;
  rangeLabel: string;
  days: DayForChart[];
};

export type { OutageSegment, DayForChart, WeekForChart };

