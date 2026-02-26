import base64
import io
import json
import logging
import os
import warnings
from math import sqrt
from typing import Any, Dict, List, Optional, Union
from uuid import uuid4

from dotenv import load_dotenv
import httpx
import matplotlib
import neurokit2 as nk
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

load_dotenv()
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

app = FastAPI()

logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s %(message)s",
)
logger = logging.getLogger("ecg-backend")

DEFAULT_BASE_URL = "http://127.0.0.1:8001"
BASE_URL = os.getenv("BASE_URL") or DEFAULT_BASE_URL
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

PACKET_BYTES = 228
SAMPLES_PER_PACKET = 25
CHANNEL_LABELS = ["CH2", "CH3", "CH4"]
ADS1298_VREF = 2.4
ADS1298_GAIN = 6.0
ADS1298_MAX_CODE = (2**23) - 1

LAST_CALIBRATION_SAMPLES = []
LAST_CALIBRATION_META = {
    "byte_length": 0,
    "sample_count": 0,
}

ANALYSIS_JOBS: Dict[str, Dict[str, Any]] = {}
LAST_ANALYSIS_PLOT: Dict[str, Any] = {
    "calibration": None,
    "session": None,
    "ecg_plots": {
        "calibration": None,
        "windows": [],
    },
    "record_id": None,
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


def _fetch_latest_recording_id() -> Optional[str]:
    config = _get_supabase_config()
    url = f"{config['url']}/rest/v1/ecg_recordings"
    params = {
        "select": "id,created_at",
        "order": "created_at.desc",
        "limit": 1,
    }
    headers = {
        "apikey": config["key"],
        "Authorization": f"Bearer {config['key']}",
        "Accept": "application/json",
    }
    try:
        with httpx.Client(timeout=15) as client:
            response = client.get(url, headers=headers, params=params)
            response.raise_for_status()
            data = response.json()
    except Exception as exc:  # pragma: no cover - safeguard
        logger.error("[FETCH] latest_record_failed error=%s", exc)
        return None
    if not data:
        return None
    return data[0].get("id")


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


def _read24_signed_be(payload: bytes, offset: int) -> int:
    value = (payload[offset] << 16) | (payload[offset + 1] << 8) | payload[offset + 2]
    if value & 0x800000:
        return value - (1 << 24)
    return value


def _counts_to_mv(count: int) -> float:
    return (count / ADS1298_MAX_CODE) * (ADS1298_VREF) * 1000.0


def _decode_ads1298_packets(payload: bytes) -> Dict[str, List[float]]:
    if len(payload) < PACKET_BYTES:
        return {label: [] for label in CHANNEL_LABELS}
    packet_count = len(payload) // PACKET_BYTES
    remainder = len(payload) % PACKET_BYTES
    if remainder != 0:
        logger.warning(
            "[DECODE] payload not multiple of packet bytes len=%s remainder=%s",
            len(payload),
            remainder,
        )
    channels: Dict[str, List[float]] = {label: [] for label in CHANNEL_LABELS}
    for p in range(packet_count):
        base = p * PACKET_BYTES
        offset = base + 3  # skip status
        for _ in range(SAMPLES_PER_PACKET):
            channels["CH2"].append(_counts_to_mv(_read24_signed_be(payload, offset)))
            offset += 3
        for _ in range(SAMPLES_PER_PACKET):
            channels["CH3"].append(_counts_to_mv(_read24_signed_be(payload, offset)))
            offset += 3
        for _ in range(SAMPLES_PER_PACKET):
            channels["CH4"].append(_counts_to_mv(_read24_signed_be(payload, offset)))
            offset += 3
    return channels


def _csv_path(filename: str) -> str:
    return os.path.join(REPO_ROOT, filename)


def _write_mv_csv(filename: str, samples: List[float]) -> int:
    path = _csv_path(filename)
    rows = ["index,value_mv"]
    for idx, value in enumerate(samples, start=1):
        rows.append(f"{idx},{value:.6f}")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(rows))
    return len(samples)


