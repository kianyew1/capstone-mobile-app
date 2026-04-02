import logging
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("ecg-backend")

LIVE_SESSION_STATE: Dict[str, Dict[str, Any]] = {}
LIVE_VISUAL_BUFFER_SAMPLES = 4000


def initialize_live_session_state(session_id: Optional[str]) -> Dict[str, Any]:
    return {
        "session_id": session_id,
        "total_packets_received": 0,
        "total_samples_received": 0,
        "elapsed_time_ms": None,
        "effective_sps": None,
        "last_hr_bpm": None,
        "preview_ch2": [],
        "preview_ch3": [],
        "preview_ch4": [],
        "snapshot": None,
        "visual_snapshot": None,
        "is_active": True,
        "ended_at": None,
    }


def ensure_live_session_state(record_id: str, session_id: Optional[str]) -> Dict[str, Any]:
    state = LIVE_SESSION_STATE.setdefault(record_id, initialize_live_session_state(session_id))
    state["session_id"] = session_id or state.get("session_id")
    state["is_active"] = True
    state["ended_at"] = None
    state.setdefault("total_packets_received", 0)
    state.setdefault("total_samples_received", 0)
    state.setdefault("preview_ch2", [])
    state.setdefault("preview_ch3", [])
    state.setdefault("preview_ch4", [])
    return state


def latest_live_record_id() -> Optional[str]:
    latest_record_id: Optional[str] = None
    latest_updated_at = ""
    for record_id, state in LIVE_SESSION_STATE.items():
        snapshot = state.get("snapshot")
        updated_at = snapshot.get("updated_at", "") if isinstance(snapshot, dict) else ""
        if snapshot and updated_at >= latest_updated_at:
            latest_record_id = record_id
            latest_updated_at = updated_at
    return latest_record_id


def live_session_status(state: Optional[Dict[str, Any]]) -> str:
    if not state:
        return "missing"
    return "active" if bool(state.get("is_active")) else "ended"


def trim_live_visual_snapshot(
    snapshot: Dict[str, Any],
    default_sample_rate_hz: int,
) -> Dict[str, Any]:
    sample_rate_hz = int(snapshot.get("sample_rate_hz") or default_sample_rate_hz)
    channels = snapshot.get("channels") or {}
    trimmed_channels = {
        "CH2": list(channels.get("CH2") or []),
        "CH3": list(channels.get("CH3") or []),
        "CH4": list(channels.get("CH4") or []),
    }

    return {
        "record_id": snapshot.get("record_id"),
        "session_id": snapshot.get("session_id"),
        "status": snapshot.get("status"),
        "updated_at": snapshot.get("updated_at"),
        "ended_at": snapshot.get("ended_at"),
        "sample_rate_hz": sample_rate_hz,
        "buffer_samples": len(trimmed_channels["CH2"]),
        "total_samples_received": int(snapshot.get("total_samples_received") or 0),
        "heart_rate_bpm": snapshot.get("heart_rate_bpm"),
        "channels": trimmed_channels,
    }


def preview_series(samples: List[float], preview_samples: int = 2500) -> List[float]:
    limited = list(samples[:preview_samples])
    if not limited:
        return []
    mean = sum(limited) / len(limited)
    max_abs = max(abs(value - mean) for value in limited) or 1.0
    return [(value - mean) / max_abs for value in limited]


def build_cleaned_previews(
    channels: Dict[str, List[float]],
    channel_labels: List[str],
    clean_series: Callable[[List[float], int], List[float]],
    sample_rate_hz: int,
    preview_samples: int = 2500,
) -> Dict[str, List[float]]:
    previews: Dict[str, List[float]] = {}
    for label in channel_labels:
        cleaned = clean_series(channels.get(label, []), sample_rate_hz)
        previews[label] = preview_series(cleaned, preview_samples=preview_samples)
    return previews


def _trim_preview_channel(samples: List[float]) -> List[float]:
    if len(samples) <= LIVE_VISUAL_BUFFER_SAMPLES:
        return samples
    return samples[-LIVE_VISUAL_BUFFER_SAMPLES:]


