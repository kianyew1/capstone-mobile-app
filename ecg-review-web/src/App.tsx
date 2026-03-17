import { useEffect, useMemo, useState } from "react";

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

type LiveMarkers = {
  P: number[];
  Q: number[];
  R: number[];
  S: number[];
  T: number[];
};

type LiveResponse = {
  record_id: string;
  session_id: string | null;
  status: "active" | "ended" | "missing";
  channel: "CH2";
  updated_at: string;
  ended_at: string | null;
  total_packets_buffered: number;
  samples_analyzed: number;
  window_seconds: number;
  quality_percentage: number;
  signal_ok: boolean;
  abnormal_detected: boolean;
  reason_codes: string[];
  heart_rate_bpm: number | null;
  signal: {
    full: number[];
    r_peaks: number[];
  };
  markers: LiveMarkers;
  interval_related: ReviewIntervalRow | null;
};

const CHANNELS = ["CH2", "CH3", "CH4"] as const;
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
const LIVE_MARKER_COLORS: Record<keyof LiveMarkers, string> = {
  P: "#1f7aec",
  Q: "#9a3412",
  R: "#b91c1c",
  S: "#0f766e",
  T: "#6d28d9",
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
): { path: string; min: number; max: number } {
  if (points.length === 0) {
    return { path: "", min: 0, max: 0 };
  }
  let min = points[0];
  let max = points[0];
  for (let index = 1; index < points.length; index += 1) {
    const value = points[index];
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
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

function getBeatSamples(fullSignal: number[], beat: ReviewBeat | null): number[] {
  if (!beat) {
    return [];
  }
  return fullSignal.slice(Math.max(0, beat.start_sample - 1), Math.max(0, beat.end_sample));
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
  highlightStart,
  highlightEnd,
  subtitle,
}: {
  title: string;
  samples: number[];
  sampleRateHz: number;
  highlightStart?: number | null;
  highlightEnd?: number | null;
  subtitle?: string;
}) {
  const width = 860;
  const height = 320;
  const { path } = useMemo(() => createPath(samples, width, height), [samples]);
  const step = Math.max(1, Math.floor(samples.length / 8));
  const hasHighlight =
    highlightStart !== undefined &&
    highlightStart !== null &&
    highlightEnd !== undefined &&
    highlightEnd !== null &&
    highlightEnd > highlightStart &&
    samples.length > 0;
  const highlightX = hasHighlight ? (highlightStart / Math.max(samples.length - 1, 1)) * width : 0;
  const highlightWidth = hasHighlight
    ? ((highlightEnd - highlightStart) / Math.max(samples.length - 1, 1)) * width
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
      <svg viewBox={`0 0 ${width} ${height + 28}`} className="signal-chart">
        {Array.from({ length: 9 }, (_, index) => {
          const x = (width / 8) * index;
          return (
            <g key={`grid-${index}`}>
              <line x1={x} y1={0} x2={x} y2={height} className="grid-line" />
              <text x={x + 4} y={height + 18} className="axis-label">
                {((index * step) / sampleRateHz).toFixed(1)}s
              </text>
            </g>
          );
        })}
        {Array.from({ length: 5 }, (_, index) => {
          const y = (height / 4) * index;
          return <line key={`hgrid-${index}`} x1={0} y1={y} x2={width} y2={y} className="grid-line" />;
        })}
        {hasHighlight ? (
          <rect
            x={highlightX}
            y={0}
            width={Math.max(highlightWidth, 3)}
            height={height}
            className="highlight-window"
          />
        ) : null}
        <path d={path} className="signal-path" />
      </svg>
    </div>
  );
}

