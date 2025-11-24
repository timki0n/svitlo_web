import React from "react";

type SnakeScheduleProps = {
  segments: {
    startHour: number;
    endHour: number;
    type: string; // "plan", "actual", etc.
  }[];
  nowHour: number | null;
};

const VIEW_WIDTH = 340;
const VIEW_HEIGHT = 180;
const MARGIN_X = 30;
const MARGIN_Y = 30;
const ROW_SPACING = 40; // Center-to-center vertical distance
const ROW_WIDTH = VIEW_WIDTH - 2 * MARGIN_X;
const STROKE_WIDTH = 16;
const CORNER_RADIUS = ROW_SPACING / 2;

export function SnakeSchedule({ segments, nowHour }: SnakeScheduleProps) {
  // Generate the background track (full 0-24)
  const trackPath = getPathForRange(0, 24);

  // Generate paths for each outage segment
  const outagePaths = segments.map((seg, i) => ({
    key: i,
    d: getPathForRange(seg.startHour, seg.endHour),
    type: seg.type,
  }));

  // Generate "Now" indicator
  let nowIndicator = null;
  if (nowHour !== null && nowHour >= 0 && nowHour <= 24) {
    const pos = getPositionForTime(nowHour);
    nowIndicator = (
      <g>
        <circle cx={pos.x} cy={pos.y} r={6} className="fill-red-500 border-2 border-white dark:border-zinc-900" />
        <line
          x1={pos.x}
          y1={pos.y - 10}
          x2={pos.x}
          y2={pos.y + 10}
          stroke="currentColor"
          strokeWidth="2"
          className="text-red-500"
        />
      </g>
    );
  }

  // Generate ticks and labels
  const hours = Array.from({ length: 25 }, (_, i) => i);
  const ticks = hours.map((h) => {
    const pos = getPositionForTime(h);
    const isMain = h % 6 === 0;
    return (
      <g key={h}>
        <line
          x1={pos.x}
          y1={pos.y - (isMain ? 12 : 6)}
          x2={pos.x}
          y2={pos.y + (isMain ? 12 : 6)}
          stroke="currentColor"
          strokeWidth={isMain ? 2 : 1}
          className={isMain ? "text-zinc-400 dark:text-zinc-500" : "text-zinc-300/50 dark:text-zinc-700/50"}
        />
        {isMain && (
          <text
            x={pos.x}
            y={pos.y + (getRowIndex(h) % 2 === 0 ? -20 : 28)}
            textAnchor="middle"
            fontSize="10"
            fontWeight="bold"
            className="fill-zinc-500 dark:fill-zinc-400"
            dominantBaseline="middle"
          >
            {h}:00
          </text>
        )}
      </g>
    );
  });

  return (
    <div className="w-full select-none">
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        className="w-full h-auto overflow-visible"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Background Track */}
        <path
          d={trackPath}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-zinc-100 dark:text-zinc-800"
        />

        {/* Ticks */}
        <g>{ticks}</g>

        {/* Outage Segments */}
        {outagePaths.map((p) => (
          <path
            key={p.key}
            d={p.d}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="butt" // Butt to avoid extending beyond time range
            strokeLinejoin="round"
            className={
              p.type === "Actual"
                ? "text-red-500/80 dark:text-red-500/80" // Actual outage color
                : "text-amber-400 dark:text-amber-500" // Planned outage color
            }
          />
        ))}

        {/* Now Indicator */}
        {nowIndicator}
      </svg>
    </div>
  );
}

// --- Helpers ---

function getPathForRange(start: number, end: number): string {
  if (start >= end) return "";
  
  let path = "";
  let current = start;
  
  // We process in chunks based on row boundaries (6, 12, 18)
  while (current < end) {
    const currentRow = getRowIndex(current);
    const rowEndTime = (currentRow + 1) * 6;
    const segmentEnd = Math.min(end, rowEndTime);
    
    const p1 = getPositionForTime(current);
    const p2 = getPositionForTime(segmentEnd);

    if (path === "") {
      path = `M ${p1.x} ${p1.y}`;
    }

    // Draw line to end of this segment
    path += ` L ${p2.x} ${p2.y}`;

    // If we reached the end of the row AND we need to continue to next row
    if (segmentEnd === rowEndTime && end > segmentEnd && currentRow < 3) {
      // Draw Arc
      const nextRowY = MARGIN_Y + (currentRow + 1) * ROW_SPACING;
      const arcCenterX = currentRow % 2 === 0 ? MARGIN_X + ROW_WIDTH : MARGIN_X;
      const arcSweep = currentRow % 2 === 0 ? 1 : 0; 
      
      path += ` A ${CORNER_RADIUS} ${CORNER_RADIUS} 0 0 ${arcSweep} ${arcCenterX} ${nextRowY}`;
    }

    current = segmentEnd;
    // Safety break for infinite loops (should not happen with correct logic)
    if (current === segmentEnd && segmentEnd < end) {
        // Force move to next row start if stuck at boundary
        current += 0.001; 
    }
  }

  return path;
}

function getRowIndex(t: number) {
  if (t >= 24) return 3;
  return Math.floor(t / 6);
}

function getPositionForTime(t: number) {
  const row = getRowIndex(t);
  const tInRow = t - row * 6; // 0 to 6
  const fraction = tInRow / 6;
  
  const y = MARGIN_Y + row * ROW_SPACING;
  
  let x;
  if (row % 2 === 0) {
    // Left to Right
    x = MARGIN_X + fraction * ROW_WIDTH;
  } else {
    // Right to Left
    x = MARGIN_X + ROW_WIDTH - fraction * ROW_WIDTH;
  }
  
  return { x, y };
}

