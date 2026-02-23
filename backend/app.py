import base64
import json
import logging
import os
import warnings
from math import sqrt
from typing import Any, Dict, List, Optional, Union
from uuid import uuid4

from dotenv import load_dotenv
import httpx
import neurokit2 as nk
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

load_dotenv()

app = FastAPI()

logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s %(message)s",
)
logger = logging.getLogger("ecg-backend")

DEFAULT_BASE_URL = "http://127.0.0.1:8001"
BASE_URL = os.getenv("BASE_URL") or DEFAULT_BASE_URL

LAST_CALIBRATION_SAMPLES = []
LAST_CALIBRATION_META = {
    "byte_length": 0,
    "sample_count": 0,
}

ANALYSIS_JOBS: Dict[str, Dict[str, Any]] = {}
LAST_ANALYSIS_PLOT: Dict[str, Any] = {
    "calibration": None,
    "session": None,
}


def _get_supabase_config() -> Dict[str, str]:
    url = os.getenv("EXPO_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    key = (
        os.getenv("EXPO_PUBLIC_SUPABASE_ANON_KEY")
        or os.getenv("SUPABASE_ANON_KEY")
    )
    bucket = (
        os.getenv("EXPO_PUBLIC_SUPABASE_STORAGE_BUCKET")
        or os.getenv("SUPABASE_STORAGE_BUCKET")
    )
    if not url or not key:
        raise HTTPException(
            status_code=500,
            detail="Missing Supabase env vars: EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.",
        )
    if not bucket:
        raise HTTPException(
            status_code=500,
            detail="Missing Supabase env var: EXPO_PUBLIC_SUPABASE_STORAGE_BUCKET.",
        )
    return {"url": url, "key": key, "bucket": bucket}


def _fetch_recording_by_id(record_id: str) -> Dict[str, Any]:
    config = _get_supabase_config()
    logger.info("[FETCH] start record_id=%s", record_id)
    select_fields = ",".join(
        [
            "id",
            "user_id",
            "bucket",
            "session_object_key",
            "calibration_object_key",
            "encoding",
            "sample_rate_hz",
            "channels",
            "sample_count",
            "duration_ms",
            "byte_length",
            "created_at",
        ]
    )
    url = f"{config['url']}/rest/v1/ecg_recordings"
    params = {
        "id": f"eq.{record_id}",
        "select": select_fields,
    }
    headers = {
        "apikey": config["key"],
        "Authorization": f"Bearer {config['key']}",
        "Accept": "application/json",
    }
    try:
        with httpx.Client(timeout=30) as client:
            response = client.get(url, headers=headers, params=params)
            response.raise_for_status()
            data = response.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Supabase REST error: {exc.response.status_code} {exc.response.text}",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Supabase REST unreachable: {exc}",
        ) from exc

    if not data:
        logger.warning("[FETCH] not_found record_id=%s", record_id)
        raise HTTPException(status_code=404, detail="Recording not found.")
    logger.info("[FETCH] success record_id=%s", record_id)
    return data[0]


def _fetch_storage_bytes(object_key: str) -> bytes:
    config = _get_supabase_config()
    url = f"{config['url']}/storage/v1/object/{config['bucket']}/{object_key}"
    headers = {
        "apikey": config["key"],
        "Authorization": f"Bearer {config['key']}",
    }
    logger.info("[FETCH] storage object_key=%s", object_key)
    try:
        with httpx.Client(timeout=60) as client:
            response = client.get(url, headers=headers)
            response.raise_for_status()
            return response.content
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Supabase Storage error: {exc.response.status_code} {exc.response.text}",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Supabase Storage unreachable: {exc}",
        ) from exc


def _decode_int16_le(payload: bytes) -> List[int]:
    if len(payload) % 2 != 0:
        logger.warning("[DECODE] odd byte count len=%s", len(payload))
    sample_count = len(payload) // 2
    return [
        int.from_bytes(payload[i : i + 2], "little", signed=True)
        for i in range(0, sample_count * 2, 2)
    ]


