import base64
import io
import json
import logging
import os
import warnings
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
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
LIVE_SESSION_STATE: Dict[str, Dict[str, Any]] = {}
LIVE_SESSION_WINDOW_SECONDS = 10
LIVE_SESSION_WINDOW_PACKETS = LIVE_SESSION_WINDOW_SECONDS * 20
DEFAULT_SAMPLE_RATE_HZ = 500
REVIEW_PROCESSING_VERSION = "review_v6"
REVIEW_ARTIFACT_CACHE: Dict[tuple[str, str, str], Dict[str, Any]] = {}
MAX_QR_MS = 40


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


def _fetch_storage_json(object_key: str) -> Dict[str, Any]:
    payload = _fetch_storage_bytes(object_key)
    try:
        return json.loads(payload.decode("utf-8"))
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Stored JSON artifact is invalid for object_key={object_key}: {exc}",
        ) from exc


def _review_cache_key(record_id: str, channel: str) -> tuple[str, str, str]:
    return (record_id, channel.upper(), REVIEW_PROCESSING_VERSION)


def _supabase_headers(json_content: bool = True) -> Dict[str, str]:
    config = _get_supabase_config()
    headers = {
        "apikey": config["key"],
        "Authorization": f"Bearer {config['key']}",
    }
    if json_content:
        headers["Content-Type"] = "application/json"
        headers["Accept"] = "application/json"
    return headers


def _upload_storage_bytes(object_key: str, payload: bytes) -> None:
    config = _get_supabase_config()
    url = f"{config['url']}/storage/v1/object/{config['bucket']}/{object_key}"
    headers = {
        "apikey": config["key"],
        "Authorization": f"Bearer {config['key']}",
        "Content-Type": "application/octet-stream",
        "x-upsert": "true",
    }
    try:
        with httpx.Client(timeout=60) as client:
            response = client.post(url, headers=headers, content=payload)
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Supabase Storage upload error: {exc.response.status_code} {exc.response.text}",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Supabase Storage upload unreachable: {exc}",
        ) from exc


def _upload_storage_json(object_key: str, payload: Dict[str, Any]) -> None:
    config = _get_supabase_config()
    url = f"{config['url']}/storage/v1/object/{config['bucket']}/{object_key}"
    headers = {
        "apikey": config["key"],
        "Authorization": f"Bearer {config['key']}",
        "Content-Type": "application/json",
        "x-upsert": "true",
    }
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    try:
        with httpx.Client(timeout=60) as client:
            response = client.post(url, headers=headers, content=body)
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Supabase Storage upload error: {exc.response.status_code} {exc.response.text}",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Supabase Storage upload unreachable: {exc}",
        ) from exc


def _insert_recording_row(payload: Dict[str, Any]) -> Dict[str, Any]:
    config = _get_supabase_config()
    url = f"{config['url']}/rest/v1/ecg_recordings"
    headers = _supabase_headers(json_content=True)
    headers["Prefer"] = "return=representation"
    try:
        with httpx.Client(timeout=30) as client:
            response = client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            data = response.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Supabase insert error: {exc.response.status_code} {exc.response.text}",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Supabase insert unreachable: {exc}",
        ) from exc
    if not data:
        raise HTTPException(status_code=502, detail="Supabase insert returned no rows.")
    return data[0]


def _update_recording_row(record_id: str, payload: Dict[str, Any]) -> None:
    config = _get_supabase_config()
    url = f"{config['url']}/rest/v1/ecg_recordings?id=eq.{record_id}"
    headers = _supabase_headers(json_content=True)
    headers["Prefer"] = "return=minimal"
    try:
        with httpx.Client(timeout=30) as client:
            response = client.patch(url, headers=headers, json=payload)
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Supabase update error: {exc.response.status_code} {exc.response.text}",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Supabase update unreachable: {exc}",
        ) from exc


def _upsert_table_row(table: str, payload: Dict[str, Any], conflict_columns: str) -> List[Dict[str, Any]]:
    config = _get_supabase_config()
    url = f"{config['url']}/rest/v1/{table}?on_conflict={conflict_columns}"
    headers = _supabase_headers(json_content=True)
    headers["Prefer"] = "return=representation,resolution=merge-duplicates"
    try:
        with httpx.Client(timeout=30) as client:
            response = client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            return response.json() or []
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Supabase upsert error ({table}): {exc.response.status_code} {exc.response.text}",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Supabase upsert unreachable ({table}): {exc}",
        ) from exc


def _fetch_processed_record(record_id: str) -> Optional[Dict[str, Any]]:
    config = _get_supabase_config()
    url = f"{config['url']}/rest/v1/ecg_processed_records"
    params = {
        "record_id": f"eq.{record_id}",
        "select": "record_id,status,processing_version,updated_at,error_message",
        "limit": 1,
    }
    headers = _supabase_headers(json_content=False)
    headers["Accept"] = "application/json"
    try:
        with httpx.Client(timeout=15) as client:
            response = client.get(url, headers=headers, params=params)
            response.raise_for_status()
            data = response.json()
    except Exception as exc:  # pragma: no cover - safeguard
        logger.error("[PROCESSING] fetch_record failed record_id=%s error=%s", record_id, exc)
        return None
    return data[0] if data else None


def _upsert_processed_record(
    record_id: str,
    status: str,
    error_message: Optional[str] = None,
) -> None:
    _upsert_table_row(
        "ecg_processed_records",
        {
            "record_id": record_id,
            "status": status,
            "processing_version": REVIEW_PROCESSING_VERSION,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "error_message": error_message,
        },
        "record_id",
    )


def _fetch_processed_artifact_key(record_id: str, artifact_type: str) -> Optional[str]:
    config = _get_supabase_config()
    url = f"{config['url']}/rest/v1/ecg_processed_artifacts"
    params = {
        "record_id": f"eq.{record_id}",
        "artifact_type": f"eq.{artifact_type}",
        "select": "object_key,updated_at",
        "limit": 1,
    }
    headers = _supabase_headers(json_content=False)
    headers["Accept"] = "application/json"
    try:
        with httpx.Client(timeout=15) as client:
            response = client.get(url, headers=headers, params=params)
            response.raise_for_status()
            data = response.json()
    except Exception as exc:  # pragma: no cover - safeguard
        logger.error(
            "[PROCESSING] fetch_artifact failed record_id=%s artifact_type=%s error=%s",
            record_id,
            artifact_type,
            exc,
        )
        return None
    return data[0].get("object_key") if data else None