def _decimate(samples: List[int], max_points: int = 2000) -> List[int]:
    if not samples:
        return []
    if len(samples) <= max_points:
        return samples
    step = max(1, len(samples) // max_points)
    return samples[::step]


def _metrics_from_info(
    cleaned: List[float],
    info: Dict[str, Any],
    sample_rate_hz: int,
) -> Dict[str, Optional[float]]:
    metrics: Dict[str, Optional[float]] = {
        "avg_hr_bpm": None,
        "min_hr_bpm": None,
        "max_hr_bpm": None,
        "hrv_rmssd_ms": None,
        "hrv_sdnn_ms": None,
        "hrv_meannn_ms": None,
        "hrv_mediannn_ms": None,
        "hrv_min_nn_ms": None,
        "hrv_max_nn_ms": None,
        "hrv_pnn50_pct": None,
        "hrv_pnn20_pct": None,
        "hrv_cvnn_pct": None,
        "hrv_cvsd_pct": None,
        "hrv_sdrmssd": None,
        "hrv_iqrnn_ms": None,
        "hrv_lf_ms2": None,
        "hrv_hf_ms2": None,
        "hrv_vlf_ms2": None,
        "hrv_lf_hf_ratio": None,
        "hrv_lfnu": None,
        "hrv_hfnu": None,
        "hrv_total_power": None,
        "hrv_sd1": None,
        "hrv_sd2": None,
        "hrv_sd1_sd2": None,
        "hrv_sampen": None,
        "hrv_apen": None,
        "hrv_dfa_alpha1": None,
        "hrv_dfa_alpha2": None,
        "r_peak_count": None,
    }
    r_peaks = info.get("ECG_R_Peaks", [])
    metrics["r_peak_count"] = float(len(r_peaks)) if r_peaks is not None else 0.0
    if r_peaks is not None and len(r_peaks) > 1:
        rate = nk.ecg_rate(
            r_peaks,
            sampling_rate=sample_rate_hz,
            desired_length=len(cleaned),
        )
        if hasattr(rate, "__len__") and len(rate) > 0:
            metrics["avg_hr_bpm"] = float(sum(rate) / len(rate))
            metrics["min_hr_bpm"] = float(min(rate))
            metrics["max_hr_bpm"] = float(max(rate))
        hrv = nk.hrv_time(info, sampling_rate=sample_rate_hz)
        if not hrv.empty:
            row = hrv.iloc[0]
            metrics["hrv_rmssd_ms"] = float(row.get("RMSSD", None)) if "RMSSD" in row else None
            metrics["hrv_sdnn_ms"] = float(row.get("SDNN", None)) if "SDNN" in row else None
            metrics["hrv_meannn_ms"] = float(row.get("MeanNN", None)) if "MeanNN" in row else None
            metrics["hrv_mediannn_ms"] = float(row.get("MedianNN", None)) if "MedianNN" in row else None
            metrics["hrv_min_nn_ms"] = float(row.get("MinNN", None)) if "MinNN" in row else None
            metrics["hrv_max_nn_ms"] = float(row.get("MaxNN", None)) if "MaxNN" in row else None
            metrics["hrv_pnn50_pct"] = float(row.get("pNN50", None)) if "pNN50" in row else None
            metrics["hrv_pnn20_pct"] = float(row.get("pNN20", None)) if "pNN20" in row else None
            metrics["hrv_cvnn_pct"] = float(row.get("CVNN", None)) if "CVNN" in row else None
            metrics["hrv_cvsd_pct"] = float(row.get("CVSD", None)) if "CVSD" in row else None
            metrics["hrv_sdrmssd"] = float(row.get("SDRMSSD", None)) if "SDRMSSD" in row else None
            metrics["hrv_iqrnn_ms"] = float(row.get("IQRNN", None)) if "IQRNN" in row else None
        try:
            hrv_freq = nk.hrv_frequency(info, sampling_rate=sample_rate_hz)
            if not hrv_freq.empty:
                row = hrv_freq.iloc[0]
                metrics["hrv_lf_ms2"] = float(row.get("LF", None)) if "LF" in row else None
                metrics["hrv_hf_ms2"] = float(row.get("HF", None)) if "HF" in row else None
                metrics["hrv_vlf_ms2"] = float(row.get("VLF", None)) if "VLF" in row else None
                metrics["hrv_lf_hf_ratio"] = float(row.get("LFHF", None)) if "LFHF" in row else None
                metrics["hrv_lfnu"] = float(row.get("LFnu", None)) if "LFnu" in row else None
                metrics["hrv_hfnu"] = float(row.get("HFnu", None)) if "HFnu" in row else None
                metrics["hrv_total_power"] = float(row.get("TP", None)) if "TP" in row else None
        except Exception as exc:  # pragma: no cover - neurokit variance
            logger.warning("[HRV] frequency failed error=%s", exc)
        try:
            hrv_nl = nk.hrv_nonlinear(info, sampling_rate=sample_rate_hz)
            if not hrv_nl.empty:
                row = hrv_nl.iloc[0]
                metrics["hrv_sd1"] = float(row.get("SD1", None)) if "SD1" in row else None
                metrics["hrv_sd2"] = float(row.get("SD2", None)) if "SD2" in row else None
                metrics["hrv_sd1_sd2"] = float(row.get("SD1SD2", None)) if "SD1SD2" in row else None
                metrics["hrv_sampen"] = float(row.get("SampEn", None)) if "SampEn" in row else None
                metrics["hrv_apen"] = float(row.get("ApEn", None)) if "ApEn" in row else None
                metrics["hrv_dfa_alpha1"] = float(row.get("DFA_alpha1", None)) if "DFA_alpha1" in row else None
                metrics["hrv_dfa_alpha2"] = float(row.get("DFA_alpha2", None)) if "DFA_alpha2" in row else None
        except Exception as exc:  # pragma: no cover - neurokit variance
            logger.warning("[HRV] nonlinear failed error=%s", exc)
    return metrics


def _extract_r_peaks(info: Dict[str, Any]) -> List[int]:
    peaks = info.get("ECG_R_Peaks", []) if info else []
    if peaks is None:
        return []
    try:
        if hasattr(peaks, "tolist"):
            peaks = peaks.tolist()
        return [int(p) for p in list(peaks) if p is not None]
    except Exception:
        return []


def _process_window(
    window: List[int],
    sample_rate_hz: int,
) -> Dict[str, Any]:
    if not window:
        return {
            "cleaned": [],
            "info": {},
            "quality": 0.0,
            "metrics": _metrics_from_info([], {}, sample_rate_hz),
            "r_peaks": [],
        }
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
            signals, info = nk.ecg_process(window, sampling_rate=sample_rate_hz)
        cleaned_series = signals.get("ECG_Clean")
        cleaned = (
            cleaned_series.tolist()
            if hasattr(cleaned_series, "tolist")
            else list(cleaned_series)
        )
        quality = nk.ecg_quality(
            cleaned,
            sampling_rate=sample_rate_hz,
            method="averageQRS",
        )
        if hasattr(quality, "__len__") and len(quality) > 0:
            quality_score = float(sum(quality) / len(quality))
        else:
            quality_score = float(quality) if quality is not None else 0.0
        metrics = _metrics_from_info(cleaned, info, sample_rate_hz)
        r_peaks = _extract_r_peaks(info)
        return {
            "cleaned": cleaned,
            "signals": signals,
            "info": info,
            "quality": quality_score,
            "metrics": metrics,
            "r_peaks": r_peaks,
        }
    except Exception as exc:  # pragma: no cover - safeguard
        logger.error("[PROCESS] failed error=%s", exc)
        return {
            "cleaned": [],
            "info": {},
            "quality": 0.0,
            "metrics": _metrics_from_info([], {}, sample_rate_hz),
            "r_peaks": [],
        }


def _delineate_summary(
    cleaned: List[float],
    info: Dict[str, Any],
    sample_rate_hz: int,
) -> Dict[str, int]:
    try:
        rpeaks = info.get("ECG_R_Peaks", [])
        delineate_result = nk.ecg_delineate(
            cleaned,
            rpeaks,
            sampling_rate=sample_rate_hz,
            method="dwt",
        )
        if isinstance(delineate_result, tuple):
            _, delineate = delineate_result
        else:
            delineate = delineate_result
        return {
            "p_peaks": len(delineate.get("ECG_P_Peaks", []) or []),
            "qrs_peaks": len(delineate.get("ECG_Q_Peaks", []) or []),
            "t_peaks": len(delineate.get("ECG_T_Peaks", []) or []),
        }
    except Exception as exc:  # pragma: no cover - safeguard
        logger.error("[DELINEATE] failed error=%s", exc)
        return {"p_peaks": 0, "qrs_peaks": 0, "t_peaks": 0}


def _ecg_plot_base64(
    signals: Any,
    info: Dict[str, Any],
    sample_rate_hz: int,
) -> Optional[str]:
    try:
        if signals is None or info is None:
            return None
        fig = nk.ecg_plot(signals, info)
        if fig is None:
            fig = plt.gcf()
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=120, bbox_inches="tight")
        plt.close(fig)
        return base64.b64encode(buf.getvalue()).decode("utf-8")
    except Exception as exc:  # pragma: no cover - safeguard
        logger.error("[PLOT] failed error=%s", exc)
        return None