def _decimate(samples: List[int], max_points: int = 2000) -> List[int]:
    if not samples:
        return []
    if len(samples) <= max_points:
        return samples
    step = max(1, len(samples) // max_points)
    return samples[::step]


def _compute_window_qualities(
    samples: List[int],
    sample_rate_hz: int,
    window_seconds: int = 20,
) -> List[Dict[str, Any]]:
    window_size = sample_rate_hz * window_seconds
    if window_size <= 0:
        return []
    window_count = len(samples) // window_size
    qualities: List[Dict[str, Any]] = []
    for index in range(window_count):
        start = index * window_size
        end = start + window_size
        window = samples[start:end]
        quality_value = None
        try:
            with warnings.catch_warnings():
                try:
                    from pandas.errors import ChainedAssignmentError
                except Exception:  # pragma: no cover - pandas compatibility
                    ChainedAssignmentError = Warning  # type: ignore
                warnings.filterwarnings("ignore", category=ChainedAssignmentError)
                warnings.filterwarnings(
                    "ignore",
                    message=".*ChainedAssignmentError.*",
                )
                cleaned = nk.ecg_clean(window, sampling_rate=sample_rate_hz)
                quality = nk.ecg_quality(
                    cleaned,
                    sampling_rate=sample_rate_hz,
                    method="averageQRS",
                )
            if hasattr(quality, "__len__") and len(quality) > 0:
                quality_value = float(sum(quality) / len(quality))
        except Exception as exc:  # pragma: no cover - safeguard
            logger.error(
                "[QUALITY] window_failed index=%s error=%s",
                index,
                exc,
            )
        qualities.append(
            {
                "index": index,
                "start_index": start,
                "end_index": end,
                "start_sec": index * window_seconds,
                "end_sec": (index + 1) * window_seconds,
                "quality": quality_value,
            }
        )
    return qualities


def _select_top_windows(
    samples: List[int],
    qualities: List[Dict[str, Any]],
    top_k: int = 3,
    max_points: int = 800,
) -> List[Dict[str, Any]]:
    ranked = [
        item for item in qualities if item.get("quality") is not None
    ]
    ranked.sort(key=lambda item: float(item["quality"]), reverse=True)
    selected = ranked[:top_k]
    results: List[Dict[str, Any]] = []
    for item in selected:
        start = int(item["start_index"])
        end = int(item["end_index"])
        window = samples[start:end]
        results.append(
            {
                "start_index": start,
                "end_index": end,
                "quality": item["quality"],
                "data": _decimate(window, max_points=max_points),
            }
        )
    return results


def _set_job(job_id: str, **fields: Any) -> None:
    job = ANALYSIS_JOBS.get(job_id, {})
    job.update(fields)
    ANALYSIS_JOBS[job_id] = job


# ----------------------------
# Placeholder data models
# ----------------------------
class SessionAnalysisRequest(BaseModel):
    """
    Placeholder request for session analysis.
    Preferred input is storage object keys (large signals should not be sent inline).
    """

    user_id: str = Field(..., description="User identifier (email string).")
    session_object_key: str = Field(
        ..., description="Supabase Storage key for the session .bin file."
    )
    calibration_object_key: str = Field(
        ..., description="Supabase Storage key for the calibration .bin file."
    )
    sample_rate_hz: int = Field(500, description="Sampling rate in Hz.")
    channels: int = Field(1, description="Number of signal channels.")
    window_seconds: int = Field(20, description="Window length in seconds.")
    # Optional: if you ever want to send raw data instead of object keys.
    # raw_signal_base64: Optional[str] = Field(
    #     None, description="Raw session bytes (base64). Avoid for large payloads."
    # )

class SessionAnalysisStartRequest(BaseModel):
    record_id: str = Field(..., description="Supabase ecg_recordings.id")


class SessionAnalysisJob(BaseModel):
    job_id: str
    status: str
    record_id: str
    details: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class CleanWindow(BaseModel):
    start_index: int
    end_index: int
    duration_ms: int
    score: float
    reason: Optional[str] = None


class HeartMetrics(BaseModel):
    average_hr_bpm: Optional[float] = None
    min_hr_bpm: Optional[float] = None
    max_hr_bpm: Optional[float] = None
    hrv_ms: Optional[float] = None
    pr_interval_ms: Optional[float] = None
    qrs_duration_ms: Optional[float] = None
    qt_interval_ms: Optional[float] = None


class Insight(BaseModel):
    type: str
    title: str
    detail: str


class SessionAnalysisResponse(BaseModel):
    clean_windows: List[CleanWindow]
    metrics: HeartMetrics
    insights: List[Insight]
    summary: str
    calibration_comparison: Optional["CalibrationComparison"] = None


class CalibrationComparison(BaseModel):
    """
    Placeholder for advanced comparison between resting (calibration)
    and exercise (session) ECG signals.
    """

    overall_score: float
    deviations: List[str]
    morphology_changes: List[str]
    timing_shifts_ms: Dict[str, float]
    anomaly_flags: List[str]
    notes: Optional[str] = None


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok", "base_url": BASE_URL}



@app.post("/calibration_signal_quality_check")
async def calibration_signal_quality_check(
    request: Request,
) -> Dict[str, Union[float, bool]]:
    data = await request.body()
    byte_length = len(data)
    sample_count = byte_length // 2
    remainder = byte_length % 2

    decoded_samples = [
        int.from_bytes(data[i : i + 2], "little", signed=True)
        for i in range(0, sample_count * 2, 2)
    ]
    request_dump = {
        "method": request.method,
        "url": str(request.url),
        "headers": dict(request.headers),
        "byte_length": byte_length,
        "samples": decoded_samples,
    }
    dump_path = os.path.join(os.path.dirname(__file__), "calibration_request.json")
    with open(dump_path, "w", encoding="utf-8") as handle:
        json.dump(request_dump, handle, indent=2)

    print("[CALIBRATION] Received calibration signal")
    print(f"[CALIBRATION] byte_length={byte_length} sample_count={sample_count}")
    if remainder:
        print(f"[CALIBRATION] WARNING: odd byte count (remainder={remainder})")

    if sample_count == 0:
        print("[CALIBRATION] No samples received -> quality=0, suitable=False")
        LAST_CALIBRATION_SAMPLES.clear()
        LAST_CALIBRATION_META["byte_length"] = 0
        LAST_CALIBRATION_META["sample_count"] = 0
        return {"quality_percentage": 0.0, "signal_suitable": False}

    sum_sq = 0.0
    samples = []
    min_val = None
    max_val = None
    for i in range(0, sample_count * 2, 2):
        value = int.from_bytes(data[i : i + 2], "little", signed=True)
        sum_sq += float(value * value)
        samples.append(value)
        if min_val is None or value < min_val:
            min_val = value
        if max_val is None or value > max_val:
            max_val = value

    rms = sqrt(sum_sq / sample_count)
    quality = max(0.0, min(100.0, (rms / 1000.0) * 100.0))
    signal_suitable = quality >= 70.0

    LAST_CALIBRATION_SAMPLES.clear()
    LAST_CALIBRATION_SAMPLES.extend(samples)
    LAST_CALIBRATION_META["byte_length"] = byte_length
    LAST_CALIBRATION_META["sample_count"] = sample_count

    print(
        "[CALIBRATION] Computation details:"
        f" min={min_val} max={max_val} rms={rms:.2f}"
    )
    print(
        "[CALIBRATION] Quality mapping:"
        f" quality_percentage={quality:.2f} threshold=70.0"
    )
    print(
        "[CALIBRATION] Result:"
        f" signal_suitable={signal_suitable}"
    )

    return {
        "quality_percentage": 100, #round(quality, 2),
        "signal_suitable": True #signal_suitable,
    }


@app.post("/session_signal_quality_check")
async def session_signal_quality_check(
    request: Request,
) -> Dict[str, Union[float, bool]]:
    data = await request.body()
    byte_length = len(data)
    sample_count = byte_length // 2
    remainder = byte_length % 2

    decoded_samples = [
        int.from_bytes(data[i : i + 2], "little", signed=True)
        for i in range(0, sample_count * 2, 2)
    ]
    request_dump = {
        "method": request.method,
        "url": str(request.url),
        "headers": dict(request.headers),
        "byte_length": byte_length,
        "samples": decoded_samples,
    }
    dump_path = os.path.join(os.path.dirname(__file__), "session_request.json")
    with open(dump_path, "w", encoding="utf-8") as handle:
        json.dump(request_dump, handle, indent=2)

    print("[SESSION] Received session signal")
    print(f"[SESSION] byte_length={byte_length} sample_count={sample_count}")
    if remainder:
        print(f"[SESSION] WARNING: odd byte count (remainder={remainder})")

    if sample_count == 0:
        print("[SESSION] No samples received -> quality=0, suitable=False")
        return {"quality_percentage": 0.0, "signal_suitable": False}

    sum_sq = 0.0
    min_val = None
    max_val = None
    for value in decoded_samples:
        sum_sq += float(value * value)
        if min_val is None or value < min_val:
            min_val = value
        if max_val is None or value > max_val:
            max_val = value

    rms = sqrt(sum_sq / sample_count)
    quality = max(0.0, min(100.0, (rms / 1000.0) * 100.0))
    signal_suitable = quality >= 70.0

    print(
        "[SESSION] Computation details:"
        f" min={min_val} max={max_val} rms={rms:.2f}"
    )
    print(
        "[SESSION] Quality mapping:"
        f" quality_percentage={quality:.2f} threshold=70.0"
    )
    print(
        "[SESSION] Result:"
        f" signal_suitable={signal_suitable}"
    )

    return {
        "quality_percentage": round(quality, 2),
        "signal_suitable": signal_suitable,
    }

def _session_analysis_job(job_id: str, record_id: str) -> None:
    logger.info("[JOB] start job_id=%s record_id=%s", job_id, record_id)
    _set_job(job_id, status="running")
    try:
        record = _fetch_recording_by_id(record_id)
        _set_job(job_id, status="fetched", details=record)
        logger.info(
            "[JOB] fetched job_id=%s record_id=%s session_object_key=%s calibration_object_key=%s",
            job_id,
            record_id,
            record.get("session_object_key"),
            record.get("calibration_object_key"),
        )

        session_key = record.get("session_object_key")
        calibration_key = record.get("calibration_object_key")
        bucket = record.get("bucket") or _get_supabase_config()["bucket"]
        if not session_key or not calibration_key:
            raise HTTPException(
                status_code=400,
                detail="Missing session_object_key or calibration_object_key in record.",
            )

        session_bytes = _fetch_storage_bytes(session_key)
        calibration_bytes = _fetch_storage_bytes(calibration_key)
        session_samples = _decode_int16_le(session_bytes)
        calibration_samples = _decode_int16_le(calibration_bytes)
        sample_rate_hz = int(record.get("sample_rate_hz") or 500)

        quality_windows = _compute_window_qualities(
            session_samples,
            sample_rate_hz=sample_rate_hz,
            window_seconds=20,
        )
        best_windows = _select_top_windows(
            session_samples,
            quality_windows,
            top_k=3,
            max_points=800,
        )

        LAST_ANALYSIS_PLOT["session"] = {
            "object_key": session_key,
            "bucket": bucket,
            "byte_length": len(session_bytes),
            "sample_count": len(session_samples),
            "data": _decimate(session_samples),
            "best_windows": best_windows,
        }
        LAST_ANALYSIS_PLOT["calibration"] = {
            "object_key": calibration_key,
            "bucket": bucket,
            "byte_length": len(calibration_bytes),
            "sample_count": len(calibration_samples),
            "data": _decimate(calibration_samples),
        }

        _set_job(job_id, status="decoded")
        logger.info(
            "[JOB] decoded job_id=%s session_samples=%s calibration_samples=%s",
            job_id,
            len(session_samples),
            len(calibration_samples),
        )
        logger.info(
            "[JOB] best_windows job_id=%s count=%s",
            job_id,
            len(best_windows),
        )
    except HTTPException as exc:
        _set_job(job_id, status="error", error=exc.detail)
        logger.error(
            "[JOB] error job_id=%s record_id=%s detail=%s",
            job_id,
            record_id,
            exc.detail,
        )
    except Exception as exc:  # pragma: no cover - safeguard
        _set_job(job_id, status="error", error=str(exc))
        logger.exception(
            "[JOB] unexpected_error job_id=%s record_id=%s",
            job_id,
            record_id,
        )


@app.post("/session_analysis/start", response_model=SessionAnalysisJob)
async def session_analysis_start(
    payload: SessionAnalysisStartRequest,
    background_tasks: BackgroundTasks,
    request: Request,
) -> SessionAnalysisJob:
    job_id = uuid4().hex
    _set_job(job_id, status="queued", record_id=payload.record_id)
    background_tasks.add_task(_session_analysis_job, job_id, payload.record_id)
    logger.info(
        "[API] %s record_id=%s job_id=%s",
        request.url.path,
        payload.record_id,
        job_id,
    )
    return SessionAnalysisJob(
        job_id=job_id,
        status="queued",
        record_id=payload.record_id,
    )


@app.get("/session_analysis/status/{job_id}", response_model=SessionAnalysisJob)
async def session_analysis_status(job_id: str) -> SessionAnalysisJob:
    job = ANALYSIS_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    logger.info(
        "[API] /session_analysis/status record_id=%s job_id=%s status=%s",
        job.get("record_id", ""),
        job_id,
        job.get("status", "unknown"),
    )
    return SessionAnalysisJob(
        job_id=job_id,
        status=job.get("status", "unknown"),
        record_id=job.get("record_id", ""),
        details=job.get("details"),
        error=job.get("error"),
    )


# ----------------------------
# Placeholder analysis endpoints
# ----------------------------
@app.post("/session_analysis", response_model=SessionAnalysisResponse)
async def session_analysis(payload: SessionAnalysisRequest) -> SessionAnalysisResponse:
    """
    Placeholder endpoint for full session analysis pipeline:
    1) Load session + calibration signals (by object keys)
    2) Find clean 20s windows
    3) Compare windows to calibration (advanced morphology + timing analysis)
    4) Compute heart metrics
    5) Produce insights + summary
    """

    # TODO: Load binary data from storage using object keys.
    # TODO: Segment into windows and score for signal quality.
    # TODO: Compare selected windows against calibration template.
    # TODO: Compute metrics and insights.

    return SessionAnalysisResponse(
        clean_windows=[
            CleanWindow(
                start_index=0,
                end_index=payload.sample_rate_hz * payload.window_seconds,
                duration_ms=payload.window_seconds * 1000,
                score=0.0,
                reason="placeholder",
            )
        ],
        metrics=HeartMetrics(),
        insights=[
            Insight(
                type="info",
                title="Placeholder",
                detail="Session analysis not implemented yet.",
            )
        ],
        summary="Placeholder response. Analysis pipeline not implemented.",
        calibration_comparison=CalibrationComparison(
            overall_score=0.0,
            deviations=["placeholder"],
            morphology_changes=["placeholder"],
            timing_shifts_ms={"pr": 0.0, "qrs": 0.0, "qt": 0.0},
            anomaly_flags=["placeholder"],
            notes="Detailed comparison not implemented.",
        ),
    )


@app.post("/session_find_clean_windows", response_model=List[CleanWindow])
async def session_find_clean_windows(
    payload: SessionAnalysisRequest,
) -> List[CleanWindow]:
    """
    Placeholder endpoint: identify clean 20s windows from session signal.
    Input should include session_object_key and sampling metadata.
    """
    return [
        CleanWindow(
            start_index=0,
            end_index=payload.sample_rate_hz * payload.window_seconds,
            duration_ms=payload.window_seconds * 1000,
            score=0.0,
            reason="placeholder",
        )
    ]


@app.post("/session_compare_to_calibration", response_model=CalibrationComparison)
async def session_compare_to_calibration(
    payload: SessionAnalysisRequest,
) -> CalibrationComparison:
    """
    Placeholder endpoint: compare clean windows against calibration signal.
    This is the core of the project: detect subtle deviations between
    resting (calibration) and exercise (session) ECG signals that are
    not visible via standard 12-lead ECG snapshots.
    """
    return CalibrationComparison(
        overall_score=0.0,
        deviations=["placeholder"],
        morphology_changes=["placeholder"],
        timing_shifts_ms={"pr": 0.0, "qrs": 0.0, "qt": 0.0},
        anomaly_flags=["placeholder"],
        notes="Advanced comparison not implemented.",
    )


@app.post("/session_metrics", response_model=HeartMetrics)
async def session_metrics(payload: SessionAnalysisRequest) -> HeartMetrics:
    """
    Placeholder endpoint: compute heart metrics from selected clean windows.
    """
    return HeartMetrics()


@app.post("/session_insights", response_model=List[Insight])
async def session_insights(payload: SessionAnalysisRequest) -> List[Insight]:
    """
    Placeholder endpoint: compute insights based on metrics and comparison.
    """
    return [
        Insight(
            type="info",
            title="Placeholder",
            detail="Insights not implemented.",
        )
    ]


@app.get("/", response_class=HTMLResponse)
def root() -> str:
    calibration_plot = LAST_ANALYSIS_PLOT.get("calibration")
    session_plot = LAST_ANALYSIS_PLOT.get("session")

    has_calibration = bool(calibration_plot and calibration_plot.get("data"))
    has_session = bool(session_plot and session_plot.get("data"))
    has_best_windows = bool(session_plot and session_plot.get("best_windows"))
    best_windows = session_plot.get("best_windows") if session_plot else []
    best_windows_html = "".join(
        [
            (
                f"<div class='meta'>Window {i + 1}: samples "
                f"{item['start_index']}-{item['end_index']}</div>"
                f"<canvas class='mini-canvas' id='window-{i}' "
                f"width='360' height='160'></canvas>"
            )
            for i, item in enumerate(best_windows)
        ]
    )

    return f"""<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>ECG Session Verification</title>
    <style>
      body {{ font-family: Arial, sans-serif; padding: 16px; background: #0b0b0b; color: #e5e5e5; }}
      .meta {{ margin-bottom: 12px; color: #a3a3a3; }}
      canvas {{ background: #111827; border: 1px solid #1f2937; }}
      .panel {{ margin-bottom: 24px; }}
      .layout {{ display: flex; gap: 24px; align-items: flex-start; }}
      .left {{ flex: 2; min-width: 0; }}
      .right {{ flex: 1; min-width: 280px; }}
      .mini-canvas {{ width: 100%; height: 160px; }}
    </style>
  </head>
  <body>
    <h1>ECG Session Verification</h1>
    {"<div>No analysis data received yet.</div>" if not (has_calibration or has_session) else ""}

    <div class="layout">
      <div class="left">
        <div class="panel">
      <h2>Calibration Signal</h2>
      <div class="meta">filepath={(calibration_plot["bucket"] + "/" + calibration_plot["object_key"]) if calibration_plot else "n/a"}</div>
      <div class="meta">byte_length={calibration_plot["byte_length"] if calibration_plot else 0} | sample_count={calibration_plot["sample_count"] if calibration_plot else 0}</div>
      {"<div>No calibration data received yet.</div>" if not has_calibration else ""}
      <canvas id="calibration" width="1200" height="300"></canvas>
    </div>

    <div class="panel">
      <h2>Session Signal</h2>
      <div class="meta">filepath={(session_plot["bucket"] + "/" + session_plot["object_key"]) if session_plot else "n/a"}</div>
      <div class="meta">byte_length={session_plot["byte_length"] if session_plot else 0} | sample_count={session_plot["sample_count"] if session_plot else 0}</div>
      {"<div>No session data received yet.</div>" if not has_session else ""}
      <canvas id="session" width="1200" height="300"></canvas>
    </div>
      </div>

      <div class="right">
        <div class="panel">
          <h2>Top 3 Windows (20s)</h2>
          {"<div>No top windows computed yet.</div>" if not has_best_windows else ""}
          {best_windows_html}
        </div>
      </div>
    </div>
    <script>
      const calibrationData = {calibration_plot["data"] if calibration_plot else []};
      const sessionData = {session_plot["data"] if session_plot else []};
      const bestWindows = {best_windows};

      function drawSignal(canvasId, data, color) {{
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!data || data.length === 0) {{
          ctx.fillStyle = "#9ca3af";
          ctx.fillText("No data", 10, 20);
          return;
        }}

        let maxAbs = 0;
        for (const v of data) maxAbs = Math.max(maxAbs, Math.abs(v));
        const scale = maxAbs || 1;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        const mid = canvas.height / 2;
        const stepX = canvas.width / (data.length - 1);

        ctx.beginPath();
        for (let i = 0; i < data.length; i++) {{
          const x = i * stepX;
          const y = mid - (data[i] / scale) * mid;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }}
        ctx.stroke();
      }}

      drawSignal("calibration", calibrationData, "#22c55e");
      drawSignal("session", sessionData, "#38bdf8");

      for (let i = 0; i < bestWindows.length; i += 1) {{
        const data = bestWindows[i]?.data ?? [];
        drawSignal("window-" + i, data, "#f59e0b");
      }}
    </script>
  </body>
</html>"""
