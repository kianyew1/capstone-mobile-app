import logging
from typing import Any, Dict, Optional

logger = logging.getLogger("ecg-backend")

LIVE_SESSION_STATE: Dict[str, Dict[str, Any]] = {}
LIVE_VISUAL_BUFFER_SAMPLES = 4000


def live_visual_buffer_packets(samples_per_packet: int) -> int:
    return (LIVE_VISUAL_BUFFER_SAMPLES + samples_per_packet - 1) // samples_per_packet


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
