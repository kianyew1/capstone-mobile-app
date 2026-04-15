import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type ReviewMeta = {
  object_key: string;
  byte_length: number;
  sample_count: number;
};

type BeatMarkers = {
  P: number[];
  Q: number[];
  R: number[];
  S: number[];
  T: number[];
  P_Onsets: number[];
  P_Offsets: number[];
  R_Onsets: number[];
  R_Offsets: number[];
  T_Onsets: number[];
  T_Offsets: number[];
};

type ReviewBeat = {
  index: number;
  start_sample: number;
  end_sample: number;
  window_index: number;
  window_start_sample: number;
  window_end_sample: number;
  markers: BeatMarkers;
  exclude_from_analysis: boolean;
  exclusion_reasons: string[];
  qr_duration_samples: number | null;
  qr_duration_ms: number | null;
};

type ReviewIntervalRow = {
  interval_index: number;
  start_s: number;
  end_s: number;
  sample_count: number;
  ECG_Rate_Mean: number | null;
};

type ReviewSignal = {
  full: number[];
  r_peaks: number[];
  markers: {
    P: number[];
    Q: number[];
    R: number[];
    S: number[];
    T: number[];
  };
};

type ReviewSectionSummary = {
  beats: {
    count: number;
    items: ReviewBeat[];
  };
  meta: ReviewMeta;
  beat_count_total: number;
  beat_count_included: number;
  beat_count_excluded: number;
  excluded_reason_counts: Record<string, number>;
  window_count: number;
  interval_related: ReviewIntervalRow | null;
  interval_related_rows: ReviewIntervalRow[];
};

type ReviewWindowSection = {
  meta: ReviewMeta;
  signal: ReviewSignal;
  beats: {
    count: number;
    items: ReviewBeat[];
  };
  window_index: number;
  window_count: number;
  window_start_sample: number;
  window_end_sample: number;
  interval_related: ReviewIntervalRow | null;
};

type ReviewSummaryResponse = {
  record_id: string;
  channel: "CH2" | "CH3" | "CH4";
  sample_rate_hz: number;
  calibration: ReviewSectionSummary;
  session: ReviewSectionSummary;
};

type ReviewWindowResponse = {
  record_id: string;
  channel: "CH2" | "CH3" | "CH4";
  sample_rate_hz: number;
  section: "calibration" | "session";
  window: ReviewWindowSection;
};

type ReviewProcessingJob = {
  job_id: string;
  status: string;
  record_id: string;
  details?: {
    resample?: boolean;
  };
  error?: string | null;
};

type ReviewArtifactsNotReadyDetail = {
  code: string;
  record_id: string;
  channel: string;
  processed_status?: string | null;
  artifact_key?: string | null;
  processing_version?: string | null;
};

type VectorBeatResponse = {
  record_id: string;
  section: "calibration" | "session";
  sample_rate_hz: number;
  beat_count: number;
  beat_index: number;
  start_sample: number;
  end_sample: number;
  exclude_from_analysis: boolean;
  exclusion_reasons: string[];
  qr_duration_ms: number | null;
  markers: BeatMarkers;
  max_abs_lead_x: number;
  max_abs_lead_y: number;
  max_abs_lead_z: number;
  lead_x: number[];
  lead_y: number[];
  lead_z: number[];
  max_abs_lead_i: number;
  max_abs_lead_ii: number;
  lead_i: number[];
  lead_ii: number[];
};

type Vector3DBeatResponse = {
  record_id: string;
  section: "calibration" | "session";
  sample_rate_hz: number;
  beat_count: number;
  beat_index: number;
  start_sample: number;
  end_sample: number;
  exclude_from_analysis: boolean;
  exclusion_reasons: string[];
  qr_duration_ms: number | null;
  markers: BeatMarkers;
  image_png_base64: string;
  progress_percent: number;
  y_min_mv: number;
  y_max_mv: number;
};

type LiveVisualResponse = {
  record_id: string;
  session_id: string | null;
  status: "active" | "ended" | "missing";
  updated_at: string;
  ended_at: string | null;
  sample_rate_hz: number;
  buffer_samples: number;
  total_samples_received: number;
  heart_rate_bpm: number | null;
  channels: {
    CH2: number[];
    CH3: number[];
    CH4: number[];
  };
};

type StaticReviewWindow = {
  window_index: number;
  start_sec: number;
  end_sec: number;
  status: "ready" | "error" | string;
  error?: string;
  images: Partial<Record<"ch2" | "ch3" | "ch4" | "frontal" | "transverse" | "sagittal" | "vcg3d", string>>;
};

type StaticReviewManifest = {
  record_id: string;
  status: "running" | "ready" | "error" | string;
  processing_version: string;
  sample_rate_hz: number;
  window_seconds: number;
  total_window_count: number;
  target_window_count: number;
  completed_window_count: number;
  windows: StaticReviewWindow[];
  updated_at?: string;
  error?: string;
};

type StaticReviewJob = {
  job_id: string;
  status: string;
  record_id: string;
  details?: Record<string, unknown>;
  error?: string | null;
};

const CHANNELS = ["CH2", "CH3", "CH4"] as const;
const REVIEW_MODES = ["CH2", "CH3", "CH4", "2D Vectorcardiography", "3D Vectorgraphy"] as const;
const DEFAULT_ECG_Y_MAX_MV = 0.6;
const DEFAULT_ECG_Y_MIN_MV = -0.3;
const LIVE_VISUAL_BUFFER_SAMPLES = 1000;
const BEAT_MARKER_COLORS: Record<keyof BeatMarkers, string> = {
  P: "#1f7aec",
  Q: "#9a3412",
  R: "#b91c1c",
  S: "#0f766e",
  T: "#6d28d9",
  P_Onsets: "#60a5fa",
  P_Offsets: "#60a5fa",
  R_Onsets: "#fb7185",
  R_Offsets: "#fb7185",
  T_Onsets: "#a78bfa",
  T_Offsets: "#a78bfa",
};
function formatMetric(value: number | null, unit = ""): string {
  if (value === null || Number.isNaN(value)) {
    return "n/a";
  }
  return `${value.toFixed(2)}${unit}`;
}

