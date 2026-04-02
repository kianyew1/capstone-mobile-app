from __future__ import annotations

import json
import logging
import os
import warnings
from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import uuid4
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
import neurokit2 as nk
from fastapi import FastAPI, HTTPException, Request
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

from supabase import (
    REVIEW_PROCESSING_VERSION,
    _fetch_latest_recording_id,
    _fetch_latest_live_preview_row,
    _fetch_live_preview_row,
    _fetch_processed_artifact,
    _fetch_recording_by_id,
    _fetch_storage_bytes,
    _fetch_storage_json,
    _insert_recording_row,
    _insert_session_chunk_row,
    _sg_now_iso,
    _update_recording_row,
    _upsert_live_preview_row,
    _upsert_processed_artifact,
    _upload_storage_bytes,
    _upload_storage_json,
)
from ui_previews import (
    LIVE_SESSION_STATE,
    build_cleaned_previews,
    empty_live_visual_snapshot,
    finalize_live_session_state,
    initialize_live_session_state,
    live_visual_snapshot_from_persisted_row,
    latest_live_record_id,
    refresh_live_session_state,
    trim_live_visual_snapshot,
)
from review_routes import mount_review_routes

STATUS_BYTES = 3
TIMESTAMP_BYTES = 3
BYTES_PER_SAMPLE = 3
SAMPLES_PER_PACKET = 25
CHANNELS = 3
PACKET_BYTES = STATUS_BYTES + (BYTES_PER_SAMPLE * SAMPLES_PER_PACKET * CHANNELS) + TIMESTAMP_BYTES
CHANNEL_LABELS = ["CH2", "CH3", "CH4"]
ADS1298_VREF = 2.4
ADS1298_GAIN = 6.0
ADS1298_MAX_CODE = (2**23) - 1

LAST_CALIBRATION_SAMPLES = []
LAST_CALIBRATION_META = {
    "byte_length": 0,
    "sample_count": 0,
}

DEFAULT_SAMPLE_RATE_HZ = 500
REVIEW_ARTIFACT_CACHE: Dict[tuple[str, str, str], Dict[str, Any]] = {}