def refresh_live_session_state(
    *,
    record_id: str,
    session_id: Optional[str],
    stats: Dict[str, int],
    channels: Dict[str, List[float]],
    updated_at: str,
    default_sample_rate_hz: int,
    samples_per_packet: int,
    empty_beat_markers_factory: Callable[[], Dict[str, List[int]]],
) -> Dict[str, Any]:
    state = ensure_live_session_state(record_id, session_id)
    state["total_packets_received"] += stats["packet_count"]
    state["total_samples_received"] += stats["sample_count_per_channel"]
    if "elapsed_time_ms" in stats:
        state["elapsed_time_ms"] = stats.get("elapsed_time_ms")
    if state.get("elapsed_time_ms"):
        state["effective_sps"] = round(
            float(state["total_samples_received"]) / (float(state["elapsed_time_ms"]) / 1000.0),
            4,
        )

    preview_ch2 = list(state.get("preview_ch2") or [])
    preview_ch3 = list(state.get("preview_ch3") or [])
    preview_ch4 = list(state.get("preview_ch4") or [])
    preview_ch2.extend(channels.get("CH2", []))
    preview_ch3.extend(channels.get("CH3", []))
    preview_ch4.extend(channels.get("CH4", []))
    preview_ch2 = _trim_preview_channel(preview_ch2)
    preview_ch3 = _trim_preview_channel(preview_ch3)
    preview_ch4 = _trim_preview_channel(preview_ch4)
    state["preview_ch2"] = preview_ch2
    state["preview_ch3"] = preview_ch3
    state["preview_ch4"] = preview_ch4

    buffer_samples = min(len(preview_ch2), len(preview_ch3), len(preview_ch4))
    window_seconds = round(buffer_samples / default_sample_rate_hz, 2)
    total_packets_buffered = buffer_samples // samples_per_packet
    current_ch2 = preview_ch2[-buffer_samples:]
    current_ch3 = preview_ch3[-buffer_samples:]
    current_ch4 = preview_ch4[-buffer_samples:]

    state["snapshot"] = {
        "record_id": record_id,
        "session_id": state.get("session_id"),
        "status": live_session_status(state),
        "channel": "CH2",
        "updated_at": updated_at,
        "ended_at": state.get("ended_at"),
        "packet_count_received": stats["packet_count"],
        "total_packets_buffered": total_packets_buffered,
        "samples_analyzed": buffer_samples,
        "window_seconds": window_seconds,
        "quality_percentage": 0.0,
        "signal_ok": buffer_samples > 0,
        "abnormal_detected": False,
        "reason_codes": [],
        "heart_rate_bpm": None,
        "signal": {"full": current_ch2, "r_peaks": []},
        "markers": empty_beat_markers_factory(),
        "interval_related": None,
    }
    state["visual_snapshot"] = {
        "record_id": record_id,
        "session_id": state.get("session_id"),
        "status": live_session_status(state),
        "updated_at": updated_at,
        "ended_at": state.get("ended_at"),
        "sample_rate_hz": default_sample_rate_hz,
        "buffer_samples": buffer_samples,
        "total_samples_received": int(state.get("total_samples_received") or 0),
        "heart_rate_bpm": None,
        "channels": {
            "CH2": current_ch2,
            "CH3": current_ch3,
            "CH4": current_ch4,
        },
    }
    return {
        "state": state,
        "recording_update": {
            "sample_count": int(state.get("total_samples_received") or 0),
            "elapsed_time_ms": state.get("elapsed_time_ms"),
            "effective_sps": state.get("effective_sps"),
        },
        "live_preview_row": {
            "record_id": record_id,
            "ch2_preview": current_ch2,
            "ch3_preview": current_ch3,
            "ch4_preview": current_ch4,
            "sample_count": int(state.get("total_samples_received") or 0),
            "elapsed_time_ms": state.get("elapsed_time_ms"),
            "updated_at": updated_at,
        },
        "response": {
            "record_id": record_id,
            "session_id": state.get("session_id"),
            "packet_count_received": stats["packet_count"],
            "total_packets_buffered": total_packets_buffered,
            "samples_analyzed": buffer_samples,
            "window_seconds": window_seconds,
            "quality_percentage": 0.0,
            "signal_ok": buffer_samples > 0,
            "abnormal_detected": False,
            "reason_codes": [],
            "heart_rate_bpm": None,
        },
    }


def finalize_live_session_state(record_id: str, ended_at: str) -> None:
    state = LIVE_SESSION_STATE.get(record_id)
    if state is None:
        return
    state["is_active"] = False
    state["ended_at"] = ended_at
    snapshot = state.get("snapshot")
    if isinstance(snapshot, dict):
        snapshot["status"] = "ended"
        snapshot["ended_at"] = ended_at
        snapshot["updated_at"] = ended_at
    visual_snapshot = state.get("visual_snapshot")
    if isinstance(visual_snapshot, dict):
        visual_snapshot["status"] = "ended"
        visual_snapshot["ended_at"] = ended_at
        visual_snapshot["updated_at"] = ended_at


def live_visual_snapshot_from_persisted_row(
    *,
    record_id: str,
    persisted_preview: Dict[str, Any],
    state: Optional[Dict[str, Any]],
    default_sample_rate_hz: int,
) -> Dict[str, Any]:
    return trim_live_visual_snapshot(
        {
            "record_id": record_id,
            "session_id": state.get("session_id") if state else None,
            "status": live_session_status(state) if state else "active",
            "updated_at": persisted_preview.get("updated_at"),
            "ended_at": state.get("ended_at") if state else None,
            "sample_rate_hz": default_sample_rate_hz,
            "buffer_samples": len(list(persisted_preview.get("ch2_preview") or [])),
            "total_samples_received": int(persisted_preview.get("sample_count") or 0),
            "heart_rate_bpm": state.get("last_hr_bpm") if state else None,
            "channels": {
                "CH2": list(persisted_preview.get("ch2_preview") or []),
                "CH3": list(persisted_preview.get("ch3_preview") or []),
                "CH4": list(persisted_preview.get("ch4_preview") or []),
            },
        },
        default_sample_rate_hz,
    )


def empty_live_visual_snapshot(
    *,
    record_id: str,
    state: Dict[str, Any],
    updated_at: str,
    default_sample_rate_hz: int,
) -> Dict[str, Any]:
    return trim_live_visual_snapshot(
        {
            "record_id": record_id,
            "session_id": state.get("session_id"),
            "status": live_session_status(state),
            "updated_at": updated_at,
            "ended_at": state.get("ended_at"),
            "sample_rate_hz": default_sample_rate_hz,
            "buffer_samples": 0,
            "total_samples_received": int(state.get("total_samples_received") or 0),
            "heart_rate_bpm": state.get("last_hr_bpm"),
            "channels": {"CH2": [], "CH3": [], "CH4": []},
        },
        default_sample_rate_hz,
    )