function createPath(
  points: number[],
  width: number,
  height: number,
  minOverride?: number,
  maxOverride?: number,
): { path: string; min: number; max: number } {
  if (points.length === 0) {
    return { path: "", min: 0, max: 0 };
  }
  let min = minOverride ?? points[0];
  let max = maxOverride ?? points[0];
  if (minOverride === undefined || maxOverride === undefined) {
    for (let index = 1; index < points.length; index += 1) {
      const value = points[index];
      if (value < min) {
        min = value;
      }
      if (value > max) {
        max = value;
      }
    }
  }
  const span = max - min || 1;
  const stepX = points.length > 1 ? width / (points.length - 1) : width;

  const path = points
    .map((point, index) => {
      const x = index * stepX;
      const y = height - ((point - min) / span) * height;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  return { path, min, max };
}

function downsampleForPlot(points: number[], targetCount: number): number[] {
  if (targetCount <= 0 || points.length <= targetCount) {
    return points;
  }
  if (targetCount === 1) {
    return [points[0]];
  }
  const lastIndex = points.length - 1;
  return Array.from({ length: targetCount }, (_, index) => {
    const sourceIndex = Math.round((index * lastIndex) / (targetCount - 1));
    return points[sourceIndex];
  });
}

function createTicks(min: number, max: number, count: number): number[] {
  if (count <= 1) {
    return [min];
  }
  if (Math.abs(max - min) < 1e-9) {
    return [min];
  }
  return Array.from({ length: count }, (_, index) => min + ((max - min) * index) / (count - 1));
}

function formatAxisValue(value: number): string {
  const absValue = Math.abs(value);
  if (absValue >= 1000) {
    return value.toFixed(0);
  }
  if (absValue >= 100) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
}

function getFiniteRange(values: number[]): { min: number; max: number } | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) {
    return null;
  }
  let min = finite[0];
  let max = finite[0];
  for (let index = 1; index < finite.length; index += 1) {
    const value = finite[index];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (Math.abs(max - min) < 1e-9) {
    const padding = Math.max(Math.abs(max) * 0.1, 0.05);
    return { min: min - padding, max: max + padding };
  }
  const padding = Math.max((max - min) * 0.08, 0.05);
  return { min: min - padding, max: max + padding };
}

function getCombinedFiniteRange(...seriesList: number[][]): { min: number; max: number } | null {
  const combined: number[] = [];
  seriesList.forEach((series) => {
    combined.push(...series);
  });
  return getFiniteRange(combined);
}

function getSymmetricFiniteRange(...seriesList: number[][]): { min: number; max: number } | null {
  const combined = getCombinedFiniteRange(...seriesList);
  if (!combined) {
    return null;
  }
  const maxAbs = Math.max(Math.abs(combined.min), Math.abs(combined.max), 0.05);
  const padded = maxAbs * 1.1;
  return {
    min: -padded,
    max: padded,
  };
}

function getVectorBeatRange(data: VectorBeatResponse | null): { min: number; max: number } | null {
  if (!data) {
    return null;
  }
  return getSymmetricFiniteRange(data.lead_x, data.lead_y, data.lead_z);
}

function getBeatSamplesForWindow(
  fullSignal: number[],
  beat: ReviewBeat | null,
  windowStartSample: number,
): number[] {
  if (!beat) {
    return [];
  }
  const startIndex = Math.max(0, beat.start_sample - windowStartSample);
  const endIndex = Math.max(0, beat.end_sample - windowStartSample + 1);
  return fullSignal.slice(startIndex, endIndex);
}

function createVectorLoopGeometry(
  leadI: number[],
  leadII: number[],
  width: number,
  height: number,
  axisMin: number,
  axisMax: number,
): { path: string; axisX: number; axisY: number; points: Array<{ x: number; y: number }> } {
  const count = Math.min(leadI.length, leadII.length);
  const span = axisMax - axisMin || 1;
  const clampToDomain = (value: number) => Math.min(axisMax, Math.max(axisMin, value));
  const mapX = (value: number) => ((clampToDomain(value) - axisMin) / span) * width;
  const mapY = (value: number) => height - ((clampToDomain(value) - axisMin) / span) * height;
  if (count === 0) {
    return { path: "", axisX: mapX(0), axisY: mapY(0), points: [] };
  }

  const points = Array.from({ length: count }, (_, index) => ({
    x: mapX(leadI[index]),
    y: mapY(leadII[index]),
  }));
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");

  return {
    path,
    axisX: mapX(0),
    axisY: mapY(0),
    points,
  };
}

function TopNav({ currentPath, extra }: { currentPath: string; extra?: ReactNode }) {
  return (
    <div className="route-nav-row">
      <nav className="route-nav">
        <a href="/" className={currentPath === "/" ? "route-link active" : "route-link"}>
          Review
        </a>
        <a
          href="/session"
          className={currentPath.startsWith("/session") ? "route-link active" : "route-link"}
        >
          Live Session
        </a>
      </nav>
      {extra ? <div className="route-nav-extra">{extra}</div> : null}
    </div>
  );
}

function FullSignalChart({
  title,
  samples,
  sampleRateHz,
  yMin,
  yMax,
  highlightStart,
  highlightEnd,
  subtitle,
}: {
  title: string;
  samples: number[];
  sampleRateHz: number;
  yMin: number;
  yMax: number;
  highlightStart?: number | null;
  highlightEnd?: number | null;
  subtitle?: string;
}) {
  const width = 860;
  const height = 360;
  const margin = { top: 12, right: 18, bottom: 52, left: 64 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const displayedSamples = useMemo(
    () => downsampleForPlot(samples, Math.max(200, Math.floor(plotWidth))),
    [samples, plotWidth],
  );
  const { path, min, max } = useMemo(
    () => createPath(displayedSamples, plotWidth, plotHeight, yMin, yMax),
    [displayedSamples, plotWidth, plotHeight, yMin, yMax],
  );
  const xTickCount = 9;
  const yTicks = createTicks(yMin, yMax, 5);
  const hasHighlight =
    highlightStart !== undefined &&
    highlightStart !== null &&
    highlightEnd !== undefined &&
    highlightEnd !== null &&
    highlightEnd > highlightStart &&
    samples.length > 0;
  const highlightX = hasHighlight ? (highlightStart / Math.max(samples.length - 1, 1)) * plotWidth : 0;
  const highlightWidth = hasHighlight
    ? ((highlightEnd - highlightStart) / Math.max(samples.length - 1, 1)) * plotWidth
    : 0;

  return (
    <div className="chart-card">
      <div className="card-header">
        <div>
          <h3>{title}</h3>
          {subtitle ? <span className="chart-subtitle">{subtitle}</span> : null}
        </div>
        <span>{`${samples.length} samples${displayedSamples.length !== samples.length ? ` | plotted ${displayedSamples.length}` : ""}`}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="signal-chart">
        {Array.from({ length: xTickCount }, (_, index) => {
          const x = margin.left + (plotWidth / (xTickCount - 1)) * index;
          return (
            <g key={`grid-${index}`}>
              <line x1={x} y1={margin.top} x2={x} y2={margin.top + plotHeight} className="grid-line" />
              <text x={x + 4} y={height - 24} className="axis-label">
                {(((samples.length - 1) / sampleRateHz) * index / (xTickCount - 1)).toFixed(1)}s
              </text>
            </g>
          );
        })}
        {yTicks.map((tickValue, index) => {
          const y = margin.top + plotHeight - ((tickValue - min) / Math.max(max - min || 1, 1)) * plotHeight;
          return (
            <g key={`hgrid-${index}`}>
              <line x1={margin.left} y1={y} x2={margin.left + plotWidth} y2={y} className="grid-line" />
              <text x={margin.left - 8} y={y + 4} textAnchor="end" className="axis-label">
                {formatAxisValue(tickValue)}
              </text>
            </g>
          );
        })}
        <text x={margin.left + plotWidth / 2} y={height - 6} textAnchor="middle" className="axis-unit-label">
          Time (s)
        </text>
        <text
          x={18}
          y={margin.top + plotHeight / 2}
          textAnchor="middle"
          transform={`rotate(-90 18 ${margin.top + plotHeight / 2})`}
          className="axis-unit-label"
        >
          mV
        </text>
        {hasHighlight ? (
          <rect
            x={margin.left + highlightX}
            y={margin.top}
            width={Math.max(highlightWidth, 3)}
            height={plotHeight}
            className="highlight-window"
          />
        ) : null}
        <g transform={`translate(${margin.left} ${margin.top})`}>
          <path d={path} className="signal-path" />
        </g>
      </svg>
    </div>
  );
}

function LiveWaveformCanvas({
  title,
  samples,
  sampleRateHz,
}: {
  title: string;
  samples: number[];
  sampleRateHz: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const margin = { top: 18, right: 14, bottom: 36, left: 44 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const range = getFiniteRange(samples) ?? { min: -1, max: 1 };
    const yMin = range.min;
    const yMax = range.max;
    const span = yMax - yMin || 1;
    const zeroY = margin.top + plotHeight - ((0 - yMin) / span) * plotHeight;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#f7fbfd";
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(121, 147, 167, 0.18)";
    ctx.lineWidth = 1;
    const xTicks = 8;
    for (let index = 0; index <= xTicks; index += 1) {
      const x = margin.left + (plotWidth / xTicks) * index;
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, margin.top + plotHeight);
      ctx.stroke();
    }
    const yTicks = createTicks(yMin, yMax, 5);
    for (const tick of yTicks) {
      const y = margin.top + plotHeight - ((tick - yMin) / span) * plotHeight;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + plotWidth, y);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(16, 71, 111, 0.34)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(margin.left, zeroY);
    ctx.lineTo(margin.left + plotWidth, zeroY);
    ctx.stroke();

    ctx.fillStyle = "#6d8395";
    ctx.font = "11px Segoe UI";
    for (let index = 0; index <= xTicks; index += 1) {
      const x = margin.left + (plotWidth / xTicks) * index;
      const seconds = ((samples.length > 1 ? samples.length - 1 : 0) / sampleRateHz) * (index / xTicks);
      ctx.fillText(`${seconds.toFixed(1)}s`, x - 10, height - 10);
    }
    for (const tick of yTicks) {
      const y = margin.top + plotHeight - ((tick - yMin) / span) * plotHeight;
      ctx.fillText(formatAxisValue(tick), 4, y + 4);
    }

    if (!samples.length) {
      ctx.fillStyle = "#6d8395";
      ctx.font = "13px Segoe UI";
      ctx.fillText("Waiting for live data...", margin.left, margin.top + plotHeight / 2);
      return;
    }

    ctx.strokeStyle = "#0d697a";
    ctx.lineWidth = 1.35;
    ctx.beginPath();
    samples.forEach((value, index) => {
      const x = margin.left + (plotWidth * index) / Math.max(samples.length - 1, 1);
      const y = margin.top + plotHeight - ((value - yMin) / span) * plotHeight;
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  }, [samples, sampleRateHz]);

  return (
    <section className="live-quadrant-card">
      <div className="card-header">
        <h3>{title}</h3>
        <span>{samples.length} samples</span>
      </div>
      <canvas ref={canvasRef} width={720} height={180} className="live-canvas live-waveform-canvas" />
    </section>
  );
}

function BeatChart({
  title,
  beat,
  samples,
  beatCount,
  sampleRateHz,
  yMin,
  yMax,
}: {
  title: string;
  beat: ReviewBeat | null;
  samples: number[];
  beatCount: number;
  sampleRateHz: number;
  yMin: number;
  yMax: number;
}) {
  const width = 460;
  const height = 280;
  const margin = { top: 12, right: 18, bottom: 52, left: 64 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const beatCounterText =
    beatCount > 0 ? `Beat ${beat?.index ?? 1} of ${beatCount}` : "No beats";
  const isExcluded = beat?.exclude_from_analysis ?? false;

  if (!beat) {
    return (
      <div className="chart-card beat-card">
        <div className="card-header">
          <h3>{title}</h3>
          <span>{beatCounterText}</span>
        </div>
        <div className="empty-state">No segmented heartbeat available.</div>
      </div>
    );
  }

  const { path, min, max } = createPath(samples, plotWidth, plotHeight, yMin, yMax);
  const span = max - min || 1;
  const pointToY = (value: number) => margin.top + plotHeight - ((value - min) / span) * plotHeight;
  const pointToX = (index: number) =>
    margin.left + (samples.length > 1 ? (index / (samples.length - 1)) * plotWidth : 0);
  const yTicks = createTicks(yMin, yMax, 5);
  const xTickCount = 5;

  return (
    <div className="chart-card beat-card">
      <div className="card-header">
        <h3>{title}</h3>
        <div className="beat-header-meta">
          <span>{beatCounterText}</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="beat-chart">
        {Array.from({ length: xTickCount }, (_, index) => {
          const x = margin.left + (plotWidth / (xTickCount - 1)) * index;
          return (
            <g key={`beat-xgrid-${index}`}>
              <line x1={x} y1={margin.top} x2={x} y2={margin.top + plotHeight} className="grid-line" />
              <text x={x + 4} y={height - 24} className="axis-label">
                {((((samples.length - 1) / sampleRateHz) * 1000 * index) / (xTickCount - 1)).toFixed(0)}ms
              </text>
            </g>
          );
        })}
        {yTicks.map((tickValue, index) => {
          const y = margin.top + plotHeight - ((tickValue - min) / span) * plotHeight;
          return (
            <g key={`beat-grid-${index}`}>
              <line x1={margin.left} y1={y} x2={margin.left + plotWidth} y2={y} className="grid-line" />
              <text x={margin.left - 8} y={y + 4} textAnchor="end" className="axis-label">
                {formatAxisValue(tickValue)}
              </text>
            </g>
          );
        })}
        <text x={margin.left + plotWidth / 2} y={height - 6} textAnchor="middle" className="axis-unit-label">
          Time (ms)
        </text>
        <text
          x={18}
          y={margin.top + plotHeight / 2}
          textAnchor="middle"
          transform={`rotate(-90 18 ${margin.top + plotHeight / 2})`}
          className="axis-unit-label"
        >
          mV
        </text>
        {isExcluded ? (
          <g>
            <rect x={margin.left} y={margin.top} width={plotWidth} height={plotHeight} className="excluded-overlay" />
            <text x={width / 2} y={height / 2 - 10} textAnchor="middle" className="excluded-overlay-text">
              Excluded from analysis
            </text>
            {beat.qr_duration_ms !== null ? (
              <text x={width / 2} y={height / 2 + 14} textAnchor="middle" className="excluded-overlay-subtext">
                {`Q-R ${beat.qr_duration_ms.toFixed(1)} ms`}
              </text>
            ) : null}
          </g>
        ) : null}
        <g transform={`translate(${margin.left} ${margin.top})`}>
          <path d={path} className="signal-path beat-path" />
        </g>
        {(Object.entries(beat.markers) as Array<[keyof BeatMarkers, number[]]>).map(([label, positions]) =>
          positions.map((position, idx) => {
            const x = pointToX(position);
            const y = pointToY(samples[position] ?? 0);
            return (
              <g key={`${label}-${idx}-${position}`}>
                <line
                  x1={x}
                  y1={margin.top}
                  x2={x}
                  y2={margin.top + plotHeight}
                  className="marker-line"
                  style={{ stroke: BEAT_MARKER_COLORS[label] }}
                />
                <text x={x + 6} y={y - 6} className="marker-label">
                  {label}
                </text>
              </g>
            );
          }),
        )}
      </svg>
      <div className="marker-legend">
        {(["P", "Q", "R", "S", "T"] as Array<keyof BeatMarkers>).map((label) => (
          <span key={label} className="legend-pill">
            <span className="legend-dot" style={{ backgroundColor: BEAT_MARKER_COLORS[label] }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

function IntervalSummary({ row }: { row: ReviewIntervalRow | null }) {
  if (!row) {
    return <div className="empty-state">No interval-related data available.</div>;
  }

  return (
    <div className="interval-summary">
      <div className="summary-metric">
        <span>ECG_Rate_Mean</span>
        <strong>{formatMetric(row.ECG_Rate_Mean, " bpm")}</strong>
      </div>
    </div>
  );
}

function VectorPlaneChart({
  title,
  subtitle,
  xAxisLabel,
  yAxisLabel,
  xSamples,
  ySamples,
  markers,
  progressPercent,
  yMin,
  yMax,
  excluded,
  qrDurationMs,
}: {
  title: string;
  subtitle: string;
  xAxisLabel: string;
  yAxisLabel: string;
  xSamples: number[];
  ySamples: number[];
  markers: BeatMarkers;
  progressPercent: number;
  yMin: number;
  yMax: number;
  excluded: boolean;
  qrDurationMs: number | null;
}) {
  const width = 970;
  const height = 420;
  const margin = { top: 20, right: 28, bottom: 72, left: 72 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const axisMin = yMin;
  const axisMax = yMax;
  const { path, axisX, axisY, points } = useMemo(
    () => createVectorLoopGeometry(xSamples, ySamples, plotWidth, plotHeight, axisMin, axisMax),
    [xSamples, ySamples, plotWidth, plotHeight, axisMin, axisMax],
  );
  const axisSpan = axisMax - axisMin || 1;
  const axisTicks = createTicks(axisMin, axisMax, 5);
  const visiblePointCount = Math.max(
    1,
    Math.min(points.length, Math.floor((points.length * Math.min(Math.max(progressPercent, 0), 100)) / 100)),
  );
  const visiblePath = points
    .slice(0, visiblePointCount)
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");

  return (
    <div className="chart-card vector-plane-card">
      <div className="card-header">
        <div>
          <h3>{title}</h3>
          <span className="chart-subtitle">{subtitle}</span>
        </div>
        <span>{Math.min(xSamples.length, ySamples.length)} samples</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="vector-plane-chart">
        {axisTicks.map((tickValue, index) => {
          const x = margin.left + ((tickValue - axisMin) / axisSpan) * plotWidth;
          return (
            <g key={`vector-x-${index}`}>
              <line x1={x} y1={margin.top} x2={x} y2={margin.top + plotHeight} className="grid-line" />
              <text x={x} y={height - 30} textAnchor="middle" className="axis-label">
                {formatAxisValue(tickValue)}
              </text>
            </g>
          );
        })}
        {axisTicks.map((tickValue, index) => {
          const y = margin.top + plotHeight - ((tickValue - axisMin) / axisSpan) * plotHeight;
          return (
            <g key={`vector-y-${index}`}>
              <line x1={margin.left} y1={y} x2={margin.left + plotWidth} y2={y} className="grid-line" />
              <text x={margin.left - 10} y={y + 4} textAnchor="end" className="axis-label">
                {formatAxisValue(tickValue)}
              </text>
            </g>
          );
        })}
        <text x={margin.left + plotWidth / 2} y={height - 8} textAnchor="middle" className="axis-unit-label">
          {xAxisLabel}
        </text>
        <text
          x={20}
          y={margin.top + plotHeight / 2}
          textAnchor="middle"
          transform={`rotate(-90 20 ${margin.top + plotHeight / 2})`}
          className="axis-unit-label"
        >
          {yAxisLabel}
        </text>
        <g transform={`translate(${margin.left} ${margin.top})`}>
          <line x1={axisX} y1={0} x2={axisX} y2={plotHeight} className="grid-line" />
          <line x1={0} y1={axisY} x2={plotWidth} y2={axisY} className="grid-line" />
          <path d={visiblePath || path} className="signal-path vector-path" />
        </g>
        {(Object.entries(markers) as Array<[keyof BeatMarkers, number[]]>).map(([label, positions]) =>
          (["P", "Q", "R", "S", "T"] as Array<keyof BeatMarkers>).includes(label)
            ? positions.map((position, idx) => {
                if (position >= visiblePointCount) return null;
                const point = points[position];
                if (!point) return null;
                return (
                  <g key={`${label}-${idx}-${position}`}>
                    <circle cx={margin.left + point.x} cy={margin.top + point.y} r={8} fill={BEAT_MARKER_COLORS[label]} className="vector-marker-dot" />
                    <text x={margin.left + point.x + 8} y={margin.top + point.y - 8} className="marker-label">
                      {label}
                    </text>
                  </g>
                );
              })
            : null,
        )}
        {excluded ? (
          <g>
            <rect x={margin.left} y={margin.top} width={plotWidth} height={plotHeight} className="excluded-overlay" />
            <text x={width / 2} y={height / 2 - 10} textAnchor="middle" className="excluded-overlay-text">
              Excluded from analysis
            </text>
            {qrDurationMs !== null ? (
              <text x={width / 2} y={height / 2 + 14} textAnchor="middle" className="excluded-overlay-subtext">
                {`Q-R ${qrDurationMs.toFixed(1)} ms`}
              </text>
            ) : null}
          </g>
        ) : null}
      </svg>
    </div>
  );
}

function VectorPlaneStack({
  data,
  progressPercent,
  yMin,
  yMax,
}: {
  data: VectorBeatResponse | null;
  progressPercent: number;
  yMin: number;
  yMax: number;
}) {
  if (!data) {
    return <div className="empty-state">No vector beat available.</div>;
  }

  return (
    <div className="vector-plane-stack">
      <VectorPlaneChart
        title="Frontal Plane (X-Z)"
        subtitle="X = CH2 | Z = CH3"
        xAxisLabel="X / CH2 (mV)"
        yAxisLabel="Z / CH3 (mV)"
        xSamples={data.lead_x}
        ySamples={data.lead_z}
        markers={data.markers}
        progressPercent={progressPercent}
        yMin={yMin}
        yMax={yMax}
        excluded={data.exclude_from_analysis}
        qrDurationMs={data.qr_duration_ms}
      />
      <VectorPlaneChart
        title="Transverse Plane (X-Y)"
        subtitle="X = CH2 | Y = CH4"
        xAxisLabel="X / CH2 (mV)"
        yAxisLabel="Y / CH4 (mV)"
        xSamples={data.lead_x}
        ySamples={data.lead_y}
        markers={data.markers}
        progressPercent={progressPercent}
        yMin={yMin}
        yMax={yMax}
        excluded={data.exclude_from_analysis}
        qrDurationMs={data.qr_duration_ms}
      />
      <VectorPlaneChart
        title="Sagittal Plane (Y-Z)"
        subtitle="Y = CH4 | Z = CH3"
        xAxisLabel="Y / CH4 (mV)"
        yAxisLabel="Z / CH3 (mV)"
        xSamples={data.lead_y}
        ySamples={data.lead_z}
        markers={data.markers}
        progressPercent={progressPercent}
        yMin={yMin}
        yMax={yMax}
        excluded={data.exclude_from_analysis}
        qrDurationMs={data.qr_duration_ms}
      />
    </div>
  );
}

function Vector3DChart({
  title,
  data,
}: {
  title: string;
  data: Vector3DBeatResponse | null;
}) {
  if (!data) {
    return (
      <div className="chart-card vector-card">
        <div className="card-header">
          <h3>{title}</h3>
        </div>
        <div className="empty-state">No 3D vector beat available.</div>
      </div>
    );
  }

  return (
    <div className="chart-card vector-card">
      <div className="card-header">
        <div>
          <h3>{title}</h3>
          <span className="chart-subtitle">X = CH2 | Y = CH4 | Z = CH3</span>
        </div>
        <span>{`Progress ${data.progress_percent}%`}</span>
      </div>
      <div className="vector3d-frame">
        <img
          className="vector3d-image"
          src={`data:image/png;base64,${data.image_png_base64}`}
          alt={`${title} 3D vectorgraphy`}
        />
        {data.exclude_from_analysis ? (
          <div className="vector3d-overlay">
            <span className="vector3d-overlay-title">Excluded from analysis</span>
            {data.qr_duration_ms !== null ? (
              <span className="vector3d-overlay-subtitle">{`Q-R ${data.qr_duration_ms.toFixed(1)} ms`}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function VectorReviewSection({
  title,
  beatIndex,
  beatCount,
  data,
  loading,
  movementPercent,
  yMin,
  yMax,
  onBeatIndexChange,
  onMovementPercentChange,
}: {
  title: string;
  beatIndex: number;
  beatCount: number;
  data: VectorBeatResponse | null;
  loading: boolean;
  movementPercent: number;
  yMin: number;
  yMax: number;
  onBeatIndexChange: (value: number) => void;
  onMovementPercentChange: (value: number) => void;
}) {
  return (
    <section className="review-section">
      <div className="section-header">
        <div>
          <h2>{title}</h2>
          <p className="meta-line">Three 2D vector planes derived from the shared X/Y/Z beat axes.</p>
        </div>
      </div>
      <div className="vector-section-grid">
        <div className="signal-column">
          <VectorPlaneStack data={data} progressPercent={movementPercent} yMin={yMin} yMax={yMax} />
          <div className="chart-card vector-controls-row-card">
            <div className="vector-controls-header">
              <strong>{`${title} Beat Selector`}</strong>
              <span>{`Beat ${Math.min(Math.max(beatIndex, 1), Math.max(beatCount, 1))} of ${Math.max(beatCount, 1)}`}</span>
            </div>
            <div className="window-controls compact-controls compact-controls-centered">
                <button
                  className="window-button"
                  disabled={beatCount <= 0 || beatIndex <= 1}
                  onClick={() => onBeatIndexChange(Math.max(1, beatIndex - 1))}
                >
                  Prev Beat
                </button>
                <label className="beat-input window-input">
                  <input
                    type="number"
                    min={1}
                    max={Math.max(beatCount, 1)}
                    value={Math.min(Math.max(beatIndex, 1), Math.max(beatCount, 1))}
                    onChange={(event) =>
                      onBeatIndexChange(
                        Math.min(Math.max(Number(event.target.value) || 1, 1), Math.max(beatCount, 1)),
                      )
                    }
                  />
                </label>
                <button
                  className="window-button"
                  disabled={beatCount <= 0 || beatIndex >= beatCount}
                  onClick={() => onBeatIndexChange(Math.min(beatCount, beatIndex + 1))}
                >
                  Next Beat
                </button>
            </div>
            <div className="vector-slider-row">
              <label className="vector-slider-label" htmlFor={`${title}-movement`}>
                Vector movement
              </label>
              <input
                id={`${title}-movement`}
                className="vector-slider"
                type="range"
                min={1}
                max={100}
                step={1}
                value={movementPercent}
                onChange={(event) => onMovementPercentChange(Number(event.target.value) || 1)}
              />
              <span className="vector-slider-value">{movementPercent}%</span>
            </div>
            {loading ? <div className="section-loading">Loading vector beat...</div> : null}
            {data?.exclude_from_analysis ? (
              <div className="status-panel">Excluded from analysis: {data.exclusion_reasons.join(", ")}</div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function Vector3DReviewSection({
  title,
  beatIndex,
  beatCount,
  data,
  loading,
  movementPercent,
  onBeatIndexChange,
  onMovementPercentChange,
}: {
  title: string;
  beatIndex: number;
  beatCount: number;
  data: Vector3DBeatResponse | null;
  loading: boolean;
  movementPercent: number;
  onBeatIndexChange: (value: number) => void;
  onMovementPercentChange: (value: number) => void;
}) {
  const [draftMovementPercent, setDraftMovementPercent] = useState(movementPercent);

  useEffect(() => {
    setDraftMovementPercent(movementPercent);
  }, [movementPercent]);

  function commitMovementPercent(nextValue: number) {
    const boundedValue = Math.min(Math.max(nextValue, 1), 100);
    setDraftMovementPercent(boundedValue);
    if (boundedValue !== movementPercent) {
      onMovementPercentChange(boundedValue);
    }
  }

  return (
    <section className="review-section">
      <div className="section-header">
        <div>
          <h2>{title}</h2>
          <p className="meta-line">3D beat morphology rendered with Matplotlib using CH2 as X, CH4 as Y, and CH3 as Z.</p>
        </div>
      </div>
      <div className="vector-section-grid">
        <div className="signal-column">
          <Vector3DChart title={`${title} Morphology`} data={data} />
          <div className="chart-card vector-controls-row-card">
            <div className="vector-controls-header">
              <strong>{`${title} Beat Selector`}</strong>
              <span>{`Beat ${Math.min(Math.max(beatIndex, 1), Math.max(beatCount, 1))} of ${Math.max(beatCount, 1)}`}</span>
            </div>
            <div className="window-controls compact-controls compact-controls-centered">
              <button
                className="window-button"
                disabled={beatCount <= 0 || beatIndex <= 1}
                onClick={() => onBeatIndexChange(Math.max(1, beatIndex - 1))}
              >
                Prev Beat
              </button>
              <label className="beat-input window-input">
                <input
                  type="number"
                  min={1}
                  max={Math.max(beatCount, 1)}
                  value={Math.min(Math.max(beatIndex, 1), Math.max(beatCount, 1))}
                  onChange={(event) =>
                    onBeatIndexChange(
                      Math.min(Math.max(Number(event.target.value) || 1, 1), Math.max(beatCount, 1)),
                    )
                  }
                />
              </label>
              <button
                className="window-button"
                disabled={beatCount <= 0 || beatIndex >= beatCount}
                onClick={() => onBeatIndexChange(Math.min(beatCount, beatIndex + 1))}
              >
                Next Beat
              </button>
            </div>
            <div className="vector-slider-row">
              <label className="vector-slider-label" htmlFor={`${title}-3d-movement`}>
                Vector movement
              </label>
              <input
                id={`${title}-3d-movement`}
                className="vector-slider"
                type="range"
                min={1}
                max={100}
                step={1}
                value={draftMovementPercent}
                onChange={(event) => setDraftMovementPercent(Number(event.target.value) || 1)}
                onMouseUp={(event) => commitMovementPercent(Number((event.target as HTMLInputElement).value) || 1)}
                onTouchEnd={(event) => commitMovementPercent(Number((event.target as HTMLInputElement).value) || 1)}
                onKeyUp={(event) => commitMovementPercent(Number((event.target as HTMLInputElement).value) || 1)}
                onBlur={(event) => commitMovementPercent(Number((event.target as HTMLInputElement).value) || 1)}
              />
              <span className="vector-slider-value">{draftMovementPercent}%</span>
            </div>
            {loading ? <div className="section-loading">Loading 3D vector beat...</div> : null}
            {data?.exclude_from_analysis ? (
              <div className="status-panel">Excluded from analysis: {data.exclusion_reasons.join(", ")}</div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function ReviewSectionCard({
  title,
  summary,
  window,
  sampleRateHz,
  beatIndex,
  yMin,
  yMax,
  onBeatIndexChange,
}: {
  title: string;
  summary: ReviewSectionSummary;
  window: ReviewWindowSection | null;
  sampleRateHz: number;
  beatIndex: number;
  yMin: number;
  yMax: number;
  onBeatIndexChange: (value: number) => void;
}) {
  const beat = window?.beats.items.find((item) => item.index === beatIndex) ?? window?.beats.items[0] ?? null;
  const windowSamples = window?.signal.full ?? [];
  const displayWindowStart = window?.window_start_sample ?? 1;
  const displayWindowEnd = window?.window_end_sample ?? Math.min(summary.meta.sample_count, sampleRateHz * 10);
  const beatSamples = useMemo(
    () => getBeatSamplesForWindow(windowSamples, beat, displayWindowStart),
    [windowSamples, beat, displayWindowStart],
  );
  const highlightStart =
    beat && beat.start_sample >= displayWindowStart ? beat.start_sample - displayWindowStart : null;
  const highlightEnd =
    beat && beat.end_sample >= displayWindowStart ? beat.end_sample - displayWindowStart : null;

  return (
    <section className="review-section">
      <div className="section-header">
        <div>
          <h2>{title}</h2>
          <p className="meta-line">
            object_key={summary.meta.object_key} | byte_length={summary.meta.byte_length} | sample_count={summary.meta.sample_count}
            {` | included_beats=${summary.beat_count_included}/${summary.beat_count_total}`}
          </p>
        </div>
      </div>
      <div className="section-grid">
        <div className="signal-column">
          <FullSignalChart
            title={`${title} 10s Window`}
            samples={windowSamples}
            sampleRateHz={sampleRateHz}
            yMin={yMin}
            yMax={yMax}
            highlightStart={highlightStart}
            highlightEnd={highlightEnd}
            subtitle={`Samples ${displayWindowStart}-${displayWindowEnd} | Window ${window?.window_index ?? 1} of ${summary.window_count}`}
          />
        </div>
        <div className="beat-column">
          <BeatChart
            title={`${title} Heartbeat`}
            beat={beat}
            samples={beatSamples}
            beatCount={summary.beats.count}
            sampleRateHz={sampleRateHz}
            yMin={yMin}
            yMax={yMax}
          />
          <div className="window-controls beat-controls">
            <button
              className="window-button"
              disabled={!beat || beat.index <= 1}
              onClick={() => onBeatIndexChange(Math.max(1, (beat?.index ?? 1) - 1))}
            >
              Prev Beat
            </button>
            <label className="beat-input window-input">
              <input
                type="number"
                min={1}
                max={Math.max(summary.beats.count, 1)}
                value={beat?.index ?? beatIndex}
                onChange={(event) =>
                  onBeatIndexChange(
                    Math.min(
                      Math.max(Number(event.target.value) || 1, 1),
                      Math.max(summary.beats.count, 1),
                    ),
                  )
                }
              />
            </label>
            <button
              className="window-button"
              disabled={!beat || beat.index >= summary.beats.count}
              onClick={() =>
                onBeatIndexChange(
                  Math.min(summary.beats.count, (beat?.index ?? summary.beats.count) + 1),
                )
              }
            >
              Next Beat
            </button>
          </div>
        </div>
      </div>

      <div className="interval-card">
        <div className="card-header">
          <h3>Interval-Related Analysis</h3>
        </div>
        <IntervalSummary row={window?.interval_related ?? summary.interval_related} />
      </div>
    </section>
  );
}

function SessionReviewCard({
  summary,
  window,
  sampleRateHz,
  beatIndex,
  yMin,
  yMax,
  onBeatIndexChange,
}: {
  summary: ReviewSectionSummary;
  window: ReviewWindowSection | null;
  sampleRateHz: number;
  beatIndex: number;
  yMin: number;
  yMax: number;
  onBeatIndexChange: (value: number) => void;
}) {
  const beat = window?.beats.items.find((item) => item.index === beatIndex) ?? window?.beats.items[0] ?? null;
  const windowSamples = window?.signal.full ?? [];
  const displayWindowStart = window?.window_start_sample ?? 1;
  const displayWindowEnd = window?.window_end_sample ?? Math.min(summary.meta.sample_count, sampleRateHz * 10);
  const beatSamples = useMemo(
    () => getBeatSamplesForWindow(windowSamples, beat, displayWindowStart),
    [windowSamples, beat, displayWindowStart],
  );
  const highlightStart =
    beat && beat.start_sample >= displayWindowStart ? beat.start_sample - displayWindowStart : null;
  const highlightEnd =
    beat && beat.end_sample >= displayWindowStart ? beat.end_sample - displayWindowStart : null;
  const selectedWindowIndex = window?.window_index ?? beat?.window_index ?? 1;
  const selectedIntervalRow = window?.interval_related ?? null;

  return (
    <section className="review-section">
      <div className="section-header">
        <div>
          <h2>Session Signal</h2>
          <p className="meta-line">
            object_key={summary.meta.object_key} | byte_length={summary.meta.byte_length} | sample_count={summary.meta.sample_count}
            {` | included_beats=${summary.beat_count_included}/${summary.beat_count_total}`}
          </p>
        </div>
      </div>
      <div className="section-grid">
        <div className="signal-column">
          <FullSignalChart
            title="Session 10s Window"
            samples={windowSamples}
            sampleRateHz={sampleRateHz}
            yMin={yMin}
            yMax={yMax}
            highlightStart={highlightStart}
            highlightEnd={highlightEnd}
            subtitle={`Samples ${displayWindowStart}-${displayWindowEnd} | Window ${selectedWindowIndex} of ${summary.window_count}`}
          />
        </div>
        <div className="beat-column">
          <BeatChart
            title="Session Heartbeat"
            beat={beat}
            samples={beatSamples}
            beatCount={summary.beats.count}
            sampleRateHz={sampleRateHz}
            yMin={yMin}
            yMax={yMax}
          />
          <div className="window-controls">
            <button
              className="window-button"
              disabled={!beat || beat.index <= 1}
              onClick={() => onBeatIndexChange(Math.max(1, (beat?.index ?? 1) - 1))}
            >
              Prev Beat
            </button>
            <label className="beat-input window-input">
              <input
                type="number"
                min={1}
                max={Math.max(summary.beats.count, 1)}
                value={beat?.index ?? beatIndex}
                onChange={(event) =>
                  onBeatIndexChange(
                    Math.min(
                      Math.max(Number(event.target.value) || 1, 1),
                      Math.max(summary.beats.count, 1),
                    ),
                  )
                }
              />
            </label>
            <button
              className="window-button"
              disabled={!beat || beat.index >= summary.beats.count}
              onClick={() =>
                onBeatIndexChange(
                  Math.min(summary.beats.count, (beat?.index ?? summary.beats.count) + 1),
                )
              }
            >
              Next Beat
            </button>
          </div>
        </div>
      </div>

      <div className="interval-card">
        <div className="card-header">
          <h3>Interval-Related Analysis</h3>
          <span>{`Window ${selectedWindowIndex} of ${summary.window_count}`}</span>
        </div>
        <IntervalSummary row={selectedIntervalRow} />
      </div>
    </section>
  );
}

function ReviewPage({ currentPath }: { currentPath: string }) {
  const searchParams = new URLSearchParams(window.location.search);
  const initialRequestedRecordId = searchParams.get("recordId") ?? "";
  const [reviewMode, setReviewMode] = useState<(typeof REVIEW_MODES)[number]>("CH2");
  const [requestedRecordIdInput, setRequestedRecordIdInput] = useState(initialRequestedRecordId);
  const [requestedRecordId, setRequestedRecordId] = useState(initialRequestedRecordId);
  const [yMaxMv, setYMaxMv] = useState(DEFAULT_ECG_Y_MAX_MV);
  const [yMinMv, setYMinMv] = useState(DEFAULT_ECG_Y_MIN_MV);
  const [data, setData] = useState<ReviewSummaryResponse | null>(null);
  const [calibrationWindow, setCalibrationWindow] = useState<ReviewWindowSection | null>(null);
  const [sessionWindow, setSessionWindow] = useState<ReviewWindowSection | null>(null);
  const [reviewRecordId, setReviewRecordId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [artifactsNotReady, setArtifactsNotReady] = useState<ReviewArtifactsNotReadyDetail | null>(null);
  const [processResample, setProcessResample] = useState(true);
  const [processingJob, setProcessingJob] = useState<ReviewProcessingJob | null>(null);
  const [processActionPending, setProcessActionPending] = useState(false);
  const [calibrationBeat, setCalibrationBeat] = useState(1);
  const [sessionBeat, setSessionBeat] = useState(1);
  const [calibrationVector, setCalibrationVector] = useState<VectorBeatResponse | null>(null);
  const [sessionVector, setSessionVector] = useState<VectorBeatResponse | null>(null);
  const [calibrationVector3d, setCalibrationVector3d] = useState<Vector3DBeatResponse | null>(null);
  const [sessionVector3d, setSessionVector3d] = useState<Vector3DBeatResponse | null>(null);
  const [loadingCalibrationVector, setLoadingCalibrationVector] = useState(false);
  const [loadingSessionVector, setLoadingSessionVector] = useState(false);
  const [loadingCalibrationVector3d, setLoadingCalibrationVector3d] = useState(false);
  const [loadingSessionVector3d, setLoadingSessionVector3d] = useState(false);
  const [calibrationVectorMovement, setCalibrationVectorMovement] = useState(100);
  const [sessionVectorMovement, setSessionVectorMovement] = useState(100);

  const selectedChannel: (typeof CHANNELS)[number] =
    reviewMode === "2D Vectorcardiography" || reviewMode === "3D Vectorgraphy" ? "CH2" : reviewMode;
  const showVectorMode = reviewMode === "2D Vectorcardiography";
  const showVector3DMode = reviewMode === "3D Vectorgraphy";
  const showWideVectorMode = showVectorMode || showVector3DMode;
  const shouldLoadVectorBeats = showVectorMode || showVector3DMode;
  const calibrationVectorRange = getVectorBeatRange(calibrationVector) ?? { min: yMinMv, max: yMaxMv };
  const sessionVectorRange = getVectorBeatRange(sessionVector) ?? { min: yMinMv, max: yMaxMv };
  const [reviewRefreshToken, setReviewRefreshToken] = useState(0);
  const canProcessReview = Boolean(reviewRecordId);
  const calibrationWindowIndex =
    data?.calibration.beats.items.find((item) => item.index === calibrationBeat)?.window_index ?? 1;
  const sessionWindowIndex =
    data?.session.beats.items.find((item) => item.index === sessionBeat)?.window_index ?? 1;

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError(null);
      setArtifactsNotReady(null);
      const url = requestedRecordId
        ? `/api/review/${requestedRecordId}?channel=${selectedChannel}`
        : `/api/review/latest?channel=${selectedChannel}`;
      console.log(`[REVIEW] GET ${url}`);
      try {
        const response = await fetch(url);
        if (!response.ok) {
          let detail: unknown = null;
          let text = "";
          try {
            const payload = await response.json();
            detail = payload?.detail ?? null;
            text = JSON.stringify(payload);
          } catch {
            text = await response.text();
          }
          if (
            response.status === 409 &&
            detail &&
            typeof detail === "object" &&
            "code" in detail &&
            ((detail as { code?: string }).code === "review_artifacts_not_ready" ||
              (detail as { code?: string }).code === "review_artifact_fetch_unavailable")
          ) {
            const notReady = detail as ReviewArtifactsNotReadyDetail;
            console.log(
              `[REVIEW] artifacts not ready recordId=${notReady.record_id} channel=${notReady.channel} status=${notReady.processed_status ?? "none"}`,
            );
            if (!active) return;
            setArtifactsNotReady(notReady);
            setReviewRecordId(notReady.record_id);
            setData(null);
            setCalibrationWindow(null);
            setSessionWindow(null);
            return;
          }
          throw new Error(`Review fetch failed: ${response.status} ${text}`);
        }
        const payload = (await response.json()) as ReviewSummaryResponse;
        console.log(
          `[REVIEW] response recordId=${payload.record_id} channel=${payload.channel} calibrationBeats=${payload.calibration.beats.count} sessionBeats=${payload.session.beats.count} sessionWindows=${payload.session.window_count}`,
        );
        if (!active) return;
        setData(payload);
        setCalibrationWindow(null);
        setSessionWindow(null);
        setReviewRecordId(payload.record_id);
        setArtifactsNotReady(null);
        setCalibrationBeat(payload.calibration.beats.items[0]?.index ?? 1);
        setSessionBeat(payload.session.beats.items[0]?.index ?? 1);
        setCalibrationVectorMovement(100);
        setSessionVectorMovement(100);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Unknown review error");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [selectedChannel, requestedRecordId, reviewRefreshToken]);

  useEffect(() => {
    if (!data) {
      setCalibrationWindow(null);
      return;
    }
    const summary = data;
    let active = true;
    async function loadCalibrationWindow() {
      const url = `/api/review/${summary.record_id}/window?section=calibration&channel=${selectedChannel}&window_index=${calibrationWindowIndex}`;
      console.log(`[REVIEW_WINDOW] GET ${url}`);
      try {
        const response = await fetch(url);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Calibration window fetch failed: ${response.status} ${text}`);
        }
        const payload = (await response.json()) as ReviewWindowResponse;
        if (!active) return;
        console.log(
          `[REVIEW_WINDOW] calibration recordId=${payload.record_id} window=${payload.window.window_index}/${payload.window.window_count} samples=${payload.window.signal.full.length} beats=${payload.window.beats.count}`,
        );
        setCalibrationWindow(payload.window);
      } catch (err) {
        if (!active) return;
        console.error("[REVIEW_WINDOW] calibration error", err);
        setCalibrationWindow(null);
        setError(err instanceof Error ? err.message : "Unknown calibration window error");
      }
    }
    void loadCalibrationWindow();
    return () => {
      active = false;
    };
  }, [data, selectedChannel, calibrationWindowIndex]);

  useEffect(() => {
    if (!data) {
      setSessionWindow(null);
      return;
    }
    const summary = data;
    let active = true;
    async function loadSessionWindow() {
      const url = `/api/review/${summary.record_id}/window?section=session&channel=${selectedChannel}&window_index=${sessionWindowIndex}`;
      console.log(`[REVIEW_WINDOW] GET ${url}`);
      try {
        const response = await fetch(url);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Session window fetch failed: ${response.status} ${text}`);
        }
        const payload = (await response.json()) as ReviewWindowResponse;
        if (!active) return;
        console.log(
          `[REVIEW_WINDOW] session recordId=${payload.record_id} window=${payload.window.window_index}/${payload.window.window_count} samples=${payload.window.signal.full.length} beats=${payload.window.beats.count}`,
        );
        setSessionWindow(payload.window);
      } catch (err) {
        if (!active) return;
        console.error("[REVIEW_WINDOW] session error", err);
        setSessionWindow(null);
        setError(err instanceof Error ? err.message : "Unknown session window error");
      }
    }
    void loadSessionWindow();
    return () => {
      active = false;
    };
  }, [data, selectedChannel, sessionWindowIndex]);

  useEffect(() => {
    if (!processingJob || !["queued", "running"].includes(processingJob.status)) {
      return;
    }
    let active = true;
    let timeoutId: number | undefined;
    const jobId = processingJob.job_id;

    async function poll() {
      const url = `/api/review/process/${jobId}`;
      console.log(`[REVIEW_PROCESS] GET ${url}`);
      try {
        const response = await fetch(url);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Process status failed: ${response.status} ${text}`);
        }
        const payload = (await response.json()) as ReviewProcessingJob;
        if (!active) return;
        console.log(
          `[REVIEW_PROCESS] status jobId=${payload.job_id} recordId=${payload.record_id} status=${payload.status} resample=${String(payload.details?.resample)}`,
        );
        setProcessingJob(payload);
        if (payload.status === "ready") {
          setProcessActionPending(false);
          setArtifactsNotReady(null);
          setReviewRefreshToken((value) => value + 1);
          return;
        }
        if (payload.status === "error") {
          setProcessActionPending(false);
          setError(payload.error || "Processing failed.");
          return;
        }
        timeoutId = window.setTimeout(poll, 1000);
      } catch (err) {
        if (!active) return;
        console.error("[REVIEW_PROCESS] poll error", err);
        setProcessActionPending(false);
        setError(err instanceof Error ? err.message : "Unknown processing status error");
      }
    }

    timeoutId = window.setTimeout(poll, 1000);
    return () => {
      active = false;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [processingJob]);

  async function handleProcessReview() {
    if (!reviewRecordId) {
      setError("No review record available to process.");
      return;
    }
    setProcessActionPending(true);
    setError(null);
    const url = `/api/review/${reviewRecordId}/process`;
    console.log(`[REVIEW_PROCESS] POST ${url} resample=${processResample}`);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ resample: processResample }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Process start failed: ${response.status} ${text}`);
      }
      const payload = (await response.json()) as ReviewProcessingJob;
      console.log(
        `[REVIEW_PROCESS] queued jobId=${payload.job_id} recordId=${payload.record_id} resample=${String(payload.details?.resample)}`,
      );
      setProcessingJob(payload);
    } catch (err) {
      console.error("[REVIEW_PROCESS] start error", err);
      setProcessActionPending(false);
      setError(err instanceof Error ? err.message : "Unknown processing start error");
    }
  }

  function applyRequestedRecordId() {
    const next = requestedRecordIdInput.trim();
    const nextQuery = new URLSearchParams(window.location.search);
    if (next) {
      nextQuery.set("recordId", next);
    } else {
      nextQuery.delete("recordId");
    }
    const nextUrl = nextQuery.toString() ? `${currentPath}?${nextQuery.toString()}` : currentPath;
    window.history.replaceState({}, "", nextUrl);
    setRequestedRecordId(next);
    setLoading(true);
    setError(null);
    setArtifactsNotReady(null);
    setData(null);
    setCalibrationWindow(null);
    setSessionWindow(null);
    setProcessingJob(null);
  }

  const reviewNavExtra = canProcessReview ? (
    <>
      <label className="route-process-toggle">
        <input
          type="checkbox"
          checked={processResample}
          onChange={(event) => setProcessResample(event.target.checked)}
          disabled={processActionPending || processingJob?.status === "running"}
        />
        <span>{`Resample ${processResample ? "On" : "Off"}`}</span>
      </label>
      <button
        className={`route-link route-action-button ${processActionPending || processingJob?.status === "running" ? "active" : ""}`}
        disabled={processActionPending || processingJob?.status === "running"}
        onClick={() => void handleProcessReview()}
        type="button"
      >
        {processActionPending || processingJob?.status === "running" ? "Processing..." : "Process"}
      </button>
      {processingJob ? (
        <span className="route-process-status">
          {`${processingJob.status} · ${String(processingJob.details?.resample)}`}
        </span>
      ) : null}
    </>
  ) : null;

  useEffect(() => {
    if (!data || !shouldLoadVectorBeats) {
      setCalibrationVector(null);
      return;
    }
    const recordId = data.record_id;
    let active = true;
    async function loadCalibrationVector() {
      setLoadingCalibrationVector(true);
      const url = `/api/review/${recordId}/vector_beat?section=calibration&beat_index=${calibrationBeat}`;
      console.log(`[VECTOR] GET ${url}`);
      try {
        const response = await fetch(url);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Vector fetch failed: ${response.status} ${text}`);
        }
        const payload = (await response.json()) as VectorBeatResponse;
        console.log(
          `[VECTOR] response section=${payload.section} beat=${payload.beat_index}/${payload.beat_count} samples=${Math.min(payload.lead_i.length, payload.lead_ii.length)} excluded=${payload.exclude_from_analysis}`,
        );
        if (!active) return;
        setCalibrationVector(payload);
      } catch (err) {
        if (!active) return;
        console.error("[VECTOR] calibration error", err);
        setCalibrationVector(null);
      } finally {
        if (active) setLoadingCalibrationVector(false);
      }
    }
    void loadCalibrationVector();
    return () => {
      active = false;
    };
  }, [data, calibrationBeat, shouldLoadVectorBeats]);

  useEffect(() => {
    if (!data || !shouldLoadVectorBeats) {
      setSessionVector(null);
      return;
    }
    const recordId = data.record_id;
    let active = true;
    async function loadSessionVector() {
      setLoadingSessionVector(true);
      const url = `/api/review/${recordId}/vector_beat?section=session&beat_index=${sessionBeat}`;
      console.log(`[VECTOR] GET ${url}`);
      try {
        const response = await fetch(url);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Vector fetch failed: ${response.status} ${text}`);
        }
        const payload = (await response.json()) as VectorBeatResponse;
        console.log(
          `[VECTOR] response section=${payload.section} beat=${payload.beat_index}/${payload.beat_count} samples=${Math.min(payload.lead_i.length, payload.lead_ii.length)} excluded=${payload.exclude_from_analysis}`,
        );
        if (!active) return;
        setSessionVector(payload);
      } catch (err) {
        if (!active) return;
        console.error("[VECTOR] session error", err);
        setSessionVector(null);
      } finally {
        if (active) setLoadingSessionVector(false);
      }
    }
    void loadSessionVector();
    return () => {
      active = false;
    };
  }, [data, sessionBeat, shouldLoadVectorBeats]);

  useEffect(() => {
    if (!data || !showVector3DMode) {
      setCalibrationVector3d(null);
      return;
    }
    const recordId = data.record_id;
    let active = true;
    async function loadCalibrationVector3d() {
      setLoadingCalibrationVector3d(true);
      const url = `/api/review/${recordId}/vector3d_beat?section=calibration&beat_index=${calibrationBeat}&progress_percent=${calibrationVectorMovement}&y_min_mv=${calibrationVectorRange.min}&y_max_mv=${calibrationVectorRange.max}`;
      console.log(`[VECTOR3D] GET ${url}`);
      try {
        const response = await fetch(url);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`3D vector fetch failed: ${response.status} ${text}`);
        }
        const payload = (await response.json()) as Vector3DBeatResponse;
        console.log(
          `[VECTOR3D] response section=${payload.section} beat=${payload.beat_index}/${payload.beat_count} progress=${payload.progress_percent} excluded=${payload.exclude_from_analysis}`,
        );
        if (!active) return;
        setCalibrationVector3d(payload);
      } catch (err) {
        if (!active) return;
        console.error("[VECTOR3D] calibration error", err);
        setCalibrationVector3d(null);
      } finally {
        if (active) setLoadingCalibrationVector3d(false);
      }
    }
    void loadCalibrationVector3d();
    return () => {
      active = false;
    };
  }, [data, calibrationBeat, calibrationVectorMovement, showVector3DMode, calibrationVectorRange.min, calibrationVectorRange.max]);

  useEffect(() => {
    if (!data || !showVector3DMode) {
      setSessionVector3d(null);
      return;
    }
    const recordId = data.record_id;
    let active = true;
    async function loadSessionVector3d() {
      setLoadingSessionVector3d(true);
      const url = `/api/review/${recordId}/vector3d_beat?section=session&beat_index=${sessionBeat}&progress_percent=${sessionVectorMovement}&y_min_mv=${sessionVectorRange.min}&y_max_mv=${sessionVectorRange.max}`;
      console.log(`[VECTOR3D] GET ${url}`);
      try {
        const response = await fetch(url);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`3D vector fetch failed: ${response.status} ${text}`);
        }
        const payload = (await response.json()) as Vector3DBeatResponse;
        console.log(
          `[VECTOR3D] response section=${payload.section} beat=${payload.beat_index}/${payload.beat_count} progress=${payload.progress_percent} excluded=${payload.exclude_from_analysis}`,
        );
        if (!active) return;
        setSessionVector3d(payload);
      } catch (err) {
        if (!active) return;
        console.error("[VECTOR3D] session error", err);
        setSessionVector3d(null);
      } finally {
        if (active) setLoadingSessionVector3d(false);
      }
    }
    void loadSessionVector3d();
    return () => {
      active = false;
    };
  }, [data, sessionBeat, sessionVectorMovement, showVector3DMode, sessionVectorRange.min, sessionVectorRange.max]);

  useEffect(() => {
    if (!data || !showVector3DMode) {
      return;
    }
    const recordId = data.record_id;
    const requests = [
      `/api/review/${recordId}/vector3d_preload?section=calibration&start_beat_index=${calibrationBeat}&progress_percent=${calibrationVectorMovement}&y_min_mv=${calibrationVectorRange.min}&y_max_mv=${calibrationVectorRange.max}`,
      `/api/review/${recordId}/vector3d_preload?section=session&start_beat_index=${sessionBeat}&progress_percent=${sessionVectorMovement}&y_min_mv=${sessionVectorRange.min}&y_max_mv=${sessionVectorRange.max}`,
    ];
    requests.forEach((url) => {
      console.log(`[VECTOR3D] PRELOAD ${url}`);
      void fetch(url, { method: "POST" }).catch((error) => {
        console.error("[VECTOR3D] preload error", error);
      });
    });
  }, [
    data,
    showVector3DMode,
    calibrationBeat,
    calibrationVectorMovement,
    sessionBeat,
    sessionVectorMovement,
    calibrationVectorRange.min,
    calibrationVectorRange.max,
    sessionVectorRange.min,
    sessionVectorRange.max,
  ]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <TopNav currentPath={currentPath} extra={reviewNavExtra} />
          <p className="eyebrow">ECG Review Workspace</p>
          <h1>Calibration and Session Review</h1>
          <p className="subtitle">NeuroKit2-backed signal review for calibration and exercise session traces.</p>
        </div>
        <div className="topbar-controls review-topbar-controls">
          <label className="channel-select record-input-card">
            <span>Record ID</span>
            <input
              value={requestedRecordIdInput}
              onChange={(event) => setRequestedRecordIdInput(event.target.value)}
              placeholder="Leave blank for latest record"
            />
          </label>
          <button className="apply-button" onClick={applyRequestedRecordId}>
            Apply
          </button>
          <label className="channel-select">
            <span>View</span>
            <select value={reviewMode} onChange={(event) => setReviewMode(event.target.value as (typeof REVIEW_MODES)[number])}>
              {REVIEW_MODES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          {!showWideVectorMode ? (
            <div className="scale-card">
              <span>Y scale (mV)</span>
              <div className="scale-inputs">
                <label className="scale-field">
                  <span>Min</span>
                  <input type="number" step="0.1" value={yMinMv} onChange={(event) => setYMinMv(Number(event.target.value) || 0)} />
                </label>
                <label className="scale-field">
                  <span>Max</span>
                  <input type="number" step="0.1" value={yMaxMv} onChange={(event) => setYMaxMv(Number(event.target.value) || 0)} />
                </label>
              </div>
            </div>
          ) : (
            <div className="scale-card">
              <span>Vector scale</span>
              <div className="meta-line">Auto-fit to current beat range.</div>
            </div>
          )}
        </div>
      </header>

      {loading && <div className="status-panel">Loading review data...</div>}
      {error && <div className="status-panel error">{error}</div>}
      {!loading && !error && artifactsNotReady && (
        <div className="status-panel">
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <div>
              <strong>Processed review artifacts are not ready.</strong>
              <div className="meta-line">
                {`Record ID: ${artifactsNotReady.record_id} | Status: ${artifactsNotReady.processed_status ?? "missing"}`}
              </div>
            </div>
            <div className="meta-line">Use the Process controls in the header to generate review artifacts.</div>
          </div>
        </div>
      )}

      {!loading && !error && data && (
        <div className={showWideVectorMode ? "content-stack vector-mode-content" : "content-stack"}>
          <div className="record-meta">
            <span>Record ID: {data.record_id}</span>
            <span>{showVectorMode ? "View: 2D Vectorcardiography" : showVector3DMode ? "View: 3D Vectorgraphy" : `Channel: ${data.channel}`}</span>
            <span>Sample Rate: {data.sample_rate_hz} Hz</span>
          </div>
          {showVectorMode ? (
            <div className="vector-sections-row">
              <VectorReviewSection
                title="Calibration 2D Vectorcardiography"
                beatIndex={calibrationBeat}
                beatCount={data.calibration.beats.count}
                data={calibrationVector}
                loading={loadingCalibrationVector}
                movementPercent={calibrationVectorMovement}
                yMin={calibrationVectorRange.min}
                yMax={calibrationVectorRange.max}
                onBeatIndexChange={setCalibrationBeat}
                onMovementPercentChange={setCalibrationVectorMovement}
              />
              <VectorReviewSection
                title="Session 2D Vectorcardiography"
                beatIndex={sessionBeat}
                beatCount={data.session.beats.count}
                data={sessionVector}
                loading={loadingSessionVector}
                movementPercent={sessionVectorMovement}
                yMin={sessionVectorRange.min}
                yMax={sessionVectorRange.max}
                onBeatIndexChange={setSessionBeat}
                onMovementPercentChange={setSessionVectorMovement}
                />
              </div>
            ) : showVector3DMode ? (
              <div className="vector-sections-row">
                <Vector3DReviewSection
                  title="Calibration 3D Vectorgraphy"
                  beatIndex={calibrationBeat}
                  beatCount={data.calibration.beats.count}
                  data={calibrationVector3d}
                  loading={loadingCalibrationVector3d}
                  movementPercent={calibrationVectorMovement}
                  onBeatIndexChange={setCalibrationBeat}
                  onMovementPercentChange={setCalibrationVectorMovement}
                />
                <Vector3DReviewSection
                  title="Session 3D Vectorgraphy"
                  beatIndex={sessionBeat}
                  beatCount={data.session.beats.count}
                  data={sessionVector3d}
                  loading={loadingSessionVector3d}
                  movementPercent={sessionVectorMovement}
                  onBeatIndexChange={setSessionBeat}
                  onMovementPercentChange={setSessionVectorMovement}
                />
              </div>
            ) : (
            <>
              {calibrationWindow && sessionWindow ? (
                <>
                  <ReviewSectionCard
                    title="Calibration Signal"
                    summary={data.calibration}
                    window={calibrationWindow}
                    sampleRateHz={data.sample_rate_hz}
                    beatIndex={calibrationBeat}
                    yMin={yMinMv}
                    yMax={yMaxMv}
                    onBeatIndexChange={setCalibrationBeat}
                  />
                  <SessionReviewCard
                    summary={data.session}
                    window={sessionWindow}
                    sampleRateHz={data.sample_rate_hz}
                    beatIndex={sessionBeat}
                    yMin={yMinMv}
                    yMax={yMaxMv}
                    onBeatIndexChange={setSessionBeat}
                  />
                </>
              ) : (
                <div className="status-panel">Loading review windows...</div>
              )}
            </>
          )}
        </div>
      )}
    </main>
  );
}

void ReviewPage;

function StaticReviewPage({ currentPath }: { currentPath: string }) {
  const searchParams = new URLSearchParams(window.location.search);
  const initialRecordId = searchParams.get("recordId") ?? "";
  const [recordIdInput, setRecordIdInput] = useState(initialRecordId);
  const [recordId, setRecordId] = useState(initialRecordId);
  const [manifest, setManifest] = useState<StaticReviewManifest | null>(null);
  const [selectedWindowIndex, setSelectedWindowIndex] = useState(1);
  const [loadingManifest, setLoadingManifest] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<StaticReviewJob | null>(null);
  const [processing, setProcessing] = useState(false);
  const [imageCacheProgress, setImageCacheProgress] = useState<{ done: number; total: number; active: boolean } | null>(null);

  const readyOrKnownWindows = manifest?.windows ?? [];
  const selectedWindow = readyOrKnownWindows.find((windowItem) => windowItem.window_index === selectedWindowIndex) ?? readyOrKnownWindows[0] ?? null;
  const sliderMax = Math.max(1, readyOrKnownWindows.length || manifest?.completed_window_count || 1);

  const imageUrl = (objectKey?: string) =>
    objectKey
      ? `/api/review_static/${encodeURIComponent(recordId)}/image?object_key=${encodeURIComponent(objectKey)}&v=${encodeURIComponent(manifest?.updated_at ?? "")}`
      : "";

  const imageUrlsForWindow = (windowItem?: StaticReviewWindow | null) =>
    windowItem?.images
      ? Object.values(windowItem.images)
          .filter(Boolean)
          .map((objectKey) => imageUrl(objectKey))
      : [];

  async function loadManifest(targetRecordId = recordId, silent = false) {
    const trimmed = targetRecordId.trim();
    if (!trimmed) {
      setManifest(null);
      setError(null);
      return;
    }
    if (!silent) setLoadingManifest(true);
    try {
      const response = await fetch(`/api/review_static/${encodeURIComponent(trimmed)}/manifest`);
      if (!response.ok) {
        if (response.status === 404) {
          setManifest(null);
          if (!silent) setError("Static review plots have not been generated for this record yet.");
          return;
        }
        const text = await response.text();
        throw new Error(`Manifest fetch failed: ${response.status} ${text}`);
      }
      const payload = (await response.json()) as StaticReviewManifest;
      setManifest(payload);
      setError(null);
      const knownWindows = payload.windows ?? [];
      if (knownWindows.length > 0 && !knownWindows.some((item) => item.window_index === selectedWindowIndex)) {
        setSelectedWindowIndex(knownWindows[0].window_index);
      }
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : "Unknown manifest error");
    } finally {
      if (!silent) setLoadingManifest(false);
    }
  }

  useEffect(() => {
    void loadManifest(recordId);
    // selectedWindowIndex is intentionally excluded so slider changes do not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId]);

  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    let active = true;
    let timeoutId: number | undefined;
    const jobId = job.job_id;
    async function poll() {
      try {
        const response = await fetch(`/api/review_static/process/${jobId}`);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Static review job poll failed: ${response.status} ${text}`);
        }
        const payload = (await response.json()) as StaticReviewJob;
        if (!active) return;
        setJob(payload);
        await loadManifest(payload.record_id, true);
        if (payload.status === "ready") {
          setProcessing(false);
          await loadManifest(payload.record_id, true);
          return;
        }
        if (payload.status === "error") {
          setProcessing(false);
          setError(payload.error || "Static review plot generation failed.");
          return;
        }
        timeoutId = window.setTimeout(poll, 1800);
      } catch (err) {
        if (!active) return;
        setProcessing(false);
        setError(err instanceof Error ? err.message : "Unknown static review job error");
      }
    }
    timeoutId = window.setTimeout(poll, 900);
    return () => {
      active = false;
      if (timeoutId) window.clearTimeout(timeoutId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.job_id, job?.status]);

  useEffect(() => {
    if (!recordId || manifest?.status !== "ready" || !readyOrKnownWindows.length) {
      setImageCacheProgress(null);
      return;
    }

    const urls = Array.from(new Set(readyOrKnownWindows.flatMap((windowItem) => imageUrlsForWindow(windowItem))));
    if (!urls.length) {
      setImageCacheProgress(null);
      return;
    }

    let cancelled = false;
    let cursor = 0;
    let done = 0;
    const workerCount = Math.min(6, urls.length);
    setImageCacheProgress({ done: 0, total: urls.length, active: true });

    async function cacheWorker() {
      while (!cancelled) {
        const nextIndex = cursor;
        cursor += 1;
        if (nextIndex >= urls.length) break;
        try {
          const response = await fetch(urls[nextIndex], { cache: "force-cache" });
          if (response.ok) {
            await response.blob();
          }
        } catch {
          // Cache warming is best-effort; visible images still load normally.
        } finally {
          done += 1;
          if (!cancelled) {
            setImageCacheProgress({ done, total: urls.length, active: done < urls.length });
          }
        }
      }
    }

    void Promise.all(Array.from({ length: workerCount }, () => cacheWorker())).then(() => {
      if (!cancelled) {
        setImageCacheProgress({ done: urls.length, total: urls.length, active: false });
      }
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId, manifest?.status, manifest?.updated_at]);


  function applyRecordId() {
    const next = recordIdInput.trim();
    const nextUrl = next ? `${currentPath}?recordId=${encodeURIComponent(next)}` : currentPath;
    window.history.replaceState({}, "", nextUrl);
    setRecordId(next);
    setManifest(null);
    setJob(null);
    setSelectedWindowIndex(1);
    setError(null);
  }

  async function startProcessing(force = false) {
    const trimmed = recordIdInput.trim() || recordId.trim();
    if (!trimmed) {
      setError("Enter a record_id before generating review plots.");
      return;
    }
    setProcessing(true);
    setError(null);
    setRecordId(trimmed);
    const nextUrl = `${currentPath}?recordId=${encodeURIComponent(trimmed)}`;
    window.history.replaceState({}, "", nextUrl);
    try {
      const response = await fetch(`/api/review_static/${encodeURIComponent(trimmed)}/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Static review process start failed: ${response.status} ${text}`);
      }
      const payload = (await response.json()) as StaticReviewJob;
      setJob(payload);
      await loadManifest(trimmed, true);
    } catch (err) {
      setProcessing(false);
      setError(err instanceof Error ? err.message : "Unknown static review process error");
    }
  }

  const progressLabel = manifest
    ? `${manifest.completed_window_count} / ${manifest.target_window_count || manifest.total_window_count} windows ready`
    : "No generated static review manifest loaded";

  const windowLabel = selectedWindow
    ? `Window ${selectedWindow.window_index} · ${selectedWindow.start_sec.toFixed(0)}s - ${selectedWindow.end_sec.toFixed(0)}s`
    : "No window selected";

  return (
    <main className="app-shell static-review-shell">
      <header className="topbar">
        <div>
          <TopNav currentPath={currentPath} />
          <p className="eyebrow">Static ECG Review Workspace</p>
          <h1>Calibration vs Session Window Comparison</h1>
          <p className="subtitle">Backend-generated mean-beat and vectorcardiography comparison plots. The frontend only loads precomputed images.</p>
        </div>
        <div className="topbar-controls review-topbar-controls">
          <div className="channel-select record-input-card static-record-card">
            <div className="static-record-field">
              <span>Record ID</span>
              <input value={recordIdInput} onChange={(event) => setRecordIdInput(event.target.value)} placeholder="Paste ecg_recordings.id" />
            </div>
            <button className="apply-button" onClick={applyRecordId} type="button">
              Load
            </button>
            <button className="apply-button" disabled={processing} onClick={() => void startProcessing(false)} type="button">
              {processing ? "Generating..." : "Generate"}
            </button>
          </div>
        </div>
      </header>

      {loadingManifest ? <div className="status-panel">Loading static review manifest...</div> : null}
      {error ? <div className="status-panel error">{error}</div> : null}

      <div className="content-stack">
        <div className="record-meta">
          <span>Record ID: {recordId || "n/a"}</span>
          <span>Status: {manifest?.status ?? job?.status ?? "not generated"}</span>
          <span>{progressLabel}</span>
          {imageCacheProgress ? (
            <span>
              Image cache: {imageCacheProgress.done} / {imageCacheProgress.total}
              {imageCacheProgress.active ? " warming" : " ready"}
            </span>
          ) : null}
          {manifest?.updated_at ? <span>Updated: {new Date(manifest.updated_at).toLocaleString()}</span> : null}
        </div>

        <section className="review-section static-review-controls">
          <div>
            <h2>{windowLabel}</h2>
            <p className="meta-line">Use the slider to inspect the n-th 20-second session window that has been generated.</p>
          </div>
          <input
            className="static-window-slider"
            type="range"
            min={1}
            max={sliderMax}
            value={Math.min(selectedWindowIndex, sliderMax)}
            onChange={(event) => setSelectedWindowIndex(Number(event.target.value))}
            disabled={!readyOrKnownWindows.length}
          />
        </section>

        {selectedWindow?.status === "error" ? (
          <div className="status-panel error">{selectedWindow.error || "This window failed to generate."}</div>
        ) : selectedWindow ? (
          <section className="static-review-grid">
            <div className="static-review-column">
              <StaticReviewImage title="CH2 Mean Beat" src={imageUrl(selectedWindow.images.ch2)} />
              <StaticReviewImage title="CH3 Mean Beat" src={imageUrl(selectedWindow.images.ch3)} />
              <StaticReviewImage title="CH4 Mean Beat" src={imageUrl(selectedWindow.images.ch4)} />
            </div>
            <div className="static-review-column">
              <StaticReviewImage title="Frontal Plane" src={imageUrl(selectedWindow.images.frontal)} />
              <StaticReviewImage title="Transverse Plane" src={imageUrl(selectedWindow.images.transverse)} />
              <StaticReviewImage title="Sagittal Plane" src={imageUrl(selectedWindow.images.sagittal)} />
            </div>
            <div className="static-review-column static-review-column-3d">
              <StaticReviewImage title="3D Vectorcardiography" src={imageUrl(selectedWindow.images.vcg3d)} tall />
            </div>
          </section>
        ) : (
          <div className="status-panel">Load or generate a static review manifest to view comparison plots.</div>
        )}
      </div>
    </main>
  );
}

function StaticReviewImage({ title, src, tall = false }: { title: string; src: string; tall?: boolean }) {
  return (
    <article className={tall ? "static-review-image-card static-review-image-card-tall" : "static-review-image-card"}>
      <div className="card-header">
        <h3>{title}</h3>
      </div>
      {src ? <img src={src} alt={title} loading="eager" decoding="async" /> : <div className="status-panel">Image not available</div>}
    </article>
  );
}

function LiveSessionPage({ currentPath }: { currentPath: string }) {
  const searchParams = new URLSearchParams(window.location.search);
  const initialRecordId = searchParams.get("recordId") ?? "";
  const [recordId] = useState(initialRecordId);
  const [data, setData] = useState<LiveVisualResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pollingStopped, setPollingStopped] = useState(false);

  useEffect(() => {
    let active = true;
    let stopped = false;
    let inFlight = false;
    let eventSource: EventSource | null = null;

    async function load() {
      if (!active || stopped || inFlight) {
        console.log(
          `[LIVE] skip load active=${active} stopped=${stopped} inFlight=${inFlight} recordId=${recordId || "latest"}`,
        );
        return;
      }
      inFlight = true;
      const query = new URLSearchParams();
      if (recordId) {
        query.set("record_id", recordId);
      }
      const url = `/api/session/live/visual?${query.toString()}`;
      console.log(`[LIVE] fetch start url=${url}`);
      try {
        const response = await fetch(url);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Live session fetch failed: ${response.status} ${text}`);
        }
        const payload = (await response.json()) as LiveVisualResponse;
        console.log(
          `[LIVE] fetch success recordId=${payload.record_id} status=${payload.status} buffer=${payload.buffer_samples} total=${payload.total_samples_received} hr=${payload.heart_rate_bpm ?? "null"} updated_at=${payload.updated_at}`,
        );
        if (!active) return;
        setData((current) => {
          if (!current) {
            console.log(
              `[LIVE] apply snapshot recordId=${payload.record_id} total=${payload.total_samples_received} reason=initial`,
            );
            return payload;
          }
          if (payload.record_id !== current.record_id) {
            console.log(
              `[LIVE] apply snapshot recordId=${payload.record_id} total=${payload.total_samples_received} reason=record-switch previous=${current.record_id}`,
            );
            return payload;
          }
          if (payload.total_samples_received < current.total_samples_received) {
            console.log(
              `[LIVE] ignore snapshot recordId=${payload.record_id} total=${payload.total_samples_received} previous=${current.total_samples_received} reason=older-total`,
            );
            return current;
          }
          const currentUpdatedAt = Date.parse(current.updated_at || "");
          const payloadUpdatedAt = Date.parse(payload.updated_at || "");
          if (
            Number.isFinite(currentUpdatedAt) &&
            Number.isFinite(payloadUpdatedAt) &&
            payloadUpdatedAt < currentUpdatedAt
          ) {
            console.log(
              `[LIVE] ignore snapshot recordId=${payload.record_id} total=${payload.total_samples_received} reason=older-updated-at current=${current.updated_at} next=${payload.updated_at}`,
            );
            return current;
          }
          console.log(
            `[LIVE] apply snapshot recordId=${payload.record_id} total=${payload.total_samples_received} reason=fresh`,
          );
          return payload;
        });
        setError(null);
        if (payload.status === "ended") {
          stopped = true;
          setPollingStopped(true);
        } else {
          setPollingStopped(false);
        }
      } catch (err) {
        if (!active) return;
        console.error("[LIVE] fetch error", err);
        setError(err instanceof Error ? err.message : "Unknown live session error");
      } finally {
        inFlight = false;
        if (active) {
          setLoading(false);
        }
      }
    }

    void load();
    const eventQuery = new URLSearchParams();
    if (recordId) {
      eventQuery.set("record_id", recordId);
    }
    const eventUrl = `/api/session/live/events?${eventQuery.toString()}`;
    console.log(`[LIVE] sse connect url=${eventUrl}`);
    eventSource = new EventSource(eventUrl);
    eventSource.onopen = () => {
      console.log(`[LIVE] sse open recordId=${recordId || "latest"}`);
    };
    eventSource.addEventListener("preview", (event) => {
      if (!active || stopped) {
        return;
      }
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          record_id?: string;
          status?: string;
        };
        if (recordId && payload.record_id && payload.record_id !== recordId) {
          console.log(
            `[LIVE] sse ignore recordId=${payload.record_id} current=${recordId}`,
          );
          return;
        }
        console.log(
          `[LIVE] sse preview recordId=${payload.record_id ?? "unknown"} status=${payload.status ?? "unknown"}`,
        );
        if (payload.status === "ended") {
          stopped = true;
          setPollingStopped(true);
        }
      } catch {
        console.warn("[LIVE] sse malformed preview event");
      }
      void load();
    });
    eventSource.onerror = () => {
      if (!active || stopped) {
        return;
      }
      console.warn(`[LIVE] sse error recordId=${recordId || "latest"}`);
      void load();
    };

    return () => {
      active = false;
      if (eventSource) {
        console.log(`[LIVE] sse close recordId=${recordId || "latest"}`);
        eventSource.close();
      }
    };
  }, [recordId]);

  const playback = useMemo(() => {
    if (!data) return null;
    const currentCount = Math.min(
      data.channels.CH2.length,
      data.channels.CH3.length,
      data.channels.CH4.length,
      data.buffer_samples || LIVE_VISUAL_BUFFER_SAMPLES,
    );
    if (currentCount <= 0) {
      return {
        channels: {
          CH2: [] as number[],
          CH3: [] as number[],
          CH4: [] as number[],
        },
        displayedSamples: 0,
      };
    }
    const currentChannels = {
      CH2: data.channels.CH2.slice(-currentCount),
      CH3: data.channels.CH3.slice(-currentCount),
      CH4: data.channels.CH4.slice(-currentCount),
    };
    return {
      channels: currentChannels,
      displayedSamples: currentCount,
    };
  }, [data]);

  return (
    <main className="app-shell live-dashboard-shell">
      <header className="topbar live-topbar">
        <div>
          <TopNav currentPath={currentPath} />
          <p className="eyebrow">Live Session Dashboard</p>
          <h1>Buffered Realtime Session View</h1>
          <p className="subtitle">Four synchronized quadrants with a deliberate 500 ms playback lag for smoother live visualization.</p>
        </div>
      </header>

      {loading && <div className="status-panel">Loading live session data...</div>}
      {error && <div className="status-panel error">{error}</div>}

      {!loading && !error && data && playback && (
        <div className="content-stack">
          <div className="record-meta">
            <span>Record ID: {data.record_id}</span>
            <span>Session ID: {data.session_id ?? "n/a"}</span>
            <span>Status: {data.status}</span>
            <span>Updated: {new Date(data.updated_at).toLocaleString()}</span>
            {data.ended_at ? <span>Ended: {new Date(data.ended_at).toLocaleString()}</span> : null}
          </div>
          {pollingStopped ? (
            <div className="status-panel">Live polling stopped because the session has ended.</div>
          ) : null}
          <section className="review-section live-dashboard-section">
            <div className="live-status-strip">
              <div className="summary-metric"><span>Buffer</span><strong>{data.buffer_samples} samples</strong></div>
              <div className="summary-metric"><span>Heart Rate</span><strong>{formatMetric(data.heart_rate_bpm, " bpm")}</strong></div>
            </div>
            <div className="live-dashboard-main">
              <div className="live-waveform-stack">
                <LiveWaveformCanvas
                  title="CH2"
                  samples={playback.channels.CH2}
                  sampleRateHz={data.sample_rate_hz}
                />
                <LiveWaveformCanvas
                  title="CH3"
                  samples={playback.channels.CH3}
                  sampleRateHz={data.sample_rate_hz}
                />
                <LiveWaveformCanvas
                  title="CH4"
                  samples={playback.channels.CH4}
                  sampleRateHz={data.sample_rate_hz}
                />
              </div>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

export default function App() {
  const pathname = window.location.pathname;
  if (pathname.startsWith("/session")) {
    return <LiveSessionPage currentPath={pathname} />;
  }
  return <StaticReviewPage currentPath={pathname} />;
}