def _select_top_windows(
    samples: List[int],
    sample_rate_hz: int,
    window_seconds: int = 20,
    top_k: int = 3,
    max_points: int = 10000,
) -> List[Dict[str, Any]]:
    window_size = sample_rate_hz * window_seconds
    if window_size <= 0:
        return []
    window_count = len(samples) // window_size
    processed: List[Dict[str, Any]] = []
    for index in range(window_count):
        start = index * window_size
        end = start + window_size
        window = samples[start:end]
        result = _process_window(window, sample_rate_hz)
        processed.append(
            {
                "start_index": start,
                "end_index": end,
                "quality": result["quality"],
                "cleaned": result.get("cleaned", []),
                "signals": result.get("signals"),
                "info": result.get("info", {}),
                "metrics": result.get("metrics", {}),
                "r_peaks": result.get("r_peaks", []),
            }
        )

    ranked = [item for item in processed if item.get("quality") is not None]
    ranked.sort(key=lambda item: float(item["quality"]), reverse=True)
    selected = ranked[:top_k]

    results: List[Dict[str, Any]] = []
    for item in selected:
        cleaned = item.get("cleaned", [])
        info = item.get("info", {})
        delineate = _delineate_summary(cleaned, info, sample_rate_hz)
        results.append(
            {
                "start_index": item["start_index"],
                "end_index": item["end_index"],
                "quality": item["quality"],
                "data": _decimate(cleaned, max_points=max_points),
                "metrics": item["metrics"],
                "delineate": delineate,
                "signals": item.get("signals"),
                "info": info,
                "r_peaks": item.get("r_peaks", []),
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


@app.post("/calibration_channels_csv")
async def calibration_channels_csv(request: Request):
    payload = await request.body()
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail="CSV payload must be UTF-8 encoded.",
        ) from exc

    if not text.strip().lower().startswith("index,ch2,ch3,ch4"):
        raise HTTPException(
            status_code=400,
            detail="CSV header must be: index,ch2,ch3,ch4",
        )

    path = _csv_path("calibration_mv.csv")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)

    row_count = text.count("\n")
    run_id = request.headers.get("X-Run-Id", "unknown")
    logger.info(
        "[CSV] saved run_id=%s path=%s rows=%s",
        run_id,
        path,
        row_count,
    )

    return {
        "saved": True,
        "path": path,
        "rows": row_count,
        "run_id": run_id,
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
        session_channels = _decode_ads1298_packets(session_bytes)
        calibration_channels = _decode_ads1298_packets(calibration_bytes)
        sample_rate_hz = int(record.get("sample_rate_hz") or 500)

        window_seconds = 20
        channel_results: Dict[str, Dict[str, Any]] = {}
        for channel in CHANNEL_LABELS:
            session_samples = session_channels.get(channel, [])
            calibration_samples = calibration_channels.get(channel, [])
            best_windows = _select_top_windows(
                session_samples,
                sample_rate_hz=sample_rate_hz,
                window_seconds=window_seconds,
                top_k=3,
                max_points=10000,
            )

            window_size = sample_rate_hz * window_seconds
            calibration_segment = (
                calibration_samples[:window_size]
                if len(calibration_samples) >= window_size
                else calibration_samples
            )
            calibration_result = _process_window(
                calibration_segment,
                sample_rate_hz=sample_rate_hz,
            )
            calibration_metrics = calibration_result.get("metrics", {})
            calibration_r_peaks = calibration_result.get("r_peaks", [])
            calibration_cleaned = calibration_result.get("cleaned", [])

            calibration_plot_b64 = _ecg_plot_base64(
                calibration_result.get("signals"),
                calibration_result.get("info", {}),
                sample_rate_hz=sample_rate_hz,
            )
            window_plot_b64 = []
            for win in best_windows:
                window_plot_b64.append(
                    _ecg_plot_base64(
                        win.get("signals"),
                        win.get("info", {}),
                        sample_rate_hz=sample_rate_hz,
                    )
                )

            channel_results[channel] = {
                "session_samples": session_samples,
                "calibration_samples": calibration_samples,
                "calibration_cleaned": calibration_cleaned,
                "best_windows": best_windows,
                "calibration_metrics": calibration_metrics,
                "calibration_r_peaks": calibration_r_peaks,
                "ecg_plots": {
                    "calibration": calibration_plot_b64,
                    "windows": window_plot_b64,
                },
            }

        LAST_ANALYSIS_PLOT["session_meta"] = {
            "object_key": session_key,
            "bucket": bucket,
            "byte_length": len(session_bytes),
        }
        LAST_ANALYSIS_PLOT["calibration_meta"] = {
            "object_key": calibration_key,
            "bucket": bucket,
            "byte_length": len(calibration_bytes),
        }
        LAST_ANALYSIS_PLOT["channels"] = channel_results

        _set_job(job_id, status="decoded")
        logger.info(
            "[JOB] decoded job_id=%s channels=%s",
            job_id,
            list(channel_results.keys()),
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
def root(request: Request) -> str:
    try:
        latest_id = _fetch_latest_recording_id()
        if latest_id and LAST_ANALYSIS_PLOT.get("record_id") != latest_id:
            _session_analysis_job(job_id="latest", record_id=latest_id)
            LAST_ANALYSIS_PLOT["record_id"] = latest_id
    except Exception as exc:  # pragma: no cover - safeguard
        logger.error("[ROOT] refresh_failed error=%s", exc)

    selected_channel = (request.query_params.get("ch") or "CH2").upper()
    if selected_channel not in CHANNEL_LABELS:
        selected_channel = "CH2"

    channel_data = (LAST_ANALYSIS_PLOT.get("channels") or {}).get(selected_channel, {})
    calibration_plot = LAST_ANALYSIS_PLOT.get("calibration_meta") or {}
    session_plot = LAST_ANALYSIS_PLOT.get("session_meta") or {}
    ecg_plots = channel_data.get("ecg_plots", {}) or {}
    calib_plot_b64 = ecg_plots.get("calibration")
    window_plot_b64 = ecg_plots.get("windows", []) or []

    has_calibration = bool(channel_data.get("calibration_samples"))
    has_session = bool(channel_data.get("session_samples"))
    best_windows = channel_data.get("best_windows", []) or []
    has_best_windows = bool(best_windows)
    best_windows_sanitized = []
    for item in best_windows or []:
        best_windows_sanitized.append(
            {
                "start_index": item.get("start_index"),
                "end_index": item.get("end_index"),
                "quality": item.get("quality"),
                "data": item.get("data", []),
                "metrics": item.get("metrics", {}),
                "delineate": item.get("delineate", {}),
                "r_peaks": item.get("r_peaks", []),
            }
        )

    def _format_metric(label: str, value: Optional[float], unit: str = "") -> str:
        if value is None:
            return f"<li>{label}: n/a</li>"
        return f"<li>{label}: {value:.2f}{unit}</li>"

    def _metrics_html(metrics: Optional[Dict[str, Optional[float]]]) -> str:
        if not metrics:
            return "<div>No metrics available.</div>"
        items = [
            _format_metric("Avg HR", metrics.get("avg_hr_bpm"), " bpm"),
            _format_metric("Min HR", metrics.get("min_hr_bpm"), " bpm"),
            _format_metric("Max HR", metrics.get("max_hr_bpm"), " bpm"),
            _format_metric("HRV RMSSD", metrics.get("hrv_rmssd_ms"), " ms"),
            _format_metric("HRV SDNN", metrics.get("hrv_sdnn_ms"), " ms"),
            _format_metric("HRV MeanNN", metrics.get("hrv_meannn_ms"), " ms"),
            _format_metric("R Peaks", metrics.get("r_peak_count"), ""),
        ]
        return "<ul class='metrics'>" + "".join(items) + "</ul>"

    def _format_value(value: Optional[float], unit: str = "") -> str:
        if value is None:
            return "n/a"
        return f"{value:.2f}{unit}"

    best_windows_html = "".join(
        [
            (
                f"<div class='meta'>Window {i + 1}: samples "
                f"{item['start_index']}-{item['end_index']}</div>"
            )
            for i, item in enumerate(best_windows)
        ]
    )
    metrics_rows = [
        ("Avg HR", "avg_hr_bpm", " bpm"),
        ("Min HR", "min_hr_bpm", " bpm"),
        ("Max HR", "max_hr_bpm", " bpm"),
        ("R Peaks", "r_peak_count", ""),
        ("Mean NN", "hrv_meannn_ms", " ms"),
        ("Median NN", "hrv_mediannn_ms", " ms"),
        ("Min NN", "hrv_min_nn_ms", " ms"),
        ("Max NN", "hrv_max_nn_ms", " ms"),
        ("SDNN", "hrv_sdnn_ms", " ms"),
        ("RMSSD", "hrv_rmssd_ms", " ms"),
        ("SDRMSSD", "hrv_sdrmssd", ""),
        ("IQRNN", "hrv_iqrnn_ms", " ms"),
        ("pNN50", "hrv_pnn50_pct", " %"),
        ("pNN20", "hrv_pnn20_pct", " %"),
        ("CVNN", "hrv_cvnn_pct", " %"),
        ("CVSD", "hrv_cvsd_pct", " %"),
        ("VLF", "hrv_vlf_ms2", " ms2"),
        ("LF", "hrv_lf_ms2", " ms2"),
        ("HF", "hrv_hf_ms2", " ms2"),
        ("LF/HF", "hrv_lf_hf_ratio", ""),
        ("LFnu", "hrv_lfnu", ""),
        ("HFnu", "hrv_hfnu", ""),
        ("Total Power", "hrv_total_power", " ms2"),
        ("SD1", "hrv_sd1", ""),
        ("SD2", "hrv_sd2", ""),
        ("SD1/SD2", "hrv_sd1_sd2", ""),
        ("Sample Entropy", "hrv_sampen", ""),
        ("ApEn", "hrv_apen", ""),
        ("DFA α1", "hrv_dfa_alpha1", ""),
        ("DFA α2", "hrv_dfa_alpha2", ""),
    ]
    calibration_metrics = channel_data.get("calibration_metrics") if channel_data else {}
    window_metrics = [w.get("metrics", {}) for w in best_windows[:3]]

    def _metrics_table() -> str:
        headers = (
            "<tr>"
            "<th>Feature</th>"
            "<th>Calibration</th>"
            "<th>Window 1</th>"
            "<th>Window 2</th>"
            "<th>Window 3</th>"
            "</tr>"
        )
        rows = []
        for label, key, unit in metrics_rows:
            calib_val = _format_value(calibration_metrics.get(key), unit)
            w1 = _format_value(window_metrics[0].get(key), unit) if len(window_metrics) > 0 else "n/a"
            w2 = _format_value(window_metrics[1].get(key), unit) if len(window_metrics) > 1 else "n/a"
            w3 = _format_value(window_metrics[2].get(key), unit) if len(window_metrics) > 2 else "n/a"
            rows.append(
                f"<tr><td>{label}</td><td>{calib_val}</td><td>{w1}</td><td>{w2}</td><td>{w3}</td></tr>"
            )
        return "<table class='metrics-table'>" + headers + "".join(rows) + "</table>"

    metrics_table_html = _metrics_table()

    calibration_data_json = json.dumps(
        channel_data.get("calibration_cleaned")
        if channel_data and channel_data.get("calibration_cleaned")
        else channel_data.get("calibration_samples") if channel_data else []
    )
    calibration_r_peaks_json = json.dumps(
        channel_data.get("calibration_r_peaks") if channel_data else []
    )
    session_data_json = json.dumps(
        channel_data.get("session_samples") if channel_data else []
    )
    best_windows_json = json.dumps(best_windows_sanitized)

    try:
        calibration_samples = channel_data.get("calibration_samples", []) if channel_data else []
        written_cal = _write_mv_csv("calibration_mv.csv", calibration_samples)
        window_samples = []
        for idx, window in enumerate(best_windows or [], start=1):
            samples = window.get("cleaned") or window.get("data") or []
            window_samples.append(_write_mv_csv(f"window{idx}_mv.csv", samples))
        logger.info(
            "[CSV] export channel=%s calibration=%s window_counts=%s",
            selected_channel,
            written_cal,
            window_samples,
        )
    except Exception as exc:  # pragma: no cover - safeguard
        logger.error("[CSV] export failed error=%s", exc)

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
      .right {{ flex: 1; min-width: 320px; }}
      .main-canvas {{
        width: 100%;
        height: 50vh;
        min-height: 420px;
        display: block;
        background: #111827;
        border: 1px solid #1f2937;
      }}
      .controls {{
        display: flex;
        gap: 16px;
        align-items: center;
        margin: 8px 0 16px;
        color: #cbd5f5;
        font-size: 14px;
      }}
      .controls input[type="range"] {{
        width: 200px;
      }}
      .metrics {{ margin: 8px 0 16px; padding-left: 18px; color: #cbd5f5; }}
      .metrics-grid {{
        display: grid;
        grid-template-columns: repeat(4, minmax(140px, 1fr));
        gap: 10px 16px;
        margin: 8px 0 16px;
      }}
      .metrics-table {{
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
        margin: 8px 0 16px;
      }}
      .metrics-table th, .metrics-table td {{
        border: 1px solid #1f2937;
        padding: 6px 8px;
        text-align: left;
        vertical-align: top;
      }}
      .metrics-table th {{
        background: #111827;
        color: #cbd5f5;
        font-weight: 600;
        font-size: 11px;
        letter-spacing: 0.02em;
      }}
      .metric-cell {{
        background: #111827;
        border: 1px solid #1f2937;
        border-radius: 8px;
        padding: 8px 10px;
      }}
      .metric-label {{ font-size: 12px; color: #9ca3af; }}
      .metric-value {{ font-size: 14px; color: #e5e7eb; font-weight: 600; }}
      .plot-grid {{
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
        margin-top: 16px;
      }}
      .plot-card {{
        border: 1px solid #1f2937;
        border-radius: 12px;
        padding: 12px;
        background: #0f172a;
      }}
      .plot-card img {{
        width: 100%;
        height: auto;
        display: block;
        background: #111827;
      }}
      .header-row {{
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
      }}
      .channel-select {{
        background: #0f172a;
        color: #e5e5e5;
        border: 1px solid #334155;
        border-radius: 8px;
        padding: 6px 10px;
        font-size: 14px;
      }}
    </style>
  </head>
  <body>
    <div class="header-row">
      <h1>ECG Session Verification</h1>
      <label>
        <select class="channel-select" id="channel-select">
          <option value="CH2" {"selected" if selected_channel == "CH2" else ""}>CH2</option>
          <option value="CH3" {"selected" if selected_channel == "CH3" else ""}>CH3</option>
          <option value="CH4" {"selected" if selected_channel == "CH4" else ""}>CH4</option>
        </select>
      </label>
    </div>
    {"<div>No analysis data received yet.</div>" if not (has_calibration or has_session) else ""}

    <div class="layout">
      <div class="left">
        <div class="panel">
      <h2>Calibration Signal ({selected_channel})</h2>
      <div class="meta">Calibration Signal, filepath={(calibration_plot.get("bucket", "") + "/" + calibration_plot.get("object_key", "")) if calibration_plot else "n/a"} | byte_length={calibration_plot.get("byte_length", 0) if calibration_plot else 0} | sample_count={len(channel_data.get("calibration_samples", []) if channel_data else [])}</div>
      {"<div>No calibration data received yet.</div>" if not has_calibration else ""}
      <div class="controls">
        <label><input type="checkbox" id="toggle-window-1" checked /> Show Window 1</label>
        <label><input type="checkbox" id="toggle-window-2" checked /> Show Window 2</label>
        <label><input type="checkbox" id="toggle-window-3" checked /> Show Window 3</label>
        <label>Window opacity
          <input type="range" id="window-opacity" min="0" max="1" step="0.05" value="0.6" />
        </label>
      </div>
      <canvas id="calibration" class="main-canvas" width="1600" height="600"></canvas>
    </div>

    <div class="panel">
      <h2>ECG Plots (nk.ecg_plot)</h2>
      <div class="plot-grid">
        <div class="plot-card">
          <div class="meta">Calibration</div>
          {f"<img src='data:image/png;base64,{calib_plot_b64}' />" if calib_plot_b64 else "<div>No calibration plot</div>"}
        </div>
        <div class="plot-card">
          <div class="meta">Window 1</div>
          {f"<img src='data:image/png;base64,{window_plot_b64[0]}' />" if len(window_plot_b64) > 0 and window_plot_b64[0] else "<div>No window 1 plot</div>"}
        </div>
        <div class="plot-card">
          <div class="meta">Window 2</div>
          {f"<img src='data:image/png;base64,{window_plot_b64[1]}' />" if len(window_plot_b64) > 1 and window_plot_b64[1] else "<div>No window 2 plot</div>"}
        </div>
        <div class="plot-card">
          <div class="meta">Window 3</div>
          {f"<img src='data:image/png;base64,{window_plot_b64[2]}' />" if len(window_plot_b64) > 2 and window_plot_b64[2] else "<div>No window 3 plot</div>"}
        </div>
      </div>
    </div>

    <div class="panel">
      <h2>Session Signal ({selected_channel})</h2>
      <div class="meta">Session Signal, filepath={(session_plot.get("bucket", "") + "/" + session_plot.get("object_key", "")) if session_plot else "n/a"} | byte_length={session_plot.get("byte_length", 0) if session_plot else 0} | sample_count={len(channel_data.get("session_samples", []) if channel_data else [])}</div>
      {"<div>No session data received yet.</div>" if not has_session else ""}
    </div>

    <div class="panel">
      <h2>Top 3 Windows (20s)</h2>
      {"<div>No top windows computed yet.</div>" if not has_best_windows else ""}
      {best_windows_html}
    </div>
      </div>

      <div class="right">
        <div class="panel">
          <h2>Calibration vs Windows</h2>
          {metrics_table_html}
        </div>
      </div>
    </div>
    <script>
      const calibrationData = {calibration_data_json};
      const calibrationRPeaks = {calibration_r_peaks_json};
      const sessionData = {session_data_json};
      const bestWindows = {best_windows_json};
      const Y_RANGE_MV = 5.0; // fixed ECG scale: +/-5 mV
      const channelSelect = document.getElementById("channel-select");
      if (channelSelect) {{
        channelSelect.addEventListener("change", (evt) => {{
          const value = evt.target.value || "CH2";
          const url = new URL(window.location.href);
          url.searchParams.set("ch", value);
          window.location.href = url.toString();
        }});
      }}

      function drawAxes(ctx, canvas, maxAbs, viewStart, viewEnd, padding) {{
        const plotWidth = canvas.width - padding.left - padding.right;
        const plotHeight = canvas.height - padding.top - padding.bottom;
        const left = padding.left;
        const top = padding.top;
        const bottom = top + plotHeight;
        const right = left + plotWidth;

        ctx.strokeStyle = "#374151";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(left, top);
        ctx.lineTo(left, bottom);
        ctx.lineTo(right, bottom);
        ctx.stroke();

        ctx.fillStyle = "#9ca3af";
        ctx.font = "12px Arial";
        const xTicks = 5;
        for (let i = 0; i <= xTicks; i++) {{
          const t = i / xTicks;
          const x = left + t * plotWidth;
          const val = Math.round(viewStart + t * (viewEnd - viewStart) + 1);
          ctx.fillText(val.toString(), x - 6, bottom + 18);
        }}

        const yTicks = 4;
        for (let i = 0; i <= yTicks; i++) {{
          const t = i / yTicks;
          const y = top + t * plotHeight;
          const val = Math.round((1 - 2 * t) * maxAbs);
          ctx.fillText(val.toString(), 6, y + 4);
          // light horizontal gridline
          ctx.strokeStyle = "rgba(148, 163, 184, 0.15)";
          ctx.beginPath();
          ctx.moveTo(left, y);
          ctx.lineTo(right, y);
          ctx.stroke();
          ctx.strokeStyle = "#374151";
        }}
        ctx.fillText("samples", right - 48, bottom + 30);
        ctx.fillText("mV", 6, top - 4);
      }}

      function drawSignal(canvasId, data, color, alpha, axisLen, viewStart, viewEnd, maxAbs) {{
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!data || data.length === 0) {{
          ctx.fillStyle = "#9ca3af";
          ctx.fillText("No data", 10, 20);
          return;
        }}

        const padding = {{ left: 48, right: 16, top: 16, bottom: 36 }};
        const plotWidth = canvas.width - padding.left - padding.right;
        const plotHeight = canvas.height - padding.top - padding.bottom;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawAxes(ctx, canvas, maxAbs, viewStart, viewEnd, padding);

        const scale = maxAbs || 1;
        ctx.strokeStyle = color;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = 1.5;
        const mid = padding.top + plotHeight / 2;
        const viewSpan = Math.max(1, viewEnd - viewStart);
        const maxPoints = 5000;
        const step = Math.max(1, Math.floor(viewSpan / maxPoints));
        ctx.beginPath();
        const startIndex = Math.max(0, Math.floor(viewStart));
        const endIndex = Math.min(data.length - 1, Math.floor(viewEnd));
        for (let i = startIndex; i <= endIndex; i += step) {{
          const x =
            padding.left +
            ((i - viewStart) / viewSpan) * plotWidth;
          const y = mid - (data[i] / scale) * (plotHeight / 2);
          if (i === startIndex) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }}
        ctx.stroke();
        ctx.globalAlpha = 1;
      }}

      function drawOverlayWindows(canvasId, windows, alpha, showFlags, axisLen, viewStart, viewEnd, maxAbs) {{
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!windows || windows.length === 0) return;

        const padding = {{ left: 48, right: 16, top: 16, bottom: 36 }};
        const plotWidth = canvas.width - padding.left - padding.right;
        const plotHeight = canvas.height - padding.top - padding.bottom;
        const mid = padding.top + plotHeight / 2;
        const viewSpan = Math.max(1, viewEnd - viewStart);
        const colors = ["#ef4444", "#f97316", "#f59e0b"];

        windows.forEach((w, idx) => {{
          if (!showFlags[idx]) return;
          const data = w.data || [];
          if (!data.length) return;
          const scale = maxAbs || 1;
          const dataSpan = Math.max(1, data.length - 1);
          ctx.strokeStyle = colors[idx] || "#f59e0b";
          ctx.globalAlpha = alpha;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          for (let i = 0; i < data.length; i++) {{
            const xIndex = (i / dataSpan) * (axisLen - 1);
            if (xIndex < viewStart || xIndex > viewEnd) continue;
            const x =
              padding.left +
              ((xIndex - viewStart) / viewSpan) * plotWidth;
            const y = mid - (data[i] / scale) * (plotHeight / 2);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }}
          ctx.stroke();
          ctx.globalAlpha = 1;
        }});
      }}

      function drawRPeaks(canvasId, data, peaks, color, axisLen, viewStart, viewEnd, maxAbs) {{
        const canvas = document.getElementById(canvasId);
        if (!canvas || !data || data.length === 0 || !peaks || peaks.length === 0) return;
        const ctx = canvas.getContext("2d");
        const padding = {{ left: 48, right: 16, top: 16, bottom: 36 }};
        const plotWidth = canvas.width - padding.left - padding.right;
        const plotHeight = canvas.height - padding.top - padding.bottom;
        const mid = padding.top + plotHeight / 2;
        const viewSpan = Math.max(1, viewEnd - viewStart);
        const scale = maxAbs || 1;
        ctx.fillStyle = color;
        for (const peak of peaks) {{
          const idx = Math.round(peak);
          if (idx < 0 || idx >= data.length) continue;
          if (idx < viewStart || idx > viewEnd) continue;
          const x =
            padding.left + ((idx - viewStart) / viewSpan) * plotWidth;
          const y = mid - (data[idx] / scale) * (plotHeight / 2);
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fill();
        }}
      }}

      function drawOverlayRPeaks(canvasId, windows, showFlags, axisLen, viewStart, viewEnd, maxAbs) {{
        const canvas = document.getElementById(canvasId);
        if (!canvas || !windows || windows.length === 0) return;
        const ctx = canvas.getContext("2d");
        const padding = {{ left: 48, right: 16, top: 16, bottom: 36 }};
        const plotWidth = canvas.width - padding.left - padding.right;
        const plotHeight = canvas.height - padding.top - padding.bottom;
        const mid = padding.top + plotHeight / 2;
        const viewSpan = Math.max(1, viewEnd - viewStart);
        const colors = ["#ef4444", "#f97316", "#f59e0b"];
        const scale = maxAbs || 1;

        windows.forEach((w, idx) => {{
          if (!showFlags[idx]) return;
          const data = w?.data || [];
          const peaks = w?.r_peaks || [];
          if (!data.length || !peaks.length) return;
          const dataSpan = Math.max(1, data.length - 1);
          ctx.fillStyle = colors[idx] || "#f59e0b";
          for (const peak of peaks) {{
            const peakIdx = Math.round(peak);
            const xIndex = (peakIdx / dataSpan) * (axisLen - 1);
            if (xIndex < viewStart || xIndex > viewEnd) continue;
            const x = padding.left + ((xIndex - viewStart) / viewSpan) * plotWidth;
            const safeIdx = Math.min(Math.max(peakIdx, 0), data.length - 1);
            const y = mid - (data[safeIdx] / scale) * (plotHeight / 2);
            ctx.beginPath();
            ctx.arc(x, y, 2.5, 0, Math.PI * 2);
            ctx.fill();
          }}
        }});
      }}

      function computeAxisLen() {{
        if (calibrationData && calibrationData.length > 0) return calibrationData.length;
        if (bestWindows && bestWindows.length > 0 && bestWindows[0]?.data?.length) return bestWindows[0].data.length;
        return 1;
      }}

      function computeMaxAbs() {{
        return Y_RANGE_MV;
      }}

      let axisLen = computeAxisLen();
      let viewStart = 0;
      let viewEnd = Math.max(1, axisLen - 1);

      function renderAll() {{
        axisLen = computeAxisLen();
        if (viewEnd > axisLen - 1) viewEnd = axisLen - 1;
        if (viewStart < 0) viewStart = 0;
        if (viewStart >= viewEnd) viewStart = Math.max(0, viewEnd - 1);
        const maxAbs = computeMaxAbs();
        drawSignal("calibration", calibrationData, "#22c55e", 1, axisLen, viewStart, viewEnd, maxAbs);
        const showFlags = [
          document.getElementById("toggle-window-1").checked,
          document.getElementById("toggle-window-2").checked,
          document.getElementById("toggle-window-3").checked,
        ];
        const alpha = parseFloat(document.getElementById("window-opacity").value);
        drawOverlayWindows("calibration", bestWindows, alpha, showFlags, axisLen, viewStart, viewEnd, maxAbs);
        drawRPeaks("calibration", calibrationData, calibrationRPeaks, "#e2e8f0", axisLen, viewStart, viewEnd, maxAbs);
        drawOverlayRPeaks("calibration", bestWindows, showFlags, axisLen, viewStart, viewEnd, maxAbs);
      }}

      const slider = document.getElementById("window-opacity");
      const t1 = document.getElementById("toggle-window-1");
      const t2 = document.getElementById("toggle-window-2");
      const t3 = document.getElementById("toggle-window-3");
      if (t1) t1.addEventListener("change", renderAll);
      if (t2) t2.addEventListener("change", renderAll);
      if (t3) t3.addEventListener("change", renderAll);
      if (slider) slider.addEventListener("input", renderAll);

      const canvas = document.getElementById("calibration");
      let isDragging = false;
      let dragStartX = 0;
      let dragStartView = 0;
      if (canvas) {{
        canvas.addEventListener("wheel", (evt) => {{
          evt.preventDefault();
          const rect = canvas.getBoundingClientRect();
          const x = evt.clientX - rect.left;
          const paddingLeft = 48;
          const paddingRight = 16;
          const plotWidth = canvas.width - paddingLeft - paddingRight;
          const clampedX = Math.max(paddingLeft, Math.min(canvas.width - paddingRight, x));
          const ratio = (clampedX - paddingLeft) / plotWidth;
          const center = viewStart + ratio * (viewEnd - viewStart);
          const zoom = evt.deltaY < 0 ? 0.9 : 1.1;
          const span = Math.max(50, (viewEnd - viewStart) * zoom);
          viewStart = Math.max(0, Math.round(center - span * ratio));
          viewEnd = Math.min(axisLen - 1, Math.round(viewStart + span));
          renderAll();
        }});
        canvas.addEventListener("mousedown", (evt) => {{
          isDragging = true;
          dragStartX = evt.clientX;
          dragStartView = viewStart;
        }});
        window.addEventListener("mouseup", () => {{
          isDragging = false;
        }});
        window.addEventListener("mousemove", (evt) => {{
          if (!isDragging) return;
          const dx = evt.clientX - dragStartX;
          const span = viewEnd - viewStart;
          const paddingLeft = 48;
          const paddingRight = 16;
          const plotWidth = canvas.width - paddingLeft - paddingRight;
          const shift = Math.round((-dx / plotWidth) * span);
          viewStart = Math.max(0, Math.min(axisLen - span, dragStartView + shift));
          viewEnd = Math.min(axisLen - 1, viewStart + span);
          renderAll();
        }});
      }}

      renderAll();

    </script>
  </body>
 </html>"""
