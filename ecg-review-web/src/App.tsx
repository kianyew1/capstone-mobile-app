import { useEffect, useMemo, useRef, useState } from "react";

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

type ReviewSection = {
  meta: ReviewMeta;
  signal: {
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
  beats: {
    count: number;
    items: ReviewBeat[];
  };
  beat_count_total: number;
  beat_count_included: number;
  beat_count_excluded: number;
  excluded_reason_counts: Record<string, number>;
  window_index: number;
  window_count: number;
  window_start_sample: number;
  window_end_sample: number;
  interval_related: ReviewIntervalRow | null;
  interval_related_rows: ReviewIntervalRow[];
};

type ReviewResponse = {
  record_id: string;
  channel: "CH2" | "CH3" | "CH4";
  sample_rate_hz: number;
  calibration: ReviewSection;
  session: ReviewSection;
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

const CHANNELS = ["CH2", "CH3", "CH4"] as const;
const REVIEW_MODES = ["CH2", "CH3", "CH4", "Vectorcardiography", "3D Vectorgraphy"] as const;
const DEFAULT_ECG_Y_MAX_MV = 0.6;
const DEFAULT_ECG_Y_MIN_MV = -0.3;
const LIVE_VISUAL_BUFFER_SAMPLES = 6000;
const LIVE_FETCH_INTERVAL_MS = 500;
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

function getBeatSamples(fullSignal: number[], beat: ReviewBeat | null): number[] {
  if (!beat) {
    return [];
  }
  return fullSignal.slice(Math.max(0, beat.start_sample - 1), Math.max(0, beat.end_sample));
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

function projectVector3DPoint(
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  axisMin: number,
  axisMax: number,
): { x: number; y: number; depth: number } {
  const span = axisMax - axisMin || 1;
  const center = (axisMin + axisMax) / 2;
  const normalizedX = (x - center) / span;
  const normalizedY = (y - center) / span;
  const normalizedZ = (z - center) / span;
  const yaw = -Math.PI / 4;
  const pitch = Math.PI / 7;

  const x1 = normalizedX * Math.cos(yaw) + normalizedZ * Math.sin(yaw);
  const z1 = -normalizedX * Math.sin(yaw) + normalizedZ * Math.cos(yaw);
  const y1 = normalizedY * Math.cos(pitch) - z1 * Math.sin(pitch);
  const z2 = normalizedY * Math.sin(pitch) + z1 * Math.cos(pitch);
  const perspective = 1 / (1 + z2 * 0.6);
  const scale = Math.min(width, height) * 1.65;

  return {
    x: width / 2 + x1 * scale * perspective,
    y: height / 2 - y1 * scale * perspective,
    depth: z2,
  };
}

function TopNav({ currentPath }: { currentPath: string }) {
  return (
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
  const { path, min, max } = useMemo(
    () => createPath(samples, plotWidth, plotHeight, yMin, yMax),
    [samples, plotWidth, plotHeight, yMin, yMax],
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
        <span>{samples.length} samples</span>
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
  yMin,
  yMax,
}: {
  title: string;
  samples: number[];
  sampleRateHz: number;
  yMin: number;
  yMax: number;
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
  }, [samples, sampleRateHz, yMin, yMax]);

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

function LiveVector3DCanvas({
  xSamples,
  ySamples,
  zSamples,
  yMin,
  yMax,
}: {
  xSamples: number[];
  ySamples: number[];
  zSamples: number[];
  yMin: number;
  yMax: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#f7fbfd";
    ctx.fillRect(0, 0, width, height);

    const project = (x: number, y: number, z: number) =>
      projectVector3DPoint(x, y, z, width, height, yMin, yMax);
    const axes = [
      { from: [yMin, 0, 0] as const, to: [yMax, 0, 0] as const, color: "#dc2626" },
      { from: [0, yMin, 0] as const, to: [0, yMax, 0] as const, color: "#2563eb" },
      { from: [0, 0, yMin] as const, to: [0, 0, yMax] as const, color: "#16a34a" },
    ];

    axes.forEach((axis) => {
      const from = project(axis.from[0], axis.from[1], axis.from[2]);
      const to = project(axis.to[0], axis.to[1], axis.to[2]);
      ctx.strokeStyle = axis.color;
      ctx.globalAlpha = 0.68;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    const count = Math.min(xSamples.length, ySamples.length, zSamples.length);
    if (!count) {
      ctx.fillStyle = "#6d8395";
      ctx.font = "13px Segoe UI";
      ctx.fillText("Waiting for live vector data...", 22, height / 2);
      return;
    }

    ctx.strokeStyle = "#0d697a";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let index = 0; index < count; index += 1) {
      const point = project(xSamples[index], ySamples[index], zSamples[index]);
      if (index === 0) {
        ctx.moveTo(point.x, point.y);
      } else {
        ctx.lineTo(point.x, point.y);
      }
    }
    ctx.stroke();
  }, [xSamples, ySamples, zSamples, yMin, yMax]);

  return (
    <section className="live-quadrant-card live-vector-card">
      <div className="card-header">
        <h3>3D Vectorcardiography</h3>
        <span>{Math.min(xSamples.length, ySamples.length, zSamples.length)} samples</span>
      </div>
      <canvas ref={canvasRef} width={720} height={720} className="live-canvas live-vector-canvas" />
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

function VectorLoopChart({
  title,
  data,
  progressPercent,
  yMin,
  yMax,
}: {
  title: string;
  data: VectorBeatResponse | null;
  progressPercent: number;
  yMin: number;
  yMax: number;
}) {
  const width = 970;
  const height = 666;
  const margin = { top: 20, right: 28, bottom: 72, left: 72 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const leadI = data?.lead_i ?? [];
  const leadII = data?.lead_ii ?? [];
  const axisMin = yMin;
  const axisMax = yMax;
  const { path, axisX, axisY, points } = useMemo(
    () => createVectorLoopGeometry(leadI, leadII, plotWidth, plotHeight, axisMin, axisMax),
    [leadI, leadII, plotWidth, plotHeight, axisMin, axisMax],
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
  if (!data) {
    return (
      <div className="chart-card vector-card">
        <div className="card-header">
          <h3>{title}</h3>
        </div>
        <div className="empty-state">No vector beat available.</div>
      </div>
    );
  }

  return (
    <div className="chart-card vector-card">
      <div className="card-header">
        <div>
          <h3>{title}</h3>
          <span className="chart-subtitle">X = Lead I (CH2) | Y = Lead II (CH3)</span>
        </div>
        <span>{Math.min(data.lead_i.length, data.lead_ii.length)} samples</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="vector-chart">
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
          Lead I / CH2 (mV)
        </text>
        <text
          x={20}
          y={margin.top + plotHeight / 2}
          textAnchor="middle"
          transform={`rotate(-90 20 ${margin.top + plotHeight / 2})`}
          className="axis-unit-label"
        >
          Lead II / CH3 (mV)
        </text>
        <g transform={`translate(${margin.left} ${margin.top})`}>
          <line x1={axisX} y1={0} x2={axisX} y2={plotHeight} className="grid-line" />
          <line x1={0} y1={axisY} x2={plotWidth} y2={axisY} className="grid-line" />
          <path d={visiblePath || path} className="signal-path vector-path" />
        </g>
        {(Object.entries(data.markers) as Array<[keyof BeatMarkers, number[]]>).map(([label, positions]) =>
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
        {data.exclude_from_analysis ? (
          <g>
            <rect x={margin.left} y={margin.top} width={plotWidth} height={plotHeight} className="excluded-overlay" />
            <text x={width / 2} y={height / 2 - 10} textAnchor="middle" className="excluded-overlay-text">
              Excluded from analysis
            </text>
            {data.qr_duration_ms !== null ? (
              <text x={width / 2} y={height / 2 + 14} textAnchor="middle" className="excluded-overlay-subtext">
                {`Q-R ${data.qr_duration_ms.toFixed(1)} ms`}
              </text>
            ) : null}
          </g>
        ) : null}
      </svg>
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
          <p className="meta-line">2D beat morphology from Lead I (CH2) and Lead II (CH3).</p>
        </div>
      </div>
      <div className="vector-section-grid">
        <div className="signal-column">
          <VectorLoopChart title={`${title} Morphology`} data={data} progressPercent={movementPercent} yMin={yMin} yMax={yMax} />
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
  section,
  sampleRateHz,
  beatIndex,
  yMin,
  yMax,
  onBeatIndexChange,
}: {
  title: string;
  section: ReviewSection;
  sampleRateHz: number;
  beatIndex: number;
  yMin: number;
  yMax: number;
  onBeatIndexChange: (value: number) => void;
}) {
  const beat = section.beats.items.find((item) => item.index === beatIndex) ?? section.beats.items[0] ?? null;
  const beatSamples = useMemo(() => getBeatSamples(section.signal.full, beat), [section.signal.full, beat]);
  const highlightStart = beat ? Math.max(0, beat.start_sample - 1) : null;
  const highlightEnd = beat ? beat.end_sample : null;

  return (
    <section className="review-section">
      <div className="section-header">
        <div>
          <h2>{title}</h2>
          <p className="meta-line">
            object_key={section.meta.object_key} | byte_length={section.meta.byte_length} | sample_count={section.meta.sample_count}
            {` | included_beats=${section.beat_count_included}/${section.beat_count_total}`}
          </p>
        </div>
      </div>
      <div className="section-grid">
        <div className="signal-column">
          <FullSignalChart
            title={`${title} Full Signal`}
            samples={section.signal.full}
            sampleRateHz={sampleRateHz}
            yMin={yMin}
            yMax={yMax}
            highlightStart={highlightStart}
            highlightEnd={highlightEnd}
          />
        </div>
        <div className="beat-column">
          <BeatChart
            title={`${title} Heartbeat`}
            beat={beat}
            samples={beatSamples}
            beatCount={section.beats.count}
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
                max={Math.max(section.beats.count, 1)}
                value={beat?.index ?? beatIndex}
                onChange={(event) =>
                  onBeatIndexChange(
                    Math.min(
                      Math.max(Number(event.target.value) || 1, 1),
                      Math.max(section.beats.count, 1),
                    ),
                  )
                }
              />
            </label>
            <button
              className="window-button"
              disabled={!beat || beat.index >= section.beats.count}
              onClick={() =>
                onBeatIndexChange(
                  Math.min(section.beats.count, (beat?.index ?? section.beats.count) + 1),
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
        <IntervalSummary row={section.interval_related} />
      </div>
    </section>
  );
}

function SessionReviewCard({
  section,
  sampleRateHz,
  beatIndex,
  yMin,
  yMax,
  onBeatIndexChange,
}: {
  section: ReviewSection;
  sampleRateHz: number;
  beatIndex: number;
  yMin: number;
  yMax: number;
  onBeatIndexChange: (value: number) => void;
}) {
  const beats = section.beats.items;
  const beat = beats.find((item) => item.index === beatIndex) ?? beats[0] ?? null;
  const beatSamples = useMemo(() => getBeatSamples(section.signal.full, beat), [section.signal.full, beat]);
  const displayWindowStart = beat ? beat.window_start_sample : 1;
  const displayWindowEnd = beat ? beat.window_end_sample : Math.min(section.signal.full.length, sampleRateHz * 20);
  const windowSamples = section.signal.full.slice(
    Math.max(0, displayWindowStart - 1),
    displayWindowEnd,
  );
  const highlightStart =
    beat && beat.start_sample >= displayWindowStart ? beat.start_sample - displayWindowStart : null;
  const highlightEnd =
    beat && beat.end_sample >= displayWindowStart ? beat.end_sample - displayWindowStart : null;
  const selectedWindowIndex = beat?.window_index ?? 1;
  const selectedIntervalRow =
    section.interval_related_rows.find((row) => row.interval_index === selectedWindowIndex) ?? null;

  return (
    <section className="review-section">
      <div className="section-header">
        <div>
          <h2>Session Signal</h2>
          <p className="meta-line">
            object_key={section.meta.object_key} | byte_length={section.meta.byte_length} | sample_count={section.meta.sample_count}
            {` | included_beats=${section.beat_count_included}/${section.beat_count_total}`}
          </p>
        </div>
      </div>
      <div className="section-grid">
        <div className="signal-column">
          <FullSignalChart
            title="Session 20s Window"
            samples={windowSamples}
            sampleRateHz={sampleRateHz}
            yMin={yMin}
            yMax={yMax}
            highlightStart={highlightStart}
            highlightEnd={highlightEnd}
            subtitle={`Samples ${displayWindowStart}-${displayWindowEnd} | Window ${beat?.window_index ?? 1} of ${section.window_count}`}
          />
        </div>
        <div className="beat-column">
          <BeatChart
            title="Session Heartbeat"
            beat={beat}
            samples={beatSamples}
            beatCount={section.beats.count}
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
                max={Math.max(section.beats.count, 1)}
                value={beat?.index ?? beatIndex}
                onChange={(event) =>
                  onBeatIndexChange(
                    Math.min(
                      Math.max(Number(event.target.value) || 1, 1),
                      Math.max(section.beats.count, 1),
                    ),
                  )
                }
              />
            </label>
            <button
              className="window-button"
              disabled={!beat || beat.index >= section.beats.count}
              onClick={() =>
                onBeatIndexChange(
                  Math.min(section.beats.count, (beat?.index ?? section.beats.count) + 1),
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
          <span>{`Window ${selectedWindowIndex} of ${section.window_count}`}</span>
        </div>
        <IntervalSummary row={selectedIntervalRow} />
      </div>
    </section>
  );
}

function ReviewPage({ currentPath }: { currentPath: string }) {
  const [reviewMode, setReviewMode] = useState<(typeof REVIEW_MODES)[number]>("CH2");
  const [yMaxMv, setYMaxMv] = useState(DEFAULT_ECG_Y_MAX_MV);
  const [yMinMv, setYMinMv] = useState(DEFAULT_ECG_Y_MIN_MV);
  const [data, setData] = useState<ReviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
    reviewMode === "Vectorcardiography" || reviewMode === "3D Vectorgraphy" ? "CH2" : reviewMode;
  const showVectorMode = reviewMode === "Vectorcardiography";
  const showVector3DMode = reviewMode === "3D Vectorgraphy";
  const showWideVectorMode = showVectorMode || showVector3DMode;

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError(null);
      const url = `/api/review/latest?channel=${selectedChannel}`;
      console.log(`[REVIEW] GET ${url}`);
      try {
        const response = await fetch(url);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Review fetch failed: ${response.status} ${text}`);
        }
        const payload = (await response.json()) as ReviewResponse;
        console.log(
          `[REVIEW] response recordId=${payload.record_id} channel=${payload.channel} calibrationSamples=${payload.calibration.signal.full.length} sessionSamples=${payload.session.signal.full.length} sessionBeats=${payload.session.beats.count}`,
        );
        if (!active) return;
        setData(payload);
        setCalibrationBeat(1);
        setSessionBeat(1);
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
  }, [selectedChannel]);

  useEffect(() => {
    if (!data || !showVectorMode) {
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
  }, [data, calibrationBeat, showVectorMode]);

  useEffect(() => {
    if (!data || !showVectorMode) {
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
  }, [data, sessionBeat, showVectorMode]);

  useEffect(() => {
    if (!data || !showVector3DMode) {
      setCalibrationVector3d(null);
      return;
    }
    const recordId = data.record_id;
    let active = true;
    async function loadCalibrationVector3d() {
      setLoadingCalibrationVector3d(true);
      const url = `/api/review/${recordId}/vector3d_beat?section=calibration&beat_index=${calibrationBeat}&progress_percent=${calibrationVectorMovement}&y_min_mv=${yMinMv}&y_max_mv=${yMaxMv}`;
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
  }, [data, calibrationBeat, calibrationVectorMovement, showVector3DMode, yMinMv, yMaxMv]);

  useEffect(() => {
    if (!data || !showVector3DMode) {
      setSessionVector3d(null);
      return;
    }
    const recordId = data.record_id;
    let active = true;
    async function loadSessionVector3d() {
      setLoadingSessionVector3d(true);
      const url = `/api/review/${recordId}/vector3d_beat?section=session&beat_index=${sessionBeat}&progress_percent=${sessionVectorMovement}&y_min_mv=${yMinMv}&y_max_mv=${yMaxMv}`;
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
  }, [data, sessionBeat, sessionVectorMovement, showVector3DMode, yMinMv, yMaxMv]);

  useEffect(() => {
    if (!data || !showVector3DMode) {
      return;
    }
    const recordId = data.record_id;
    const requests = [
      `/api/review/${recordId}/vector3d_preload?section=calibration&start_beat_index=${calibrationBeat}&progress_percent=${calibrationVectorMovement}&y_min_mv=${yMinMv}&y_max_mv=${yMaxMv}`,
      `/api/review/${recordId}/vector3d_preload?section=session&start_beat_index=${sessionBeat}&progress_percent=${sessionVectorMovement}&y_min_mv=${yMinMv}&y_max_mv=${yMaxMv}`,
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
    yMinMv,
    yMaxMv,
  ]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <TopNav currentPath={currentPath} />
          <p className="eyebrow">ECG Review Workspace</p>
          <h1>Calibration and Session Review</h1>
          <p className="subtitle">NeuroKit2-backed signal review for calibration and exercise session traces.</p>
        </div>
        <div className="topbar-controls">
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
        </div>
      </header>

      {loading && <div className="status-panel">Loading review data...</div>}
      {error && <div className="status-panel error">{error}</div>}

      {!loading && !error && data && (
        <div className={showWideVectorMode ? "content-stack vector-mode-content" : "content-stack"}>
          <div className="record-meta">
            <span>Record ID: {data.record_id}</span>
            <span>{showVectorMode ? "View: Vectorcardiography" : showVector3DMode ? "View: 3D Vectorgraphy" : `Channel: ${data.channel}`}</span>
            <span>Sample Rate: {data.sample_rate_hz} Hz</span>
          </div>
          {showVectorMode ? (
            <div className="vector-sections-row">
              <VectorReviewSection
                title="Calibration Vectorcardiography"
                beatIndex={calibrationBeat}
                beatCount={data.calibration.beats.count}
                data={calibrationVector}
                loading={loadingCalibrationVector}
                movementPercent={calibrationVectorMovement}
                yMin={yMinMv}
                yMax={yMaxMv}
                onBeatIndexChange={setCalibrationBeat}
                onMovementPercentChange={setCalibrationVectorMovement}
              />
              <VectorReviewSection
                title="Session Vectorcardiography"
                beatIndex={sessionBeat}
                beatCount={data.session.beats.count}
                data={sessionVector}
                loading={loadingSessionVector}
                movementPercent={sessionVectorMovement}
                yMin={yMinMv}
                yMax={yMaxMv}
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
              <ReviewSectionCard
                title="Calibration Signal"
                section={data.calibration}
                sampleRateHz={data.sample_rate_hz}
                beatIndex={calibrationBeat}
                yMin={yMinMv}
                yMax={yMaxMv}
                onBeatIndexChange={setCalibrationBeat}
              />
              <SessionReviewCard
                section={data.session}
                sampleRateHz={data.sample_rate_hz}
                beatIndex={sessionBeat}
                yMin={yMinMv}
                yMax={yMaxMv}
                onBeatIndexChange={setSessionBeat}
              />
            </>
          )}
        </div>
      )}
    </main>
  );
}

function LiveSessionPage({ currentPath }: { currentPath: string }) {
  const searchParams = new URLSearchParams(window.location.search);
  const initialRecordId = searchParams.get("recordId") ?? "";
  const [recordIdInput, setRecordIdInput] = useState(initialRecordId);
  const [recordId, setRecordId] = useState(initialRecordId);
  const [data, setData] = useState<LiveVisualResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pollingStopped, setPollingStopped] = useState(false);

  useEffect(() => {
    let active = true;
    let intervalId: number | undefined;
    let stopped = false;

    async function load() {
      const query = new URLSearchParams();
      if (recordId) {
        query.set("record_id", recordId);
      }
      const url = `/api/session/live/visual?${query.toString()}`;
      console.log(`[LIVE] GET ${url}`);
      try {
        const response = await fetch(url);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Live session fetch failed: ${response.status} ${text}`);
        }
        const payload = (await response.json()) as LiveVisualResponse;
        console.log(
          `[LIVE] visual response recordId=${payload.record_id} status=${payload.status} buffer=${payload.buffer_samples} total=${payload.total_samples_received} hr=${payload.heart_rate_bpm ?? "null"}`,
        );
        if (!active) return;
        setData(payload);
        setError(null);
        if (payload.status === "ended") {
          stopped = true;
          setPollingStopped(true);
          if (intervalId !== undefined) {
            window.clearInterval(intervalId);
            intervalId = undefined;
          }
        } else {
          setPollingStopped(false);
        }
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Unknown live session error");
      } finally {
      if (active) {
          setLoading(false);
        }
      }
    }

    void load();
    intervalId = window.setInterval(() => {
      if (!stopped) {
        void load();
      }
    }, LIVE_FETCH_INTERVAL_MS);

    return () => {
      active = false;
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
      }
    };
  }, [recordId]);

  const applyRecordId = () => {
    const next = recordIdInput.trim();
    const nextUrl = next ? `/session?recordId=${encodeURIComponent(next)}` : "/session";
    window.history.replaceState({}, "", nextUrl);
    setRecordId(next);
    setData(null);
    setLoading(true);
    setPollingStopped(false);
  };

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
        <div className="live-controls">
          <label className="channel-select record-input-card">
            <span>Record ID</span>
            <input value={recordIdInput} onChange={(event) => setRecordIdInput(event.target.value)} placeholder="Leave blank for latest active session" />
          </label>
          <button className="apply-button" onClick={applyRecordId}>
            Apply
          </button>
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
                  yMin={DEFAULT_ECG_Y_MIN_MV}
                  yMax={DEFAULT_ECG_Y_MAX_MV}
                />
                <LiveWaveformCanvas
                  title="CH3"
                  samples={playback.channels.CH3}
                  sampleRateHz={data.sample_rate_hz}
                  yMin={DEFAULT_ECG_Y_MIN_MV}
                  yMax={DEFAULT_ECG_Y_MAX_MV}
                />
                <LiveWaveformCanvas
                  title="CH4"
                  samples={playback.channels.CH4}
                  sampleRateHz={data.sample_rate_hz}
                  yMin={DEFAULT_ECG_Y_MIN_MV}
                  yMax={DEFAULT_ECG_Y_MAX_MV}
                />
              </div>
              <div className="live-vector-panel">
                <LiveVector3DCanvas
                  xSamples={playback.channels.CH2}
                  ySamples={playback.channels.CH4}
                  zSamples={playback.channels.CH3}
                  yMin={DEFAULT_ECG_Y_MIN_MV}
                  yMax={DEFAULT_ECG_Y_MAX_MV}
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
  return <ReviewPage currentPath={pathname} />;
}