def _normalize_iso_to_sg(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone(ZoneInfo("Asia/Singapore")).isoformat()
    except Exception:
        return value

def _read24_signed_be(payload: bytes, offset: int) -> int:
    value = (payload[offset] << 16) | (payload[offset + 1] << 8) | payload[offset + 2]
    if value & 0x800000:
        return value - (1 << 24)
    return value


def _read24_unsigned_be(payload: bytes, offset: int) -> int:
    return (payload[offset] << 16) | (payload[offset + 1] << 8) | payload[offset + 2]


def _counts_to_mv(count: int) -> float:
    return (count / ADS1298_MAX_CODE) * (ADS1298_VREF / ADS1298_GAIN) * 1000.0


def _effective_sps_from_stats(stats: Dict[str, int]) -> Optional[float]:
    elapsed_time_ms = stats.get("elapsed_time_ms")
    if elapsed_time_ms is None or elapsed_time_ms <= 0:
        return None
    return round(float(stats["sample_count_per_channel"]) / (elapsed_time_ms / 1000.0), 4)


def _resample_series(
    samples: List[float],
    source_rate_hz: Optional[float],
    target_rate_hz: int = DEFAULT_SAMPLE_RATE_HZ,
) -> List[float]:
    if not samples:
        return []
    if source_rate_hz is None or source_rate_hz <= 0:
        return list(samples)
    if abs(float(source_rate_hz) - float(target_rate_hz)) < 1e-6:
        return list(samples)
    try:
        resampled = nk.signal_resample(
            samples,
            sampling_rate=float(source_rate_hz),
            desired_sampling_rate=float(target_rate_hz),
            method="interpolation",
        )
        if hasattr(resampled, "tolist"):
            return resampled.tolist()
        return list(resampled)
    except Exception as exc:  # pragma: no cover - safeguard
        logger.warning(
            "[RESAMPLE] fallback_raw source_rate_hz=%s target_rate_hz=%s sample_count=%s error=%s",
            source_rate_hz,
            target_rate_hz,
            len(samples),
            exc,
        )
        return list(samples)


def _resample_channels(
    channels: Dict[str, List[float]],
    source_rate_hz: Optional[float],
    target_rate_hz: int = DEFAULT_SAMPLE_RATE_HZ,
) -> Dict[str, List[float]]:
    if source_rate_hz is None or source_rate_hz <= 0:
        return {label: list(channels.get(label, [])) for label in CHANNEL_LABELS}
    resampled: Dict[str, List[float]] = {}
    for label in CHANNEL_LABELS:
        resampled[label] = _resample_series(
            channels.get(label, []),
            source_rate_hz=source_rate_hz,
            target_rate_hz=target_rate_hz,
        )
    return resampled


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
        offset = base
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

def _packet_stats(payload: bytes) -> Dict[str, int]:
    packet_count = len(payload) // PACKET_BYTES
    sample_count_per_channel = packet_count * SAMPLES_PER_PACKET
    remainder = len(payload) % PACKET_BYTES
    elapsed_time_ms = None
    if TIMESTAMP_BYTES and packet_count > 0:
        last_offset = ((packet_count - 1) * PACKET_BYTES) + (PACKET_BYTES - TIMESTAMP_BYTES)
        if last_offset + TIMESTAMP_BYTES <= len(payload):
            elapsed_time_ms = _read24_unsigned_be(payload, last_offset)
    stats: Dict[str, int] = {
        "packet_count": packet_count,
        "sample_count_per_channel": sample_count_per_channel,
        "remainder": remainder,
        "byte_length": len(payload),
    }
    if elapsed_time_ms is not None:
        stats["elapsed_time_ms"] = int(elapsed_time_ms)
    return stats


def _handle_calibration_payload(
    *,
    data: bytes,
    run_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    stats = _packet_stats(data)
    logger.info(
        "[CALIBRATION] received run_id=%s byte_length=%s packet_count=%s sample_count_per_channel=%s remainder=%s",
        run_id,
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

    channels = _decode_ads1298_packets(data)
    effective_sps = _effective_sps_from_stats(stats)
    resampled_channels = _resample_channels(
        channels,
        source_rate_hz=effective_sps,
        target_rate_hz=DEFAULT_SAMPLE_RATE_HZ,
    )
    ch2 = resampled_channels.get("CH2", [])
    if not ch2:
        raise HTTPException(status_code=400, detail="Decoded calibration signal is empty.")
    calibration_result = _process_window(ch2, DEFAULT_SAMPLE_RATE_HZ)
    quality_percentage = 100 + round(
        _quality_to_percentage(calibration_result.get("quality")),
        2,
    )
    signal_suitable = (
        quality_percentage >= 70.0
        and bool(calibration_result.get("cleaned"))
        and bool(calibration_result.get("r_peaks"))
    )
    previews = build_cleaned_previews(
        resampled_channels,
        CHANNEL_LABELS,
        _clean_series,
        DEFAULT_SAMPLE_RATE_HZ,
    )

    logger.info(
        "[CALIBRATION] resample run_id=%s effective_sps=%s target_sps=%s raw_samples=%s resampled_samples=%s",
        run_id,
        effective_sps,
        DEFAULT_SAMPLE_RATE_HZ,
        stats["sample_count_per_channel"],
        len(ch2),
    )

    LAST_CALIBRATION_SAMPLES.clear()
    LAST_CALIBRATION_SAMPLES.extend(calibration_result.get("cleaned", []))
    LAST_CALIBRATION_META["byte_length"] = stats["byte_length"]
    LAST_CALIBRATION_META["sample_count"] = len(ch2)

    stored_object_key = ""
    if signal_suitable:
        object_key = f"calibration/{run_id}.bin"
        _upload_storage_bytes(object_key, data)
        stored_object_key = object_key

    record_id: Optional[str] = None
    if user_id and stored_object_key:
        record = _insert_recording_row(
            {
                "user_id": user_id,
                "calibration_object_key": stored_object_key,
                "session_object_key": "pending",
                "created_at": _sg_now_iso(),
                "encoding": "ads1298_24be_mv",
                "sample_rate_hz": 500,
                "elapsed_time_ms": stats.get("elapsed_time_ms"),
                "effective_sps": effective_sps,
                "channels": 3,
                "sample_count": len(ch2),
                "duration_ms": stats.get("elapsed_time_ms")
                or round((len(ch2) / DEFAULT_SAMPLE_RATE_HZ) * 1000),
                "byte_length": stats["byte_length"],
            }
        )
        record_id = str(record.get("id")) if record else None
        logger.info(
            "[CALIBRATION] record_created run_id=%s record_id=%s user_id=%s",
            run_id,
            record_id,
            user_id,
        )

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

    return {
        "quality_percentage": quality_percentage,
        "signal_suitable": signal_suitable,
        "calibration_object_key": stored_object_key,
        "byte_length": stats["byte_length"],
        "packet_count": stats["packet_count"],
        "sample_count_per_channel": stats["sample_count_per_channel"],
        "preview": previews,
        "record_id": record_id,
    }


def _review_cache_key(record_id: str, channel: str) -> tuple[str, str, str]:
    return (record_id, channel.upper(), REVIEW_PROCESSING_VERSION)


def _validate_packet_payload(payload: bytes, context: str) -> Dict[str, int]:
    stats = _packet_stats(payload)
    if stats["byte_length"] == 0:
        logger.error("[%s] empty_payload", context)
        raise HTTPException(status_code=400, detail="Empty payload.")
    if stats["remainder"] != 0:
        logger.error(
            "[%s] invalid_payload_length byte_length=%s remainder=%s",
            context,
            stats["byte_length"],
            stats["remainder"],
        )
        raise HTTPException(status_code=400, detail="Invalid payload length.")
    if "elapsed_time_ms" in stats and stats["elapsed_time_ms"] <= 0:
        logger.error(
            "[%s] invalid_elapsed_time_ms elapsed_time_ms=%s",
            context,
            stats["elapsed_time_ms"],
        )
        raise HTTPException(status_code=400, detail="Invalid elapsed_time_ms.")
    return stats


def _store_session_chunk(
    *,
    record_id: str,
    session_id: str,
    payload: bytes,
    chunk_index: int,
    context: str,
    stats: Optional[Dict[str, int]] = None,
) -> Dict[str, int]:
    stats = stats or _validate_packet_payload(payload, context)
    object_key = f"session/{session_id}/chunks/{chunk_index}.bin"
    _upload_storage_bytes(object_key, payload)
    _insert_session_chunk_row(
        {
            "record_id": record_id,
            "chunk_index": chunk_index,
            "object_key": object_key,
            "byte_length": stats["byte_length"],
            "packet_count": stats["packet_count"],
            "sample_count": stats["sample_count_per_channel"],
            "elapsed_time_ms": stats.get("elapsed_time_ms"),
            "created_at": _sg_now_iso(),
        }
    )
    logger.info(
        "[%s] chunk_stored record_id=%s session_id=%s chunk_index=%s object_key=%s packets=%s",
        context,
        record_id,
        session_id,
        chunk_index,
        object_key,
        stats["packet_count"],
    )
    return stats


def _finalize_session_upload(
    *,
    record_id: str,
    session_id: str,
    user_id: str,
    start_time: Optional[str],
    payload: bytes,
    stats: Dict[str, int],
    context: str,
) -> SessionUploadResponse:
    if stats["packet_count"] == 0:
        raise HTTPException(status_code=400, detail="No complete ECG packets received.")

    session_object_key = f"session/{session_id}.bin"
    normalized_start_time = _normalize_iso_to_sg(start_time)
    _upload_storage_bytes(session_object_key, payload)
    duration_ms = round((stats["sample_count_per_channel"] / 500) * 1000)
    effective_sps = _effective_sps_from_stats(stats)
    elapsed_time_ms = stats.get("elapsed_time_ms")
    if elapsed_time_ms:
        duration_ms = int(elapsed_time_ms)
    _update_recording_row(
        record_id,
        {
            "user_id": user_id,
            "session_object_key": session_object_key,
            "sample_count": stats["sample_count_per_channel"],
            "duration_ms": duration_ms,
            "start_time": normalized_start_time,
            "byte_length": stats["byte_length"],
            "encoding": "ads1298_24be_mv",
            "sample_rate_hz": 500,
            "channels": 3,
            "elapsed_time_ms": elapsed_time_ms,
            "effective_sps": effective_sps,
        },
    )
    try:
        _process_review_artifacts_for_record(record_id)
    except Exception as exc:  # pragma: no cover - safeguard
        logger.error(
            "[%s] review_processing_failed record_id=%s error=%s",
            context,
            record_id,
            exc,
        )
    response = SessionUploadResponse(
        record_id=record_id,
        session_object_key=session_object_key,
        byte_length=stats["byte_length"],
        packet_count=stats["packet_count"],
        sample_count_per_channel=stats["sample_count_per_channel"],
        duration_ms=duration_ms,
    )
    if record_id in LIVE_SESSION_STATE:
        finalize_live_session_state(record_id, _sg_now_iso())
    logger.info(
        "[%s] response record_id=%s session_object_key=%s duration_ms=%s",
        context,
        response.record_id,
        response.session_object_key,
        response.duration_ms,
    )
    return response


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
            warnings.simplefilter("ignore")
            try:
                from pandas.errors import ChainedAssignmentError
            except Exception:  # pragma: no cover - pandas compatibility
                ChainedAssignmentError = Warning  # type: ignore
            warnings.filterwarnings("ignore", category=ChainedAssignmentError)
            warnings.filterwarnings(
                "ignore",
                message=".*ChainedAssignmentError.*",
            )
            warnings.filterwarnings(
                "ignore",
                message=".*Copy-on-Write.*",
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

    return {
        "exclude_from_analysis": False,
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
        session_stats = _packet_stats(session_bytes)
        calibration_stats = _packet_stats(calibration_bytes)
        session_effective_sps = _effective_sps_from_stats(session_stats)
        calibration_effective_sps = _effective_sps_from_stats(calibration_stats)
        decoded_session = _resample_channels(
            _decode_ads1298_packets(session_bytes),
            source_rate_hz=session_effective_sps,
            target_rate_hz=sample_rate_hz,
        )
        decoded_calibration = _resample_channels(
            _decode_ads1298_packets(calibration_bytes),
            source_rate_hz=calibration_effective_sps,
            target_rate_hz=sample_rate_hz,
        )
        logger.info(
            "[PROCESSING] resample record_id=%s sample_rate_hz=%s calibration_effective_sps=%s calibration_raw_samples=%s calibration_resampled_samples=%s session_effective_sps=%s session_raw_samples=%s session_resampled_samples=%s",
            record_id,
            sample_rate_hz,
            calibration_effective_sps,
            calibration_stats["sample_count_per_channel"],
            len(decoded_calibration.get("CH2", [])),
            session_effective_sps,
            session_stats["sample_count_per_channel"],
            len(decoded_session.get("CH2", [])),
        )

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
            artifact_bytes = json.dumps(artifact, separators=(",", ":")).encode("utf-8")
            _upsert_processed_artifact(
                record_id,
                _artifact_type_for_channel(channel),
                object_key,
                byte_length=len(artifact_bytes),
                sample_count=len(decoded_session.get(channel, [])),
            )
            REVIEW_ARTIFACT_CACHE[_review_cache_key(record_id, channel)] = artifact
        logger.info("[PROCESSING] ready record_id=%s", record_id)
    except Exception as exc:
        logger.exception("[PROCESSING] failed record_id=%s", record_id)
        raise


def _load_review_artifact(record_id: str, channel: str) -> Dict[str, Any]:
    cache_key = _review_cache_key(record_id, channel)
    cached = REVIEW_ARTIFACT_CACHE.get(cache_key)
    if cached is not None:
        return cached

    artifact_type = _artifact_type_for_channel(channel)
    artifact_row = _fetch_processed_artifact(record_id, artifact_type)
    artifact_key = artifact_row.get("object_key") if artifact_row else None

    if (not artifact_row) or artifact_row.get("processing_version") != REVIEW_PROCESSING_VERSION or not artifact_key:
        _process_review_artifacts_for_record(record_id)
        artifact_row = _fetch_processed_artifact(record_id, artifact_type)
        artifact_key = artifact_row.get("object_key") if artifact_row else None
        if not artifact_key:
            raise HTTPException(
                status_code=500,
                detail=f"Processed review artifact missing for record_id={record_id}, channel={channel}.",
            )
    try:
        artifact = _fetch_storage_json(artifact_key)
    except HTTPException as exc:
        if exc.status_code != 502:
            raise
        logger.warning(
            "[PROCESSING] artifact fetch failed record_id=%s channel=%s object_key=%s; regenerating",
            record_id,
            channel,
            artifact_key,
        )
        _process_review_artifacts_for_record(record_id)
        artifact_row = _fetch_processed_artifact(record_id, artifact_type)
        artifact_key = artifact_row.get("object_key") if artifact_row else None
        if not artifact_key:
            raise HTTPException(
                status_code=500,
                detail=f"Processed review artifact missing after regeneration for record_id={record_id}, channel={channel}.",
            ) from exc
        artifact = _fetch_storage_json(artifact_key)
    REVIEW_ARTIFACT_CACHE[cache_key] = artifact
    return artifact

class CalibrationSignalQualityResponse(BaseModel):
    quality_percentage: float
    signal_suitable: bool
    calibration_object_key: str
    byte_length: int
    packet_count: int
    sample_count_per_channel: int
    preview: Dict[str, List[float]]


class CalibrationCompletionResponse(CalibrationSignalQualityResponse):
    record_id: Optional[str] = None


class SessionStartRequest(BaseModel):
    user_id: str
    session_id: str
    calibration_object_key: str
    start_time: Optional[str] = None
    record_id: Optional[str] = None


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


class SessionChunkResponse(BaseModel):
    record_id: str
    session_id: str
    chunk_index: int
    byte_length: int
    packet_count: int
    sample_count_per_channel: int


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
    max_abs_lead_x: float = 0.0
    max_abs_lead_y: float = 0.0
    max_abs_lead_z: float = 0.0
    lead_x: List[float] = Field(default_factory=list)
    lead_y: List[float] = Field(default_factory=list)
    lead_z: List[float] = Field(default_factory=list)
    max_abs_lead_i: float = 0.0
    max_abs_lead_ii: float = 0.0
    lead_i: List[float] = Field(default_factory=list)
    lead_ii: List[float] = Field(default_factory=list)


class Vector3DBeatResponse(BaseModel):
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
    image_png_base64: str
    progress_percent: int
    y_min_mv: float
    y_max_mv: float


class LiveVisualChannels(BaseModel):
    CH2: List[float] = Field(default_factory=list)
    CH3: List[float] = Field(default_factory=list)
    CH4: List[float] = Field(default_factory=list)


class LiveSessionVisualResponse(BaseModel):
    record_id: str
    session_id: Optional[str] = None
    status: str
    updated_at: str
    ended_at: Optional[str] = None
    sample_rate_hz: int
    buffer_samples: int
    total_samples_received: int
    heart_rate_bpm: Optional[float] = None
    channels: LiveVisualChannels


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok", "base_url": BASE_URL}

@app.post("/calibration_completion", response_model=CalibrationCompletionResponse)
async def calibration_completion(request: Request) -> CalibrationCompletionResponse:
    data = await request.body()
    run_id = request.headers.get("X-Run-Id") or f"calibration_{uuid4().hex}"
    user_id = request.headers.get("X-User-Id")
    result = _handle_calibration_payload(data=data, run_id=run_id, user_id=user_id)
    return CalibrationCompletionResponse(**result)


@app.get("/session/live/visual", response_model=LiveSessionVisualResponse)
async def session_live_visual(
    record_id: Optional[str] = None,
) -> LiveSessionVisualResponse:
    persisted_preview = None
    selected_record_id = record_id or latest_live_record_id()
    if not selected_record_id:
        persisted_preview = _fetch_latest_live_preview_row()
        selected_record_id = persisted_preview.get("record_id") if persisted_preview else None
    if not selected_record_id:
        raise HTTPException(status_code=404, detail="No live session visualization available.")

    state = LIVE_SESSION_STATE.get(selected_record_id)
    snapshot = state.get("visual_snapshot") if state else None
    if not isinstance(snapshot, dict):
        persisted_preview = persisted_preview or _fetch_live_preview_row(selected_record_id)
        if persisted_preview:
            payload = live_visual_snapshot_from_persisted_row(
                record_id=selected_record_id,
                persisted_preview=persisted_preview,
                state=state,
                default_sample_rate_hz=DEFAULT_SAMPLE_RATE_HZ,
            )
            logger.info(
                "[SESSION_LIVE_VISUAL] served_persisted record_id=%s updated_at=%s buffer_samples=%s",
                selected_record_id,
                payload.get("updated_at"),
                payload.get("buffer_samples"),
            )
            return LiveSessionVisualResponse(**payload)
        if not state:
            raise HTTPException(
                status_code=404,
                detail=f"No live session visualization available for record_id={selected_record_id}.",
            )
        payload = empty_live_visual_snapshot(
            record_id=selected_record_id,
            state=state,
            updated_at=_sg_now_iso(),
            default_sample_rate_hz=DEFAULT_SAMPLE_RATE_HZ,
        )
        logger.info(
            "[SESSION_LIVE_VISUAL] served_empty record_id=%s updated_at=%s status=%s",
            selected_record_id,
            payload.get("updated_at"),
            payload.get("status"),
        )
        return LiveSessionVisualResponse(**payload)
    payload = trim_live_visual_snapshot(snapshot, DEFAULT_SAMPLE_RATE_HZ)
    logger.info(
        "[SESSION_LIVE_VISUAL] served record_id=%s updated_at=%s buffer_samples=%s total_samples_received=%s status=%s",
        selected_record_id,
        payload.get("updated_at"),
        payload.get("buffer_samples"),
        payload.get("total_samples_received"),
        payload.get("status"),
    )
    return LiveSessionVisualResponse(**payload)


@app.post("/session/start", response_model=SessionStartResponse)
async def session_start(payload: SessionStartRequest) -> SessionStartResponse:
    session_object_key = f"session/{payload.session_id}.bin"
    normalized_start_time = _normalize_iso_to_sg(payload.start_time)
    logger.info(
        "[SESSION_START] received user_id=%s session_id=%s calibration_object_key=%s start_time=%s",
        payload.user_id,
        payload.session_id,
        payload.calibration_object_key,
        normalized_start_time,
    )
    record_id = payload.record_id
    if record_id:
        record = _fetch_recording_by_id(record_id)
        _update_recording_row(
            record_id,
            {
                "user_id": payload.user_id,
                "session_object_key": session_object_key,
                "calibration_object_key": payload.calibration_object_key,
                "encoding": "ads1298_24be_mv",
                "sample_rate_hz": 500,
                "channels": 3,
                "start_time": normalized_start_time,
            },
        )
        response_record_id = str(record.get("id"))
    else:
        record = _insert_recording_row(
            {
                "user_id": payload.user_id,
                "session_object_key": session_object_key,
                "calibration_object_key": payload.calibration_object_key,
                "encoding": "ads1298_24be_mv",
                "sample_rate_hz": 500,
                "channels": 3,
                "sample_count": 0,
                "duration_ms": 0,
                "created_at": _sg_now_iso(),
                "start_time": normalized_start_time,
                "byte_length": 0,
            }
        )
        response_record_id = str(record["id"])
    response = SessionStartResponse(
        record_id=response_record_id,
        session_object_key=session_object_key,
    )
    LIVE_SESSION_STATE[str(record["id"])] = initialize_live_session_state(payload.session_id)
    try:
        _upsert_live_preview_row(
            {
                "record_id": response.record_id,
                "ch2_preview": [],
                "ch3_preview": [],
                "ch4_preview": [],
                "sample_count": 0,
                "elapsed_time_ms": None,
                "updated_at": _sg_now_iso(),
            }
        )
    except Exception as exc:  # pragma: no cover - best effort
        logger.warning("[SESSION_START] live_preview_init_failed record_id=%s error=%s", response.record_id, exc)
    logger.info(
        "[SESSION_START] response record_id=%s session_object_key=%s",
        response.record_id,
        response.session_object_key,
    )
    return response


@app.post("/add_to_session", response_model=SessionChunkResponse)
async def add_to_session(request: Request) -> SessionChunkResponse:
    payload = await request.body()
    record_id = request.headers.get("X-Record-Id")
    session_id = request.headers.get("X-Session-Id")
    chunk_header = request.headers.get("X-Chunk-Index")
    if not record_id or not session_id:
        logger.error("[SESSION_ADD] missing_record_or_session record_id=%s session_id=%s", record_id, session_id)
        raise HTTPException(status_code=400, detail="Missing X-Record-Id or X-Session-Id header.")
    if chunk_header is None:
        logger.error("[SESSION_ADD] missing_chunk_index record_id=%s session_id=%s", record_id, session_id)
        raise HTTPException(status_code=400, detail="Missing X-Chunk-Index header.")
    try:
        chunk_index = int(chunk_header)
    except ValueError:
        logger.error(
            "[SESSION_ADD] invalid_chunk_index record_id=%s session_id=%s value=%r",
            record_id,
            session_id,
            chunk_header,
        )
        raise HTTPException(status_code=400, detail="Invalid chunk index.")

    stats = _validate_packet_payload(payload, "SESSION_ADD")
    if stats["packet_count"] == 0:
        raise HTTPException(status_code=400, detail="No complete ECG packets received.")
    try:
        _store_session_chunk(
            record_id=record_id,
            session_id=session_id,
            payload=payload,
            chunk_index=chunk_index,
            context="SESSION_ADD",
            stats=stats,
        )
    except HTTPException:
        raise
    except Exception as exc:  # pragma: no cover - unexpected failure
        logger.exception(
            "[SESSION_ADD] store_failed record_id=%s session_id=%s chunk_index=%s error=%s",
            record_id,
            session_id,
            chunk_index,
            exc,
        )
        raise HTTPException(status_code=502, detail=f"Failed to store session chunk: {exc}") from exc

    try:
        logger.info(
            "[SESSION_ADD] live_received record_id=%s session_id=%s byte_length=%s packet_count=%s sample_count_per_channel=%s remainder=%s",
            record_id,
            session_id,
            stats["byte_length"],
            stats["packet_count"],
            stats["sample_count_per_channel"],
            stats["remainder"],
        )
        live_update = refresh_live_session_state(
            record_id=record_id,
            session_id=session_id,
            stats=stats,
            channels=_decode_ads1298_packets(payload),
            updated_at=_sg_now_iso(),
            default_sample_rate_hz=DEFAULT_SAMPLE_RATE_HZ,
            samples_per_packet=SAMPLES_PER_PACKET,
            empty_beat_markers_factory=_empty_beat_markers,
        )
        _upsert_live_preview_row(live_update["live_preview_row"])
        _update_recording_row(record_id, live_update["recording_update"])
    except Exception as exc:  # pragma: no cover - keep storage alive
        logger.exception(
            "[SESSION_ADD] live_preview_failed record_id=%s session_id=%s chunk_index=%s error=%s",
            record_id,
            session_id,
            chunk_index,
            exc,
        )
    return SessionChunkResponse(
        record_id=record_id,
        session_id=session_id,
        chunk_index=chunk_index,
        byte_length=stats["byte_length"],
        packet_count=stats["packet_count"],
        sample_count_per_channel=stats["sample_count_per_channel"],
    )


@app.post("/end_session", response_model=SessionUploadResponse)
async def end_session(request: Request) -> SessionUploadResponse:
    payload = await request.body()
    record_id = request.headers.get("X-Record-Id")
    session_id = request.headers.get("X-Session-Id")
    user_id = request.headers.get("X-User-Id")
    start_time = request.headers.get("X-Start-Time")
    if not record_id or not session_id or not user_id:
        logger.error(
            "[SESSION_END] missing_headers record_id=%s session_id=%s user_id=%s",
            record_id,
            session_id,
            user_id,
        )
        raise HTTPException(
            status_code=400,
            detail="Missing X-Record-Id, X-Session-Id, or X-User-Id header.",
        )
    stats = _validate_packet_payload(payload, "SESSION_END")
    return _finalize_session_upload(
        record_id=record_id,
        session_id=session_id,
        user_id=user_id,
        start_time=start_time,
        payload=payload,
        stats=stats,
        context="SESSION_END",
    )

mount_review_routes(
    app,
    default_sample_rate_hz=DEFAULT_SAMPLE_RATE_HZ,
    channel_labels=CHANNEL_LABELS,
    logger=logger,
    review_response_model=ReviewResponse,
    review_section_model=ReviewSection,
    vector_beat_response_model=VectorBeatResponse,
    vector3d_beat_response_model=Vector3DBeatResponse,
    beat_markers_model=BeatMarkers,
    fetch_latest_recording_id=_fetch_latest_recording_id,
    load_review_artifact=_load_review_artifact,
    sanitize_float=_sanitize_float,
)