def _upsert_processed_artifact(record_id: str, artifact_type: str, object_key: str) -> None:
    _upsert_table_row(
        "ecg_processed_artifacts",
        {
            "record_id": record_id,
            "artifact_type": artifact_type,
            "object_key": object_key,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
        "record_id,artifact_type",
    )


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
    return (count / ADS1298_MAX_CODE) * (ADS1298_VREF / ADS1298_GAIN) * 1000.0


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


def _quality_to_percentage(quality_score: Optional[float]) -> float:
    if quality_score is None:
        return 0.0
    if quality_score <= 1.0:
        return max(0.0, min(100.0, quality_score * 100.0))
    return max(0.0, min(100.0, quality_score))


def _clean_series(samples: List[float], sample_rate_hz: int) -> List[float]:
    if not samples:
        return []
    try:
        cleaned = nk.ecg_clean(samples, sampling_rate=sample_rate_hz)
        if hasattr(cleaned, "tolist"):
            return cleaned.tolist()
        return list(cleaned)
    except Exception as exc:  # pragma: no cover - safeguard
        logger.warning("[CLEAN] fallback raw error=%s", exc)
        return list(samples)


def _preview_series(samples: List[float], preview_samples: int = 2500) -> List[float]:
    limited = samples[:preview_samples]
    if not limited:
        return []
    mean = sum(limited) / len(limited)
    max_abs = max(abs(value - mean) for value in limited) or 1.0
    return [(value - mean) / max_abs for value in limited]


def _build_cleaned_previews(
    channels: Dict[str, List[float]],
    sample_rate_hz: int,
    preview_samples: int = 2500,
) -> Dict[str, List[float]]:
    previews: Dict[str, List[float]] = {}
    for label in CHANNEL_LABELS:
        cleaned = _clean_series(channels.get(label, []), sample_rate_hz)
        previews[label] = _preview_series(cleaned, preview_samples=preview_samples)
    return previews


def _packet_stats(payload: bytes) -> Dict[str, int]:
    packet_count = len(payload) // PACKET_BYTES
    sample_count_per_channel = packet_count * SAMPLES_PER_PACKET
    remainder = len(payload) % PACKET_BYTES
    return {
        "packet_count": packet_count,
        "sample_count_per_channel": sample_count_per_channel,
        "remainder": remainder,
        "byte_length": len(payload),
    }


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


def _sanitize_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        number = float(value)
        if number != number:
            return None
        return number
    except Exception:
        return None


def _delineate_single_beat(
    beat_values: List[float],
    sample_rate_hz: int,
) -> Dict[str, List[int]]:
    minimum_length = max(5, int(sample_rate_hz * 0.12))
    if len(beat_values) < minimum_length:
        return {
            "P": [],
            "Q": [],
            "R": [],
            "S": [],
            "T": [],
            "P_Onsets": [],
            "P_Offsets": [],
            "R_Onsets": [],
            "R_Offsets": [],
            "T_Onsets": [],
            "T_Offsets": [],
        }

    local_r_peak = int(max(range(len(beat_values)), key=lambda idx: beat_values[idx]))
    try:
        delineate_result = nk.ecg_delineate(
            beat_values,
            [local_r_peak],
            sampling_rate=sample_rate_hz,
            method="dwt",
        )
        if isinstance(delineate_result, tuple):
            _, delineate = delineate_result
        else:
            delineate = delineate_result
    except Exception as exc:  # pragma: no cover - safeguard
        if "too small to be segmented" not in str(exc).lower():
            logger.warning("[DELINEATE] beat failed error=%s", exc)
        delineate = {}

    def _extract_positions(key: str) -> List[int]:
        values = delineate.get(key, []) if isinstance(delineate, dict) else []
        if values is None:
            return []
        if hasattr(values, "tolist"):
            values = values.tolist()
        positions: List[int] = []
        for value in list(values):
            numeric = _sanitize_float(value)
            if numeric is None:
                continue
            index = int(round(numeric))
            if 0 <= index < len(beat_values):
                positions.append(index)
        return positions

    return {
        "P": _extract_positions("ECG_P_Peaks"),
        "Q": _extract_positions("ECG_Q_Peaks"),
        "R": [local_r_peak],
        "S": _extract_positions("ECG_S_Peaks"),
        "T": _extract_positions("ECG_T_Peaks"),
        "P_Onsets": _extract_positions("ECG_P_Onsets"),
        "P_Offsets": _extract_positions("ECG_P_Offsets"),
        "R_Onsets": _extract_positions("ECG_R_Onsets"),
        "R_Offsets": _extract_positions("ECG_R_Offsets"),
        "T_Onsets": _extract_positions("ECG_T_Onsets"),
        "T_Offsets": _extract_positions("ECG_T_Offsets"),
    }


def _delineate_signal_peaks(
    cleaned: List[float],
    r_peaks: List[int],
    sample_rate_hz: int,
) -> Dict[str, List[int]]:
    if not cleaned or not r_peaks:
        return {
            "P": [],
            "Q": [],
            "R": list(r_peaks or []),
            "S": [],
            "T": [],
        }

    try:
        delineate_result = nk.ecg_delineate(
            cleaned,
            r_peaks,
            sampling_rate=sample_rate_hz,
            method="dwt",
        )
        if isinstance(delineate_result, tuple):
            _, delineate = delineate_result
        else:
            delineate = delineate_result
    except Exception as exc:  # pragma: no cover - safeguard
        logger.warning("[DELINEATE] signal failed error=%s", exc)
        delineate = {}

    def _extract_positions(key: str) -> List[int]:
        values = delineate.get(key, []) if isinstance(delineate, dict) else []
        if values is None:
            return []
        if hasattr(values, "tolist"):
            values = values.tolist()
        positions: List[int] = []
        for value in list(values):
            numeric = _sanitize_float(value)
            if numeric is None:
                continue
            index = int(round(numeric))
            if 0 <= index < len(cleaned):
                positions.append(index)
        return positions

    return {
        "P": _extract_positions("ECG_P_Peaks"),
        "Q": _extract_positions("ECG_Q_Peaks"),
        "R": [peak for peak in r_peaks if 0 <= peak < len(cleaned)],
        "S": _extract_positions("ECG_S_Peaks"),
        "T": _extract_positions("ECG_T_Peaks"),
    }


def _empty_beat_markers() -> Dict[str, List[int]]:
    return {
        "P": [],
        "Q": [],
        "R": [],
        "S": [],
        "T": [],
        "P_Onsets": [],
        "P_Offsets": [],
        "R_Onsets": [],
        "R_Offsets": [],
        "T_Onsets": [],
        "T_Offsets": [],
    }


def _slice_markers_for_beat(
    signal_markers: Optional[Dict[str, List[int]]],
    start_index: int,
    end_index: int,
    local_r_peak: Optional[int] = None,
) -> Dict[str, List[int]]:
    markers = _empty_beat_markers()
    if signal_markers:
        for label in markers.keys():
            positions = signal_markers.get(label, [])
            local_positions: List[int] = []
            for position in positions:
                if start_index <= position < end_index:
                    local_positions.append(position - start_index)
            markers[label] = local_positions
    if local_r_peak is not None and 0 <= local_r_peak < max(0, end_index - start_index):
        if local_r_peak not in markers["R"]:
            markers["R"].append(local_r_peak)
        markers["R"] = sorted(set(markers["R"]))
    return markers


def _evaluate_beat_exclusion(
    markers: Dict[str, List[int]],
    sample_rate_hz: int,
) -> Dict[str, Any]:
    q_positions = sorted(markers.get("Q", []))
    r_positions = sorted(markers.get("R", []))
    qr_duration_samples: Optional[int] = None
    qr_duration_ms: Optional[float] = None
    exclusion_reasons: List[str] = []

    if q_positions and r_positions:
        q_position = q_positions[0]
        r_position = r_positions[0]
        if r_position >= q_position:
            qr_duration_samples = r_position - q_position
            qr_duration_ms = (qr_duration_samples / sample_rate_hz) * 1000.0
            max_qr_samples = int(round((MAX_QR_MS / 1000.0) * sample_rate_hz))
            if qr_duration_samples > max_qr_samples:
                exclusion_reasons.append("qr_too_long")

    return {
        "exclude_from_analysis": len(exclusion_reasons) > 0,
        "exclusion_reasons": exclusion_reasons,
        "qr_duration_samples": qr_duration_samples,
        "qr_duration_ms": qr_duration_ms,
    }


def _compute_beat_bounds(signal_length: int, r_peaks: List[int]) -> List[Dict[str, int]]:
    if signal_length <= 0 or not r_peaks:
        return []
    sorted_peaks = sorted(peak for peak in r_peaks if 0 <= peak < signal_length)
    if not sorted_peaks:
        return []

    bounds: List[Dict[str, int]] = []
    for index, peak in enumerate(sorted_peaks):
        if index == 0:
            start = 0
        else:
            start = int((sorted_peaks[index - 1] + peak) / 2)
        if index == len(sorted_peaks) - 1:
            end = signal_length
        else:
            end = int((peak + sorted_peaks[index + 1]) / 2)
        start = max(0, min(start, signal_length))
        end = max(start + 1, min(end, signal_length))
        bounds.append(
            {
                "index": index + 1,
                "peak": peak,
                "start": start,
                "end": end,
            }
        )
    return bounds


def _build_beats_from_cleaned(
    cleaned: List[float],
    r_peaks: List[int],
    sample_rate_hz: int,
    signal_markers: Optional[Dict[str, List[int]]] = None,
    window_samples: Optional[int] = None,
) -> List[Dict[str, Any]]:
    beats: List[Dict[str, Any]] = []
    for item in _compute_beat_bounds(len(cleaned), r_peaks):
        beat_values = cleaned[item["start"] : item["end"]]
        if len(beat_values) < max(5, int(sample_rate_hz * 0.12)):
            continue
        local_peak = item["peak"] - item["start"]
        markers = _slice_markers_for_beat(
            signal_markers,
            item["start"],
            item["end"],
            local_r_peak=local_peak,
        )
        if not any(markers[label] for label in ["P", "Q", "S", "T"]):
            fallback_markers = _delineate_single_beat(beat_values, sample_rate_hz)
            for label, positions in fallback_markers.items():
                if positions:
                    markers[label] = positions
        window_index = 1
        window_start_sample = 1
        window_end_sample = len(cleaned)
        if window_samples and window_samples > 0:
            window_index = (item["start"] // window_samples) + 1
            window_start = (window_index - 1) * window_samples
            window_end = min(len(cleaned), window_start + window_samples)
            window_start_sample = window_start + 1
            window_end_sample = window_end
        exclusion = _evaluate_beat_exclusion(markers, sample_rate_hz)
        beats.append(
            {
                "index": item["index"],
                "start_sample": item["start"] + 1,
                "end_sample": item["end"],
                "window_index": window_index,
                "window_start_sample": window_start_sample,
                "window_end_sample": window_end_sample,
                "markers": markers,
                **exclusion,
            }
        )
    return beats


def _segment_heartbeats(
    cleaned: List[float],
    r_peaks: List[int],
    sample_rate_hz: int,
) -> List[Dict[str, Any]]:
    if not cleaned or not r_peaks:
        return []
    try:
        with warnings.catch_warnings():
            try:
                from pandas.errors import ChainedAssignmentError
            except Exception:  # pragma: no cover - pandas compatibility
                ChainedAssignmentError = Warning  # type: ignore
            warnings.filterwarnings("ignore", category=ChainedAssignmentError)
            warnings.filterwarnings("ignore", message=".*ChainedAssignmentError.*")
            segments = nk.ecg_segment(
                cleaned,
                rpeaks=r_peaks,
                sampling_rate=sample_rate_hz,
            )
    except Exception as exc:  # pragma: no cover - safeguard
        logger.error("[SEGMENT] failed error=%s", exc)
        return []

    beats: List[Dict[str, Any]] = []
    for idx, (_, dataframe) in enumerate(segments.items(), start=1):
        if dataframe is None or getattr(dataframe, "empty", False):
            continue
        column_name = None
        for candidate in ["Signal", "ECG_Clean", "ECG_Raw", "ECG"]:
            if candidate in dataframe.columns:
                column_name = candidate
                break
        if column_name is None:
            numeric_columns = list(dataframe.columns)
            if not numeric_columns:
                continue
            column_name = numeric_columns[0]

        values_series = dataframe[column_name].dropna()
        beat_values = [
            float(value)
            for value in values_series.tolist()
            if _sanitize_float(value) is not None
        ]
        if len(beat_values) < max(5, int(sample_rate_hz * 0.12)):
            continue

        x_values = [float(i) for i in range(len(beat_values))]
        beats.append(
            {
                "index": idx,
                "x": x_values,
                "y": beat_values,
                "markers": _delineate_single_beat(beat_values, sample_rate_hz),
            }
        )
    return beats


def _interval_row_from_result(
    result: Dict[str, Any],
    sample_count: int,
    sample_rate_hz: int,
    interval_index: int,
    start_s: float,
    end_s: float,
) -> Optional[Dict[str, Any]]:
    if not result or not result.get("cleaned"):
        return None
    metrics = result.get("metrics", {})
    if not metrics:
        return None
    return {
        "interval_index": interval_index,
        "start_s": round(start_s, 2),
        "end_s": round(end_s, 2),
        "sample_count": sample_count,
        "ECG_Rate_Mean": _sanitize_float(metrics.get("avg_hr_bpm")),
    }


def _interval_related_single(
    samples: List[float],
    sample_count: int,
    sample_rate_hz: int,
) -> Optional[Dict[str, Any]]:
    if not samples:
        return None
    result = _process_window(samples, sample_rate_hz)
    return _interval_row_from_result(
        result,
        sample_count=sample_count,
        sample_rate_hz=sample_rate_hz,
        interval_index=1,
        start_s=0.0,
        end_s=sample_count / sample_rate_hz,
    )


def _interval_related_epochs(
    samples: List[float],
    sample_rate_hz: int,
    epoch_seconds: int = 20,
) -> List[Dict[str, Any]]:
    if not samples:
        return []

    rows: List[Dict[str, Any]] = []
    epoch_samples = sample_rate_hz * epoch_seconds
    total_samples = len(samples)

    for start_index in range(0, total_samples, epoch_samples):
        end_index = min(total_samples, start_index + epoch_samples)
        window_samples = samples[start_index:end_index]
        if len(window_samples) < max(2, int(sample_rate_hz * 0.5)):
            continue
        result = _process_window(window_samples, sample_rate_hz)
        row = _interval_row_from_result(
            result,
            sample_count=len(window_samples),
            sample_rate_hz=sample_rate_hz,
            interval_index=(start_index // epoch_samples) + 1,
            start_s=start_index / sample_rate_hz,
            end_s=end_index / sample_rate_hz,
        )
        if row is not None:
            rows.append(row)

    return rows


def _build_review_section_from_samples(
    object_key: str,
    byte_length: int,
    samples: List[float],
    sample_rate_hz: int,
    include_interval_rows: bool = False,
    window_seconds: int = 20,
) -> Dict[str, Any]:
    processed = _process_window(samples, sample_rate_hz)
    cleaned = processed.get("cleaned", []) or list(samples)
    r_peaks = processed.get("r_peaks", [])
    signal_markers = _delineate_signal_peaks(cleaned, r_peaks, sample_rate_hz)
    window_samples = sample_rate_hz * window_seconds
    beats = _build_beats_from_cleaned(
        cleaned,
        r_peaks,
        sample_rate_hz,
        signal_markers=signal_markers,
        window_samples=window_samples,
    )
    excluded_reason_counts: Dict[str, int] = {}
    for beat in beats:
        for reason in beat.get("exclusion_reasons", []):
            excluded_reason_counts[reason] = excluded_reason_counts.get(reason, 0) + 1
    beat_count_total = len(beats)
    beat_count_excluded = sum(1 for beat in beats if beat.get("exclude_from_analysis"))
    beat_count_included = beat_count_total - beat_count_excluded
    return {
        "meta": {
            "object_key": object_key,
            "byte_length": byte_length,
            "sample_count": len(samples),
        },
        "signal": {
            "full": cleaned,
            "r_peaks": r_peaks,
            "markers": signal_markers,
        },
        "beats": {
            "count": len(beats),
            "items": beats,
        },
        "beat_count_total": beat_count_total,
        "beat_count_included": beat_count_included,
        "beat_count_excluded": beat_count_excluded,
        "excluded_reason_counts": excluded_reason_counts,
        "window_count": max(1, (len(cleaned) + window_samples - 1) // window_samples),
        "window_start_sample": 1,
        "window_end_sample": len(cleaned),
        "interval_related": _interval_related_single(cleaned, len(cleaned), sample_rate_hz),
        "interval_related_rows": _interval_related_epochs(cleaned, sample_rate_hz)
        if include_interval_rows
        else [],
    }


def _build_review_artifact(
    record_id: str,
    channel: str,
    calibration_key: str,
    calibration_bytes: bytes,
    calibration_samples: List[float],
    session_key: str,
    session_bytes: bytes,
    session_samples: List[float],
    sample_rate_hz: int,
) -> Dict[str, Any]:
    return {
        "record_id": record_id,
        "channel": channel,
        "sample_rate_hz": sample_rate_hz,
        "calibration": _build_review_section_from_samples(
            calibration_key,
            len(calibration_bytes),
            calibration_samples,
            sample_rate_hz,
            include_interval_rows=False,
        ),
        "session": _build_review_section_from_samples(
            session_key,
            len(session_bytes),
            session_samples,
            sample_rate_hz,
            include_interval_rows=True,
        ),
    }


def _artifact_type_for_channel(channel: str) -> str:
    return f"review_{channel.lower()}"


def _process_review_artifacts_for_record(record_id: str) -> None:
    logger.info("[PROCESSING] start record_id=%s", record_id)
    _upsert_processed_record(record_id, status="processing", error_message=None)
    try:
        record = _fetch_recording_by_id(record_id)
        session_key = record.get("session_object_key")
        calibration_key = record.get("calibration_object_key")
        if not session_key or not calibration_key:
            raise HTTPException(
                status_code=400,
                detail="Missing session_object_key or calibration_object_key in record.",
            )

        sample_rate_hz = int(record.get("sample_rate_hz") or DEFAULT_SAMPLE_RATE_HZ)
        session_bytes = _fetch_storage_bytes(session_key)
        calibration_bytes = _fetch_storage_bytes(calibration_key)
        decoded_session = _decode_ads1298_packets(session_bytes)
        decoded_calibration = _decode_ads1298_packets(calibration_bytes)

        for channel in CHANNEL_LABELS:
            artifact = _build_review_artifact(
                record_id=record_id,
                channel=channel,
                calibration_key=calibration_key,
                calibration_bytes=calibration_bytes,
                calibration_samples=decoded_calibration.get(channel, []),
                session_key=session_key,
                session_bytes=session_bytes,
                session_samples=decoded_session.get(channel, []),
                sample_rate_hz=sample_rate_hz,
            )
            object_key = f"processed/{record_id}/{_artifact_type_for_channel(channel)}.json"
            _upload_storage_json(object_key, artifact)
            _upsert_processed_artifact(record_id, _artifact_type_for_channel(channel), object_key)
            REVIEW_ARTIFACT_CACHE[_review_cache_key(record_id, channel)] = artifact
        _upsert_processed_record(record_id, status="ready", error_message=None)
        logger.info("[PROCESSING] ready record_id=%s", record_id)
    except Exception as exc:
        _upsert_processed_record(record_id, status="error", error_message=str(exc))
        logger.exception("[PROCESSING] failed record_id=%s", record_id)
        raise


def _load_review_artifact(record_id: str, channel: str) -> Dict[str, Any]:
    cache_key = _review_cache_key(record_id, channel)
    cached = REVIEW_ARTIFACT_CACHE.get(cache_key)
    if cached is not None:
        return cached

    processed = _fetch_processed_record(record_id)
    artifact_type = _artifact_type_for_channel(channel)
    artifact_key = _fetch_processed_artifact_key(record_id, artifact_type)

    if (
        not processed
        or processed.get("status") != "ready"
        or processed.get("processing_version") != REVIEW_PROCESSING_VERSION
        or not artifact_key
    ):
        _process_review_artifacts_for_record(record_id)
        artifact_key = _fetch_processed_artifact_key(record_id, artifact_type)
        if not artifact_key:
            raise HTTPException(
                status_code=500,
                detail=f"Processed review artifact missing for record_id={record_id}, channel={channel}.",
            )
    artifact = _fetch_storage_json(artifact_key)
    REVIEW_ARTIFACT_CACHE[cache_key] = artifact
    return artifact


def _build_review_section(
    object_key: str,
    raw_bytes: bytes,
    channel: str,
    sample_rate_hz: int,
    window_index: int = 1,
    window_seconds: Optional[int] = None,
) -> Dict[str, Any]:
    decoded_channels = _decode_ads1298_packets(raw_bytes)
    all_samples = decoded_channels.get(channel, [])
    selected_samples = all_samples
    window_count = 1
    bounded_window_index = 1
    window_start_sample = 1
    window_end_sample = len(selected_samples)

    if window_seconds is not None and window_seconds > 0:
        window_sample_count = window_seconds * sample_rate_hz
        window_count = max(1, (len(all_samples) + window_sample_count - 1) // window_sample_count)
        bounded_window_index = max(1, min(window_index, window_count))
        window_start = (bounded_window_index - 1) * window_sample_count
        window_end = min(len(all_samples), window_start + window_sample_count)
        selected_samples = all_samples[window_start:window_end]
        window_start_sample = window_start + 1 if selected_samples else 1
        window_end_sample = window_end

    processed = _process_window(selected_samples, sample_rate_hz)
    cleaned = processed.get("cleaned", [])
    r_peaks = processed.get("r_peaks", [])
    signal_markers = _delineate_signal_peaks(cleaned, r_peaks, sample_rate_hz)
    beats = _segment_heartbeats(cleaned, r_peaks, sample_rate_hz)
    interval_related = _interval_related_single(selected_samples, len(selected_samples), sample_rate_hz)
    interval_related_rows = _interval_related_epochs(all_samples, sample_rate_hz)
    return {
        "meta": {
            "object_key": object_key,
            "byte_length": len(raw_bytes),
            "sample_count": len(all_samples),
        },
        "signal": {
            "full": cleaned if cleaned else selected_samples,
            "r_peaks": r_peaks,
            "markers": signal_markers,
        },
        "beats": {
            "count": len(beats),
            "items": beats,
        },
        "window_index": bounded_window_index,
        "window_count": window_count,
        "window_start_sample": window_start_sample,
        "window_end_sample": window_end_sample,
        "interval_related": interval_related,
        "interval_related_rows": interval_related_rows,
    }


def _latest_live_record_id() -> Optional[str]:
    latest_record_id: Optional[str] = None
    latest_updated_at = ""
    for record_id, state in LIVE_SESSION_STATE.items():
        snapshot = state.get("snapshot")
        updated_at = snapshot.get("updated_at", "") if isinstance(snapshot, dict) else ""
        if snapshot and updated_at >= latest_updated_at:
            latest_record_id = record_id
            latest_updated_at = updated_at
    return latest_record_id


def _live_session_status(state: Optional[Dict[str, Any]]) -> str:
    if not state:
        return "missing"
    return "active" if bool(state.get("is_active")) else "ended"


def _delineate_summary(
    cleaned: List[float],
    info: Dict[str, Any],
    sample_rate_hz: int,
) -> Dict[str, int]:
    try:
        rpeaks = info.get("ECG_R_Peaks", [])
        if len(cleaned) < max(5, int(sample_rate_hz * 0.12)) or not rpeaks:
            return {"p_peaks": 0, "qrs_peaks": 0, "t_peaks": 0}
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
        if "too small to be segmented" not in str(exc).lower():
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


class CalibrationSignalQualityResponse(BaseModel):
    quality_percentage: float
    signal_suitable: bool
    calibration_object_key: str
    byte_length: int
    packet_count: int
    sample_count_per_channel: int
    preview: Dict[str, List[float]]


class SessionStartRequest(BaseModel):
    user_id: str
    session_id: str
    calibration_object_key: str
    start_time: Optional[str] = None


class SessionStartResponse(BaseModel):
    record_id: str
    session_object_key: str


class SessionUploadResponse(BaseModel):
    record_id: str
    session_object_key: str
    byte_length: int
    packet_count: int
    sample_count_per_channel: int
    duration_ms: int


class ReviewMeta(BaseModel):
    object_key: str
    byte_length: int
    sample_count: int


class ReviewSignal(BaseModel):
    full: List[float]
    r_peaks: List[int]
    markers: Dict[str, List[int]] = Field(default_factory=dict)


class BeatMarkers(BaseModel):
    P: List[int] = Field(default_factory=list)
    Q: List[int] = Field(default_factory=list)
    R: List[int] = Field(default_factory=list)
    S: List[int] = Field(default_factory=list)
    T: List[int] = Field(default_factory=list)
    P_Onsets: List[int] = Field(default_factory=list)
    P_Offsets: List[int] = Field(default_factory=list)
    R_Onsets: List[int] = Field(default_factory=list)
    R_Offsets: List[int] = Field(default_factory=list)
    T_Onsets: List[int] = Field(default_factory=list)
    T_Offsets: List[int] = Field(default_factory=list)


class ReviewBeat(BaseModel):
    index: int
    start_sample: int = 1
    end_sample: int = 1
    window_index: int = 1
    window_start_sample: int = 1
    window_end_sample: int = 1
    markers: BeatMarkers
    exclude_from_analysis: bool = False
    exclusion_reasons: List[str] = Field(default_factory=list)
    qr_duration_samples: Optional[int] = None
    qr_duration_ms: Optional[float] = None


class ReviewBeats(BaseModel):
    count: int
    items: List[ReviewBeat]


class ReviewIntervalRow(BaseModel):
    interval_index: int
    start_s: float
    end_s: float
    sample_count: int
    ECG_Rate_Mean: Optional[float] = None


class ReviewSection(BaseModel):
    meta: ReviewMeta
    signal: ReviewSignal
    beats: ReviewBeats
    beat_count_total: int = 0
    beat_count_included: int = 0
    beat_count_excluded: int = 0
    excluded_reason_counts: Dict[str, int] = Field(default_factory=dict)
    window_count: int = 1
    window_start_sample: int = 1
    window_end_sample: int = 0
    interval_related: Optional[ReviewIntervalRow] = None
    interval_related_rows: List[ReviewIntervalRow] = Field(default_factory=list)


class ReviewResponse(BaseModel):
    record_id: str
    channel: str
    sample_rate_hz: int
    calibration: ReviewSection
    session: ReviewSection


class ReviewSessionWindowResponse(BaseModel):
    record_id: str
    channel: str
    sample_rate_hz: int
    session: ReviewSection


class VectorBeatResponse(BaseModel):
    record_id: str
    section: str
    sample_rate_hz: int
    beat_count: int
    beat_index: int
    start_sample: int
    end_sample: int
    exclude_from_analysis: bool = False
    exclusion_reasons: List[str] = Field(default_factory=list)
    qr_duration_ms: Optional[float] = None
    markers: BeatMarkers
    max_abs_lead_i: float = 0.0
    max_abs_lead_ii: float = 0.0
    lead_i: List[float] = Field(default_factory=list)
    lead_ii: List[float] = Field(default_factory=list)


class SessionSignalQualityResponse(BaseModel):
    record_id: str
    session_id: Optional[str] = None
    packet_count_received: int
    total_packets_buffered: int
    samples_analyzed: int
    window_seconds: float
    quality_percentage: float
    signal_ok: bool
    abnormal_detected: bool
    reason_codes: List[str]
    heart_rate_bpm: Optional[float] = None


class LiveSessionMarkers(BaseModel):
    P: List[int] = Field(default_factory=list)
    Q: List[int] = Field(default_factory=list)
    R: List[int] = Field(default_factory=list)
    S: List[int] = Field(default_factory=list)
    T: List[int] = Field(default_factory=list)


class LiveSessionSnapshotResponse(BaseModel):
    record_id: str
    session_id: Optional[str] = None
    status: str
    channel: str
    updated_at: str
    ended_at: Optional[str] = None
    total_packets_buffered: int
    samples_analyzed: int
    window_seconds: float
    quality_percentage: float
    signal_ok: bool
    abnormal_detected: bool
    reason_codes: List[str]
    heart_rate_bpm: Optional[float] = None
    signal: ReviewSignal
    markers: LiveSessionMarkers
    interval_related: Optional[ReviewIntervalRow] = None


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



@app.post("/calibration_signal_quality_check", response_model=CalibrationSignalQualityResponse)
async def calibration_signal_quality_check(
    request: Request,
) -> CalibrationSignalQualityResponse:
    data = await request.body()
    stats = _packet_stats(data)
    run_id = request.headers.get("X-Run-Id") or f"calibration_{uuid4().hex}"
    object_key = f"calibration/{run_id}.bin"

    logger.info(
        "[CALIBRATION] received run_id=%s byte_length=%s packet_count=%s sample_count_per_channel=%s remainder=%s",
        run_id,
        stats["byte_length"],
        stats["packet_count"],
        stats["sample_count_per_channel"],
        stats["remainder"],
    )

    if stats["packet_count"] == 0:
        raise HTTPException(
            status_code=400,
            detail="No complete ECG packets received.",
        )
    if stats["remainder"] != 0:
        raise HTTPException(
            status_code=400,
            detail=f"Payload length is not a multiple of packet size {PACKET_BYTES}.",
        )

    channels = _decode_ads1298_packets(data)
    ch2 = channels.get("CH2", [])
    if not ch2:
        raise HTTPException(status_code=400, detail="Decoded calibration signal is empty.")
    calibration_result = _process_window(ch2, DEFAULT_SAMPLE_RATE_HZ)
    quality_percentage = round(
        _quality_to_percentage(calibration_result.get("quality")),
        2,
    )
    signal_suitable = (
        quality_percentage >= 70.0
        and bool(calibration_result.get("cleaned"))
        and bool(calibration_result.get("r_peaks"))
    )
    previews = _build_cleaned_previews(channels, DEFAULT_SAMPLE_RATE_HZ)

    LAST_CALIBRATION_SAMPLES.clear()
    LAST_CALIBRATION_SAMPLES.extend(calibration_result.get("cleaned", []))
    LAST_CALIBRATION_META["byte_length"] = stats["byte_length"]
    LAST_CALIBRATION_META["sample_count"] = stats["sample_count_per_channel"]

    stored_object_key = ""
    if signal_suitable:
        _upload_storage_bytes(object_key, data)
        stored_object_key = object_key

    logger.info(
        "[CALIBRATION] response run_id=%s quality_percentage=%.2f signal_suitable=%s stored_object_key=%s cleaned_samples=%s r_peaks=%s preview_lengths=%s",
        run_id,
        quality_percentage,
        signal_suitable,
        stored_object_key or "none",
        len(calibration_result.get("cleaned", [])),
        len(calibration_result.get("r_peaks", [])),
        {label: len(previews.get(label, [])) for label in CHANNEL_LABELS},
    )

    return CalibrationSignalQualityResponse(
        quality_percentage=quality_percentage,
        signal_suitable=signal_suitable,
        calibration_object_key=stored_object_key,
        byte_length=stats["byte_length"],
        packet_count=stats["packet_count"],
        sample_count_per_channel=stats["sample_count_per_channel"],
        preview=previews,
    )


@app.post("/session_signal_quality_check", response_model=SessionSignalQualityResponse)
async def session_signal_quality_check(
    request: Request,
) -> SessionSignalQualityResponse:
    data = await request.body()
    stats = _packet_stats(data)
    record_id = request.headers.get("X-Record-Id") or "unknown-record"
    session_id = request.headers.get("X-Session-Id")

    logger.info(
        "[SESSION_CHECK] received record_id=%s session_id=%s byte_length=%s packet_count=%s sample_count_per_channel=%s remainder=%s",
        record_id,
        session_id,
        stats["byte_length"],
        stats["packet_count"],
        stats["sample_count_per_channel"],
        stats["remainder"],
    )

    if stats["packet_count"] == 0:
        raise HTTPException(status_code=400, detail="No complete ECG packets received.")
    if stats["remainder"] != 0:
        raise HTTPException(
            status_code=400,
            detail=f"Payload length is not a multiple of packet size {PACKET_BYTES}.",
        )

    state = LIVE_SESSION_STATE.setdefault(
        record_id,
        {
            "session_id": session_id,
            "buffer": bytearray(),
            "total_packets_received": 0,
            "last_hr_bpm": None,
            "snapshot": None,
            "is_active": True,
            "ended_at": None,
        },
    )
    state["session_id"] = session_id or state.get("session_id")
    state["is_active"] = True
    state["ended_at"] = None
    state["buffer"].extend(data)
    state["total_packets_received"] += stats["packet_count"]

    max_buffer_bytes = LIVE_SESSION_WINDOW_PACKETS * PACKET_BYTES
    if len(state["buffer"]) > max_buffer_bytes:
        state["buffer"] = state["buffer"][-max_buffer_bytes:]

    buffered_payload = bytes(state["buffer"])
    buffered_stats = _packet_stats(buffered_payload)
    channels = _decode_ads1298_packets(buffered_payload)
    ch2 = channels.get("CH2", [])
    result = _process_window(ch2, DEFAULT_SAMPLE_RATE_HZ)
    quality_percentage = round(_quality_to_percentage(result.get("quality")), 2)
    heart_rate_bpm = result.get("metrics", {}).get("avg_hr_bpm")
    reason_codes: List[str] = []

    if quality_percentage < 50.0:
        reason_codes.append("poor_signal_quality")
    if heart_rate_bpm is not None and heart_rate_bpm < 45.0:
        reason_codes.append("bradycardia")
    if heart_rate_bpm is not None and heart_rate_bpm > 190.0:
        reason_codes.append("tachycardia")
    previous_hr = state.get("last_hr_bpm")
    if (
        previous_hr is not None
        and heart_rate_bpm is not None
        and abs(float(heart_rate_bpm) - float(previous_hr)) >= 40.0
    ):
        reason_codes.append("abrupt_hr_shift")
    if len(result.get("r_peaks", [])) < 2 and len(ch2) >= DEFAULT_SAMPLE_RATE_HZ * 4:
        reason_codes.append("insufficient_r_peaks")
    if result.get("cleaned"):
        recent = result["cleaned"][-DEFAULT_SAMPLE_RATE_HZ :]
        if recent and (max(recent) - min(recent)) < 0.05:
            reason_codes.append("possible_flatline")

    state["last_hr_bpm"] = heart_rate_bpm
    signal_ok = quality_percentage >= 50.0
    abnormal_detected = len(reason_codes) > 0
    window_seconds = round(
        buffered_stats["sample_count_per_channel"] / DEFAULT_SAMPLE_RATE_HZ,
        2,
    )
    interval_related = _interval_related_single(
        result.get("signals"),
        buffered_stats["sample_count_per_channel"],
        DEFAULT_SAMPLE_RATE_HZ,
    )
    markers = _delineate_signal_peaks(
        result.get("cleaned", []),
        result.get("r_peaks", []),
        DEFAULT_SAMPLE_RATE_HZ,
    )
    updated_at = datetime.now(timezone.utc).isoformat()

    state["snapshot"] = {
        "record_id": record_id,
        "session_id": state.get("session_id"),
        "status": _live_session_status(state),
        "channel": "CH2",
        "updated_at": updated_at,
        "ended_at": state.get("ended_at"),
        "total_packets_buffered": buffered_stats["packet_count"],
        "samples_analyzed": buffered_stats["sample_count_per_channel"],
        "window_seconds": window_seconds,
        "quality_percentage": quality_percentage,
        "signal_ok": signal_ok,
        "abnormal_detected": abnormal_detected,
        "reason_codes": list(reason_codes),
        "heart_rate_bpm": heart_rate_bpm,
        "signal": {
            "full": result.get("cleaned", []),
            "r_peaks": result.get("r_peaks", []),
        },
        "markers": markers,
        "interval_related": interval_related,
    }

    response = SessionSignalQualityResponse(
        record_id=record_id,
        session_id=state.get("session_id"),
        packet_count_received=stats["packet_count"],
        total_packets_buffered=buffered_stats["packet_count"],
        samples_analyzed=buffered_stats["sample_count_per_channel"],
        window_seconds=window_seconds,
        quality_percentage=quality_percentage,
        signal_ok=signal_ok,
        abnormal_detected=abnormal_detected,
        reason_codes=reason_codes,
        heart_rate_bpm=heart_rate_bpm,
    )
    logger.info(
        "[SESSION_CHECK] response record_id=%s quality_percentage=%.2f signal_ok=%s abnormal_detected=%s reasons=%s heart_rate_bpm=%s samples_analyzed=%s marker_counts=%s",
        record_id,
        response.quality_percentage,
        response.signal_ok,
        response.abnormal_detected,
        ",".join(response.reason_codes) if response.reason_codes else "none",
        response.heart_rate_bpm,
        response.samples_analyzed,
        {key: len(value) for key, value in markers.items()},
    )
    return response


@app.get("/session/live", response_model=LiveSessionSnapshotResponse)
async def session_live(record_id: Optional[str] = None) -> LiveSessionSnapshotResponse:
    selected_record_id = record_id or _latest_live_record_id()
    if not selected_record_id:
        raise HTTPException(status_code=404, detail="No live session snapshot available.")

    state = LIVE_SESSION_STATE.get(selected_record_id)
    snapshot = state.get("snapshot") if state else None
    if not isinstance(snapshot, dict):
        raise HTTPException(
            status_code=404,
            detail=f"No live session snapshot available for record_id={selected_record_id}.",
        )

    logger.info(
        "[SESSION_LIVE] served record_id=%s updated_at=%s samples_analyzed=%s quality_percentage=%.2f abnormal_detected=%s",
        selected_record_id,
        snapshot.get("updated_at"),
        snapshot.get("samples_analyzed"),
        float(snapshot.get("quality_percentage", 0.0)),
        snapshot.get("abnormal_detected"),
    )
    return LiveSessionSnapshotResponse(**snapshot)


@app.post("/session/start", response_model=SessionStartResponse)
async def session_start(payload: SessionStartRequest) -> SessionStartResponse:
    config = _get_supabase_config()
    session_object_key = f"session/{payload.session_id}.bin"
    logger.info(
        "[SESSION_START] received user_id=%s session_id=%s calibration_object_key=%s start_time=%s",
        payload.user_id,
        payload.session_id,
        payload.calibration_object_key,
        payload.start_time,
    )
    record = _insert_recording_row(
        {
            "user_id": payload.user_id,
            "bucket": config["bucket"],
            "session_object_key": session_object_key,
            "calibration_object_key": payload.calibration_object_key,
            "encoding": "ads1298_24be_mv",
            "sample_rate_hz": 500,
            "channels": 3,
            "sample_count": 0,
            "duration_ms": 0,
            "start_time": payload.start_time,
            "byte_length": 0,
            "notes": json.dumps(
                {
                    "channel_labels": CHANNEL_LABELS,
                    "packet_bytes": PACKET_BYTES,
                    "samples_per_packet": SAMPLES_PER_PACKET,
                    "encoding": "ads1298_24be_mv",
                }
            ),
        }
    )
    response = SessionStartResponse(
        record_id=str(record["id"]),
        session_object_key=session_object_key,
    )
    LIVE_SESSION_STATE[str(record["id"])] = {
        "session_id": payload.session_id,
        "buffer": bytearray(),
        "total_packets_received": 0,
        "last_hr_bpm": None,
        "snapshot": None,
        "is_active": True,
        "ended_at": None,
    }
    logger.info(
        "[SESSION_START] response record_id=%s session_object_key=%s",
        response.record_id,
        response.session_object_key,
    )
    return response


@app.post("/session/{record_id}/upload", response_model=SessionUploadResponse)
async def session_upload(record_id: str, request: Request) -> SessionUploadResponse:
    payload = await request.body()
    session_id = request.headers.get("X-Session-Id")
    user_id = request.headers.get("X-User-Id")
    start_time = request.headers.get("X-Start-Time")
    if not session_id or not user_id:
        raise HTTPException(
            status_code=400,
            detail="Missing X-Session-Id or X-User-Id header.",
        )

    stats = _packet_stats(payload)
    logger.info(
        "[SESSION_UPLOAD] received record_id=%s session_id=%s user_id=%s byte_length=%s packet_count=%s sample_count_per_channel=%s remainder=%s",
        record_id,
        session_id,
        user_id,
        stats["byte_length"],
        stats["packet_count"],
        stats["sample_count_per_channel"],
        stats["remainder"],
    )
    if stats["packet_count"] == 0:
        raise HTTPException(status_code=400, detail="No complete ECG packets received.")
    if stats["remainder"] != 0:
        raise HTTPException(
            status_code=400,
            detail=f"Payload length is not a multiple of packet size {PACKET_BYTES}.",
        )

    session_object_key = f"session/{session_id}.bin"
    _upload_storage_bytes(session_object_key, payload)
    duration_ms = round((stats["sample_count_per_channel"] / 500) * 1000)
    _update_recording_row(
        record_id,
        {
            "user_id": user_id,
            "session_object_key": session_object_key,
            "sample_count": stats["sample_count_per_channel"],
            "duration_ms": duration_ms,
            "start_time": start_time,
            "byte_length": stats["byte_length"],
            "encoding": "ads1298_24be_mv",
            "sample_rate_hz": 500,
            "channels": 3,
            "notes": json.dumps(
                {
                    "channel_labels": CHANNEL_LABELS,
                    "packet_bytes": PACKET_BYTES,
                    "samples_per_packet": SAMPLES_PER_PACKET,
                    "encoding": "ads1298_24be_mv",
                    "packet_count": stats["packet_count"],
                }
            ),
        },
    )
    try:
        _process_review_artifacts_for_record(record_id)
    except Exception as exc:  # pragma: no cover - safeguard
        logger.error("[SESSION_UPLOAD] review_processing_failed record_id=%s error=%s", record_id, exc)
    response = SessionUploadResponse(
        record_id=record_id,
        session_object_key=session_object_key,
        byte_length=stats["byte_length"],
        packet_count=stats["packet_count"],
        sample_count_per_channel=stats["sample_count_per_channel"],
        duration_ms=duration_ms,
    )
    state = LIVE_SESSION_STATE.get(record_id)
    if state is not None:
        ended_at = datetime.now(timezone.utc).isoformat()
        state["is_active"] = False
        state["ended_at"] = ended_at
        snapshot = state.get("snapshot")
        if isinstance(snapshot, dict):
            snapshot["status"] = "ended"
            snapshot["ended_at"] = ended_at
            snapshot["updated_at"] = ended_at
    logger.info(
        "[SESSION_UPLOAD] response record_id=%s session_object_key=%s duration_ms=%s",
        response.record_id,
        response.session_object_key,
        response.duration_ms,
    )
    return response

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


@app.get("/review/latest", response_model=ReviewResponse)
async def review_latest(channel: str = "CH2", session_window_index: int = 1) -> ReviewResponse:
    latest_id = _fetch_latest_recording_id()
    if not latest_id:
        raise HTTPException(status_code=404, detail="No recordings found.")
    return await review_record(
        latest_id,
        channel=channel,
        session_window_index=session_window_index,
    )


@app.get("/review/{record_id}", response_model=ReviewResponse)
async def review_record(
    record_id: str,
    channel: str = "CH2",
    session_window_index: int = 1,
) -> ReviewResponse:
    selected_channel = (channel or "CH2").upper()
    if selected_channel not in CHANNEL_LABELS:
        raise HTTPException(status_code=400, detail="Invalid channel.")

    logger.info(
        "[REVIEW] request record_id=%s channel=%s",
        record_id,
        selected_channel,
    )
    artifact = _load_review_artifact(record_id, selected_channel)
    calibration_section = artifact.get("calibration", {})
    session_section = artifact.get("session", {})
    sample_rate_hz = int(artifact.get("sample_rate_hz") or DEFAULT_SAMPLE_RATE_HZ)

    logger.info(
        "[REVIEW] response record_id=%s channel=%s calibration_samples=%s calibration_beats=%s session_samples=%s session_beats=%s session_intervals=%s",
        record_id,
        selected_channel,
        calibration_section["meta"]["sample_count"],
        calibration_section["beats"]["count"],
        session_section["meta"]["sample_count"],
        session_section["beats"]["count"],
        len(session_section["interval_related_rows"]),
    )
    return ReviewResponse(
        record_id=record_id,
        channel=selected_channel,
        sample_rate_hz=sample_rate_hz,
        calibration=ReviewSection(**calibration_section),
        session=ReviewSection(**session_section),
    )


@app.get("/review/{record_id}/session_window", response_model=ReviewSessionWindowResponse)
async def review_session_window(
    record_id: str,
    channel: str = "CH2",
    session_window_index: int = 1,
) -> ReviewSessionWindowResponse:
    selected_channel = (channel or "CH2").upper()
    if selected_channel not in CHANNEL_LABELS:
        raise HTTPException(status_code=400, detail="Invalid channel.")

    logger.info(
        "[REVIEW] session_window request record_id=%s channel=%s session_window_index=%s",
        record_id,
        selected_channel,
        session_window_index,
    )
    artifact = _load_review_artifact(record_id, selected_channel)
    sample_rate_hz = int(artifact.get("sample_rate_hz") or DEFAULT_SAMPLE_RATE_HZ)
    session_section = artifact.get("session", {})
    signal = session_section.get("signal", {}).get("full", []) or []
    window_samples = sample_rate_hz * 20
    window_count = max(1, (len(signal) + window_samples - 1) // window_samples)
    bounded_window_index = max(1, min(session_window_index, window_count))
    start_index = (bounded_window_index - 1) * window_samples
    end_index = min(len(signal), start_index + window_samples)
    session_beats = session_section.get("beats", {}).get("items", []) or []
    session_window = {
        **session_section,
        "signal": {
            **(session_section.get("signal", {}) or {}),
            "full": signal[start_index:end_index],
            "r_peaks": [
                peak - start_index
                for peak in (session_section.get("signal", {}).get("r_peaks", []) or [])
                if start_index <= peak < end_index
            ],
        },
        "beats": {
            "count": len([beat for beat in session_beats if beat.get("window_index") == bounded_window_index]),
            "items": [beat for beat in session_beats if beat.get("window_index") == bounded_window_index],
        },
        "window_count": window_count,
        "window_start_sample": start_index + 1 if signal else 1,
        "window_end_sample": end_index,
    }
    logger.info(
        "[REVIEW] session_window response record_id=%s channel=%s session_window=%s/%s session_window_samples=%s session_beats=%s",
        record_id,
        selected_channel,
        bounded_window_index,
        window_count,
        len(session_window["signal"]["full"]),
        session_window["beats"]["count"],
    )
    return ReviewSessionWindowResponse(
        record_id=record_id,
        channel=selected_channel,
        sample_rate_hz=sample_rate_hz,
        session=ReviewSection(**session_window),
    )


@app.get("/review/{record_id}/vector_beat", response_model=VectorBeatResponse)
async def review_vector_beat(
    record_id: str,
    section: str = "calibration",
    beat_index: int = 1,
) -> VectorBeatResponse:
    selected_section = (section or "calibration").lower()
    if selected_section not in {"calibration", "session"}:
        raise HTTPException(status_code=400, detail="Invalid section.")

    logger.info(
        "[VECTOR] request record_id=%s section=%s beat_index=%s",
        record_id,
        selected_section,
        beat_index,
    )

    lead_i_artifact = _load_review_artifact(record_id, "CH2")
    lead_ii_artifact = _load_review_artifact(record_id, "CH3")
    sample_rate_hz = int(lead_i_artifact.get("sample_rate_hz") or DEFAULT_SAMPLE_RATE_HZ)

    lead_i_section = lead_i_artifact.get(selected_section, {})
    lead_ii_section = lead_ii_artifact.get(selected_section, {})
    lead_i_signal = lead_i_section.get("signal", {}).get("full", []) or []
    lead_ii_signal = lead_ii_section.get("signal", {}).get("full", []) or []
    max_abs_lead_i = max((abs(float(value)) for value in lead_i_signal), default=0.0)
    max_abs_lead_ii = max((abs(float(value)) for value in lead_ii_signal), default=0.0)
    beats = lead_i_section.get("beats", {}).get("items", []) or []
    beat_count = len(beats)
    if beat_count == 0:
        raise HTTPException(status_code=404, detail="No beats available for vector visualization.")

    bounded_index = max(1, min(beat_index, beat_count))
    beat = next((item for item in beats if int(item.get("index", 0)) == bounded_index), beats[0])
    start_sample = int(beat.get("start_sample") or 1)
    end_sample = int(beat.get("end_sample") or start_sample)

    lead_i = lead_i_signal[max(0, start_sample - 1) : max(0, end_sample)]
    lead_ii = lead_ii_signal[max(0, start_sample - 1) : max(0, end_sample)]

    logger.info(
        "[VECTOR] response record_id=%s section=%s beat_index=%s samples=%s excluded=%s",
        record_id,
        selected_section,
        bounded_index,
        min(len(lead_i), len(lead_ii)),
        bool(beat.get("exclude_from_analysis")),
    )
    return VectorBeatResponse(
        record_id=record_id,
        section=selected_section,
        sample_rate_hz=sample_rate_hz,
        beat_count=beat_count,
        beat_index=int(beat.get("index") or bounded_index),
        start_sample=start_sample,
        end_sample=end_sample,
        exclude_from_analysis=bool(beat.get("exclude_from_analysis")),
        exclusion_reasons=list(beat.get("exclusion_reasons", []) or []),
        qr_duration_ms=_sanitize_float(beat.get("qr_duration_ms")),
        markers=BeatMarkers(**(beat.get("markers", {}) or {})),
        max_abs_lead_i=max_abs_lead_i,
        max_abs_lead_ii=max_abs_lead_ii,
        lead_i=[float(value) for value in lead_i],
        lead_ii=[float(value) for value in lead_ii],
    )


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