function LiveSignalChart({
  samples,
  markers,
  sampleRateHz,
}: {
  samples: number[];
  markers: LiveMarkers;
  sampleRateHz: number;
}) {
  const width = 980;
  const height = 360;
  const { path, min, max } = useMemo(() => createPath(samples, width, height), [samples]);
  const span = max - min || 1;
  const step = Math.max(1, Math.floor(samples.length / 8));
  const pointToY = (value: number) => height - ((value - min) / span) * height;
  const pointToX = (index: number) => (samples.length > 1 ? (index / (samples.length - 1)) * width : 0);

  return (
    <div className="chart-card live-chart-card">
      <div className="card-header">
        <h3>Rolling Session Buffer</h3>
        <span>{samples.length} samples</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height + 28}`} className="signal-chart live-chart">
        {Array.from({ length: 9 }, (_, index) => {
          const x = (width / 8) * index;
          return (
            <g key={`live-grid-${index}`}>
              <line x1={x} y1={0} x2={x} y2={height} className="grid-line" />
              <text x={x + 4} y={height + 18} className="axis-label">
                {((index * step) / sampleRateHz).toFixed(1)}s
              </text>
            </g>
          );
        })}
        {Array.from({ length: 5 }, (_, index) => {
          const y = (height / 4) * index;
          return <line key={`live-hgrid-${index}`} x1={0} y1={y} x2={width} y2={y} className="grid-line" />;
        })}
        <path d={path} className="signal-path live-path" />
        {(Object.entries(markers) as Array<[keyof LiveMarkers, number[]]>).map(([label, positions]) =>
          positions.map((position, idx) => (
            <g key={`${label}-${position}-${idx}`}>
              <line
                x1={pointToX(position)}
                y1={0}
                x2={pointToX(position)}
                y2={height}
                className="marker-line"
                style={{ stroke: LIVE_MARKER_COLORS[label] }}
              />
              <text
                x={pointToX(position) + 5}
                y={Math.max(12, pointToY(samples[position] ?? 0) - 6)}
                className="marker-label"
              >
                {label}
              </text>
            </g>
          )),
        )}
      </svg>
      <div className="marker-legend">
        {(["P", "Q", "R", "S", "T"] as Array<keyof LiveMarkers>).map((label) => (
          <span key={label} className="legend-pill">
            <span className="legend-dot" style={{ backgroundColor: LIVE_MARKER_COLORS[label] }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

function BeatChart({
  title,
  beat,
  samples,
  beatCount,
}: {
  title: string;
  beat: ReviewBeat | null;
  samples: number[];
  beatCount: number;
}) {
  const width = 420;
  const height = 240;
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

  const { path, min, max } = createPath(samples, width, height);
  const span = max - min || 1;
  const pointToY = (value: number) => height - ((value - min) / span) * height;

  return (
    <div className="chart-card beat-card">
      <div className="card-header">
        <h3>{title}</h3>
        <div className="beat-header-meta">
          <span>{beatCounterText}</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="beat-chart">
        {Array.from({ length: 5 }, (_, index) => {
          const y = (height / 4) * index;
          return <line key={`beat-grid-${index}`} x1={0} y1={y} x2={width} y2={y} className="grid-line" />;
        })}
        {isExcluded ? (
          <g>
            <rect x={0} y={0} width={width} height={height} className="excluded-overlay" />
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
        <path d={path} className="signal-path beat-path" />
        {(Object.entries(beat.markers) as Array<[keyof BeatMarkers, number[]]>).map(([label, positions]) =>
          positions.map((position, idx) => {
            const x = samples.length > 1 ? (position / (samples.length - 1)) * width : 0;
            const y = pointToY(samples[position] ?? 0);
            return (
              <g key={`${label}-${idx}-${position}`}>
                <line
                  x1={x}
                  y1={0}
                  x2={x}
                  y2={height}
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

function ReviewSectionCard({
  title,
  section,
  sampleRateHz,
  beatIndex,
  onBeatIndexChange,
}: {
  title: string;
  section: ReviewSection;
  sampleRateHz: number;
  beatIndex: number;
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
  onBeatIndexChange,
}: {
  section: ReviewSection;
  sampleRateHz: number;
  beatIndex: number;
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
            highlightStart={highlightStart}
            highlightEnd={highlightEnd}
            subtitle={`Samples ${displayWindowStart}-${displayWindowEnd} | Window ${beat?.window_index ?? 1} of ${section.window_count}`}
          />
        </div>
        <div className="beat-column">
          <BeatChart title="Session Heartbeat" beat={beat} samples={beatSamples} beatCount={section.beats.count} />
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
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>("CH2");
  const [data, setData] = useState<ReviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [calibrationBeat, setCalibrationBeat] = useState(1);
  const [sessionBeat, setSessionBeat] = useState(1);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError(null);
      const url = `/api/review/latest?channel=${channel}`;
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
  }, [channel]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <TopNav currentPath={currentPath} />
          <p className="eyebrow">ECG Review Workspace</p>
          <h1>Calibration and Session Review</h1>
          <p className="subtitle">NeuroKit2-backed signal review for calibration and exercise session traces.</p>
        </div>
        <label className="channel-select">
          <span>Channel</span>
          <select value={channel} onChange={(event) => setChannel(event.target.value as (typeof CHANNELS)[number])}>
            {CHANNELS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      </header>

      {loading && <div className="status-panel">Loading review data...</div>}
      {error && <div className="status-panel error">{error}</div>}

      {!loading && !error && data && (
        <div className="content-stack">
          <div className="record-meta">
            <span>Record ID: {data.record_id}</span>
            <span>Channel: {data.channel}</span>
            <span>Sample Rate: {data.sample_rate_hz} Hz</span>
          </div>
          <ReviewSectionCard
            title="Calibration Signal"
            section={data.calibration}
            sampleRateHz={data.sample_rate_hz}
            beatIndex={calibrationBeat}
            onBeatIndexChange={setCalibrationBeat}
          />
          <SessionReviewCard
            section={data.session}
            sampleRateHz={data.sample_rate_hz}
            beatIndex={sessionBeat}
            onBeatIndexChange={setSessionBeat}
          />
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
  const [data, setData] = useState<LiveResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pollingStopped, setPollingStopped] = useState(false);

  useEffect(() => {
    let active = true;
    let intervalId: number | undefined;
    let stopped = false;

    async function load() {
      const query = recordId ? `?record_id=${encodeURIComponent(recordId)}` : "";
      const url = `/api/session/live${query}`;
      console.log(`[LIVE] GET ${url}`);
      try {
        const response = await fetch(url);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Live session fetch failed: ${response.status} ${text}`);
        }
        const payload = (await response.json()) as LiveResponse;
        console.log(
          `[LIVE] response recordId=${payload.record_id} status=${payload.status} samples=${payload.samples_analyzed} quality=${payload.quality_percentage.toFixed(2)} abnormal=${payload.abnormal_detected}`,
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
    }, 2000);

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
    setLoading(true);
    setPollingStopped(false);
  };

  return (
    <main className="app-shell live-shell">
      <header className="topbar live-topbar">
        <div>
          <TopNav currentPath={currentPath} />
          <p className="eyebrow">Live Session Monitor</p>
          <h1>Rolling Session Quality</h1>
          <p className="subtitle">CH2 rolling buffer, PQRST peak delineation, and interval metrics from the backend live session state.</p>
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

      {!loading && !error && data && (
        <div className="content-stack">
          <div className="record-meta">
            <span>Record ID: {data.record_id}</span>
            <span>Session ID: {data.session_id ?? "n/a"}</span>
            <span>Status: {data.status}</span>
            <span>Channel: {data.channel}</span>
            <span>Updated: {new Date(data.updated_at).toLocaleString()}</span>
            {data.ended_at ? <span>Ended: {new Date(data.ended_at).toLocaleString()}</span> : null}
          </div>
          {pollingStopped ? (
            <div className="status-panel">Live polling stopped because the session has ended.</div>
          ) : null}
          <section className="review-section live-section">
            <div className="live-layout">
              <LiveSignalChart samples={data.signal.full} markers={data.markers} sampleRateHz={500} />
              <aside className="metrics-sidebar">
                <div className="interval-card">
                  <div className="card-header">
                    <h3>Live Status</h3>
                  </div>
                  <div className="metrics-stack">
                    <div className="summary-metric"><span>Packets Buffered</span><strong>{data.total_packets_buffered}</strong></div>
                    <div className="summary-metric"><span>Samples Analyzed</span><strong>{data.samples_analyzed}</strong></div>
                    <div className="summary-metric"><span>Window</span><strong>{data.window_seconds.toFixed(2)} s</strong></div>
                    <div className="summary-metric"><span>Quality</span><strong>{data.quality_percentage.toFixed(2)}%</strong></div>
                    <div className="summary-metric"><span>Signal OK</span><strong>{data.signal_ok ? "yes" : "no"}</strong></div>
                    <div className="summary-metric"><span>Abnormal</span><strong>{data.abnormal_detected ? "yes" : "no"}</strong></div>
                    <div className="summary-metric"><span>Heart Rate</span><strong>{formatMetric(data.heart_rate_bpm, " bpm")}</strong></div>
                    <div className="summary-metric reasons-metric">
                      <span>Reason Codes</span>
                      <strong>{data.reason_codes.length > 0 ? data.reason_codes.join(", ") : "none"}</strong>
                    </div>
                  </div>
                </div>
                <div className="interval-card">
                  <div className="card-header">
                    <h3>Interval Metrics</h3>
                  </div>
                  <IntervalSummary row={data.interval_related} />
                </div>
              </aside>
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
