from __future__ import annotations

import csv
import json
import mimetypes
import sys
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any
from urllib.parse import urlparse

import numpy as np

BASE_DIR = Path(__file__).resolve().parents[1]
FRONTEND_DIR = BASE_DIR / "frontend"
DATA_DIR = BASE_DIR / "data"
CSV_PATH = DATA_DIR / "live_ch2.csv"
CSV_HEADERS = ["sample_index", "timestamp_ms", "ch2_mv", "packet_index"]
MAX_CSV_ROWS = 5000
VISIBLE_SAMPLES = 2500
CONTACT_STD_WINDOW_SAMPLES = 1500
DEFAULT_CONTACT_STD_MIN_MV = 0.02
DEFAULT_CONTACT_STD_MAX_MV = 1.0
DEFAULT_CONTACT_ABS_MEAN_MAX_MV = 1.5
DEFAULT_CAPTURE_TARGET_SECONDS = 20
ALLOWED_CAPTURE_TARGET_SECONDS = {10, 15, 20}
CLEANED_SIGNAL_CLIP_MV = 2.0
OUTLIER_Z_THRESHOLD = 2.5
DEFAULT_Y_LIMIT_MV = 0.5
HOST = "127.0.0.1"
PORT = 8020

PACKET_BYTES = 231
STATUS_BYTES = 3
ELAPSED_TIME_BYTES = 3
SAMPLES_PER_PACKET = 25
ADS1298_VREF = 2.4
ADS1298_GAIN = 6.0
ADS1298_MAX_CODE = (2**23) - 1
SAMPLE_RATE_HZ = 500

DATA_DIR.mkdir(parents=True, exist_ok=True)
_state_lock = threading.Lock()
_csv_lock = threading.Lock()

try:
    import neurokit2 as nk
except ModuleNotFoundError:
    venv_site_packages = BASE_DIR.parent / ".venv" / "Lib" / "site-packages"
    if venv_site_packages.exists():
        sys.path.append(str(venv_site_packages))
        import neurokit2 as nk
    else:  # pragma: no cover - only hits if both envs are missing neurokit2
        raise

LIVE_STATE: dict[str, Any] = {
    "device_name": None,
    "total_packets_received": 0,
    "total_samples_received": 0,
    "preview_ch2": [],
    "contact_std_min_mv": DEFAULT_CONTACT_STD_MIN_MV,
    "contact_std_max_mv": DEFAULT_CONTACT_STD_MAX_MV,
    "contact_abs_mean_max_mv": DEFAULT_CONTACT_ABS_MEAN_MAX_MV,
    "capture_target_seconds": DEFAULT_CAPTURE_TARGET_SECONDS,
    "y_limit_mv": DEFAULT_Y_LIMIT_MV,
    "contact_detected": False,
    "contact_std_mv": 0.0,
    "contact_abs_mean_mv": 0.0,
    "paused": False,
    "capture_status": "waiting",
    "capture_ch2": [],
    "analysis_result": None,
    "analysis_counter": 0,
}


def _reset_live_state() -> None:
    with _state_lock:
        LIVE_STATE["device_name"] = None
        LIVE_STATE["total_packets_received"] = 0
        LIVE_STATE["total_samples_received"] = 0
        LIVE_STATE["preview_ch2"] = []
        LIVE_STATE["contact_detected"] = False
        LIVE_STATE["contact_std_mv"] = 0.0
        LIVE_STATE["contact_abs_mean_mv"] = 0.0
        LIVE_STATE["paused"] = False
        LIVE_STATE["capture_status"] = "waiting"
        LIVE_STATE["capture_ch2"] = []
        LIVE_STATE["analysis_result"] = None


def _reset_capture_cycle() -> None:
    with _state_lock:
        LIVE_STATE["capture_status"] = "waiting"
        LIVE_STATE["capture_ch2"] = []
        LIVE_STATE["analysis_result"] = None


def _capture_target_samples() -> int:
    return int(float(LIVE_STATE["capture_target_seconds"]) * SAMPLE_RATE_HZ)


def _calculate_contact_std(samples: list[float]) -> float:
    if len(samples) < CONTACT_STD_WINDOW_SAMPLES:
        return 0.0
    latest = np.asarray(samples[-CONTACT_STD_WINDOW_SAMPLES:], dtype=float)
    return float(np.nanstd(latest))


def _calculate_abs_mean(samples: list[float]) -> float:
    if len(samples) < CONTACT_STD_WINDOW_SAMPLES:
        return 0.0
    latest = np.asarray(samples[-CONTACT_STD_WINDOW_SAMPLES:], dtype=float)
    return float(abs(np.nanmean(latest)))


def _clean_ch2_preview(samples: list[float]) -> list[float]:
    if not samples:
        return []
    try:
        cleaned = nk.ecg_clean(samples, sampling_rate=SAMPLE_RATE_HZ, method="neurokit")
        if hasattr(cleaned, "tolist"):
            cleaned = cleaned.tolist()
        else:
            cleaned = list(cleaned)
        return np.clip(np.asarray(cleaned, dtype=float), -CLEANED_SIGNAL_CLIP_MV, CLEANED_SIGNAL_CLIP_MV).tolist()
    except Exception:
        return np.clip(np.asarray(samples, dtype=float), -CLEANED_SIGNAL_CLIP_MV, CLEANED_SIGNAL_CLIP_MV).tolist()


def _finite_float_list(values: Any) -> list[float | None]:
    output: list[float | None] = []
    for value in values:
        numeric = float(value)
        output.append(numeric if np.isfinite(numeric) else None)
    return output


def _segments_to_epoch_axis(segments: dict[str, Any]) -> np.ndarray:
    if not segments:
        return np.array([], dtype=float)
    first_key = next(iter(segments))
    try:
        return np.asarray(segments[first_key].index, dtype=float)
    except Exception:
        return np.array([], dtype=float)


def _segment_signal_values(epoch: Any) -> np.ndarray:
    if hasattr(epoch, "columns"):
        if "Signal" in epoch.columns:
            return np.asarray(epoch["Signal"], dtype=float)
        numeric_columns = [column for column in epoch.columns if np.issubdtype(epoch[column].dtype, np.number)]
        if numeric_columns:
            return np.asarray(epoch[numeric_columns[0]], dtype=float)
    return np.asarray(epoch, dtype=float)


def _reject_outlier_beats(beat_matrix: np.ndarray) -> tuple[np.ndarray, list[bool]]:
    if beat_matrix.size == 0:
        return beat_matrix, []
    if beat_matrix.shape[0] <= 2:
        return beat_matrix, [True] * beat_matrix.shape[0]
    center = np.nanmedian(beat_matrix, axis=0)
    spread = np.nanstd(beat_matrix, axis=0)
    spread = np.where(spread < 1e-9, np.nan, spread)
    z_scores = np.abs((beat_matrix - center) / spread)
    per_beat_score = np.nanmax(z_scores, axis=1)
    keep_mask = np.isfinite(per_beat_score) & (per_beat_score <= OUTLIER_Z_THRESHOLD)
    if not np.any(keep_mask):
        keep_mask = np.ones((beat_matrix.shape[0],), dtype=bool)
    return beat_matrix[keep_mask], [bool(item) for item in keep_mask]


def _analyze_ch2_capture(raw_ch2_20s: list[float]) -> dict[str, Any]:
    raw = np.asarray(raw_ch2_20s, dtype=float)
    cleaned = np.asarray(nk.ecg_clean(raw, sampling_rate=SAMPLE_RATE_HZ, method="neurokit"), dtype=float)
    cleaned = np.clip(cleaned, -CLEANED_SIGNAL_CLIP_MV, CLEANED_SIGNAL_CLIP_MV)
    _, peak_info = nk.ecg_peaks(cleaned, sampling_rate=SAMPLE_RATE_HZ, method="neurokit")
    rpeaks = np.asarray(peak_info.get("ECG_R_Peaks", []), dtype=int)
    if rpeaks.size < 2:
        raise ValueError("Not enough R-peaks detected for mean-beat analysis.")

    rr_intervals = np.diff(rpeaks) / float(SAMPLE_RATE_HZ)
    average_bpm = float(60.0 / np.nanmedian(rr_intervals)) if rr_intervals.size else 0.0

    segments = nk.ecg_segment(cleaned, rpeaks=rpeaks, sampling_rate=SAMPLE_RATE_HZ, show=False)
    epoch_axis = _segments_to_epoch_axis(segments)
    beat_rows: list[np.ndarray] = []
    for epoch in segments.values():
        values = _segment_signal_values(epoch)
        if epoch_axis.size and values.size == epoch_axis.size:
            beat_rows.append(values)

    if not beat_rows:
        raise ValueError("No valid segmented beats were produced.")

    beat_matrix = np.vstack(beat_rows)
    filtered_matrix, keep_mask = _reject_outlier_beats(beat_matrix)
    mean_beat = np.nanmean(filtered_matrix, axis=0)
    raw_axis = np.arange(raw.size, dtype=float) / float(SAMPLE_RATE_HZ)

    return {
        "analysis_id": LIVE_STATE["analysis_counter"],
        "sample_rate_hz": SAMPLE_RATE_HZ,
        "average_bpm": average_bpm,
        "raw_signal": _finite_float_list(raw),
        "raw_axis": _finite_float_list(raw_axis),
        "epoch_axis": _finite_float_list(epoch_axis),
        "beat_stack": [_finite_float_list(row) for row in beat_matrix],
        "mean_beat": _finite_float_list(mean_beat),
        "rpeaks": [int(item) for item in rpeaks],
        "raw_beat_count": int(beat_matrix.shape[0]),
        "kept_beat_count": int(filtered_matrix.shape[0]),
        "keep_mask": keep_mask,
    }


def _run_capture_analysis(raw_capture: list[float], analysis_id: int) -> None:
    try:
        analysis = _analyze_ch2_capture(raw_capture)
        analysis["analysis_id"] = analysis_id
    except Exception as exc:
        analysis = {
            "analysis_id": analysis_id,
            "error": str(exc),
            "raw_signal": _finite_float_list(raw_capture),
            "raw_axis": _finite_float_list(np.arange(len(raw_capture), dtype=float) / SAMPLE_RATE_HZ),
        }
    with _state_lock:
        if int(LIVE_STATE["analysis_counter"]) == analysis_id and LIVE_STATE["capture_status"] == "analyzing":
            LIVE_STATE["analysis_result"] = analysis
            LIVE_STATE["capture_status"] = "ready"


def reset_csv_file() -> None:
    with _csv_lock:
        with CSV_PATH.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(CSV_HEADERS)


def _read24_signed_be(payload: bytes, offset: int) -> int:
    value = (payload[offset] << 16) | (payload[offset + 1] << 8) | payload[offset + 2]
    if value & 0x800000:
        return value - (1 << 24)
    return value


def _counts_to_mv(count: int) -> float:
    return (count / ADS1298_MAX_CODE) * (ADS1298_VREF / ADS1298_GAIN) * 1000.0


def _decode_ch2_from_packets(payload: bytes) -> list[float]:
    if len(payload) < PACKET_BYTES:
        return []
    packet_count = len(payload) // PACKET_BYTES
    decoded: list[float] = []
    for packet_index in range(packet_count):
        base = packet_index * PACKET_BYTES
        offset = base + STATUS_BYTES
        for _ in range(SAMPLES_PER_PACKET):
            decoded.append(_counts_to_mv(_read24_signed_be(payload, offset)))
            offset += 3
        offset += SAMPLES_PER_PACKET * 3  # skip CH3
        offset += SAMPLES_PER_PACKET * 3  # skip CH4
        offset += ELAPSED_TIME_BYTES
    return decoded


def _rewrite_csv_from_preview(ch2_preview: list[float], total_samples_received: int) -> None:
    start_sample_index = max(0, total_samples_received - len(ch2_preview))
    with _csv_lock:
        with NamedTemporaryFile("w", newline="", encoding="utf-8", delete=False, dir=str(DATA_DIR)) as temp_handle:
            writer = csv.writer(temp_handle)
            writer.writerow(CSV_HEADERS)
            for offset, ch2_mv in enumerate(ch2_preview):
                sample_index = start_sample_index + offset
                writer.writerow(
                    [
                        sample_index,
                        f"{(sample_index / SAMPLE_RATE_HZ) * 1000.0:.3f}",
                        f"{ch2_mv:.6f}",
                        sample_index // SAMPLES_PER_PACKET,
                    ]
                )
            temp_path = Path(temp_handle.name)
        temp_path.replace(CSV_PATH)


def _snapshot_payload() -> dict[str, Any]:
    with _state_lock:
        preview_ch2_raw = list(LIVE_STATE["preview_ch2"])
        total_samples_received = int(LIVE_STATE["total_samples_received"])
        total_packets_received = int(LIVE_STATE["total_packets_received"])
        device_name = LIVE_STATE["device_name"]
        contact_std_min_mv = float(LIVE_STATE["contact_std_min_mv"])
        contact_std_max_mv = float(LIVE_STATE["contact_std_max_mv"])
        contact_abs_mean_max_mv = float(LIVE_STATE["contact_abs_mean_max_mv"])
        capture_target_seconds = int(LIVE_STATE["capture_target_seconds"])
        capture_target_samples = int(capture_target_seconds * SAMPLE_RATE_HZ)
        y_limit_mv = float(LIVE_STATE["y_limit_mv"])
        contact_detected = bool(LIVE_STATE["contact_detected"])
        contact_std_mv = float(LIVE_STATE["contact_std_mv"])
        contact_abs_mean_mv = float(LIVE_STATE["contact_abs_mean_mv"])
        paused = bool(LIVE_STATE["paused"])
        capture_status = str(LIVE_STATE["capture_status"])
        capture_samples = len(LIVE_STATE["capture_ch2"])
        analysis_result = LIVE_STATE["analysis_result"]
    preview_ch2 = _clean_ch2_preview(preview_ch2_raw)
    return {
        "ok": True,
        "device_name": device_name,
        "sample_rate_hz": SAMPLE_RATE_HZ,
        "total_packets_received": total_packets_received,
        "total_samples_received": total_samples_received,
        "buffer_samples": len(preview_ch2),
        "visible_samples": min(VISIBLE_SAMPLES, len(preview_ch2)),
        "contact_std_window_samples": CONTACT_STD_WINDOW_SAMPLES,
        "contact_std_min_mv": contact_std_min_mv,
        "contact_std_max_mv": contact_std_max_mv,
        "contact_abs_mean_max_mv": contact_abs_mean_max_mv,
        "capture_target_seconds": capture_target_seconds,
        "contact_std_mv": contact_std_mv,
        "contact_abs_mean_mv": contact_abs_mean_mv,
        "paused": paused,
        "contact_detected": contact_detected,
        "capture_status": capture_status,
        "capture_samples": capture_samples,
        "capture_target_samples": capture_target_samples,
        "capture_seconds": capture_samples / SAMPLE_RATE_HZ,
        "capture_remaining_seconds": max(0.0, (capture_target_samples - capture_samples) / SAMPLE_RATE_HZ),
        "y_limit_mv": y_limit_mv,
        "analysis_result": analysis_result,
        "channels": {
            "CH2": preview_ch2,
        },
    }


def _ingest_packet_hex(device_name: str | None, packets: list[str]) -> dict[str, Any]:
    combined = bytearray()
    for packet_hex in packets:
        packet = bytes.fromhex(packet_hex)
        if len(packet) != PACKET_BYTES:
            raise ValueError(f"Expected {PACKET_BYTES} bytes per packet, got {len(packet)}")
        combined.extend(packet)
    decoded_ch2 = _decode_ch2_from_packets(bytes(combined))
    raw_capture: list[float] = []
    analysis_id = 0
    with _state_lock:
        if device_name:
            LIVE_STATE["device_name"] = device_name
        LIVE_STATE["total_packets_received"] += len(packets)
        LIVE_STATE["total_samples_received"] += len(decoded_ch2)
        preview_ch2 = list(LIVE_STATE["preview_ch2"])
        preview_ch2.extend(decoded_ch2)
        if len(preview_ch2) > MAX_CSV_ROWS:
            preview_ch2 = preview_ch2[-MAX_CSV_ROWS:]
        LIVE_STATE["preview_ch2"] = preview_ch2
        total_samples_received = int(LIVE_STATE["total_samples_received"])
        cleaned_preview_ch2 = _clean_ch2_preview(preview_ch2)
        contact_std = _calculate_contact_std(cleaned_preview_ch2)
        std_min = float(LIVE_STATE["contact_std_min_mv"])
        std_max = float(LIVE_STATE["contact_std_max_mv"])
        abs_mean = _calculate_abs_mean(cleaned_preview_ch2)
        abs_mean_max = float(LIVE_STATE["contact_abs_mean_max_mv"])
        paused = bool(LIVE_STATE["paused"])
        contact_detected = (not paused) and std_min <= contact_std <= std_max and abs_mean <= abs_mean_max
        print(
            "[CONTACT] "
            f"std={contact_std:.6f} std_min={std_min:.6f} std_max={std_max:.6f} "
            f"abs_mean={abs_mean:.6f} max_abs_mean={abs_mean_max:.6f} "
            f"contact={contact_detected}",
            flush=True,
        )
        LIVE_STATE["contact_std_mv"] = contact_std
        LIVE_STATE["contact_abs_mean_mv"] = abs_mean
        LIVE_STATE["contact_detected"] = contact_detected
        capture_target_samples = _capture_target_samples()

        if paused:
            LIVE_STATE["capture_status"] = "waiting"
            LIVE_STATE["capture_ch2"] = []
            LIVE_STATE["analysis_result"] = None
        elif LIVE_STATE["capture_status"] in {"waiting", "capturing"}:
            if not contact_detected:
                LIVE_STATE["capture_status"] = "waiting"
                LIVE_STATE["capture_ch2"] = []
                LIVE_STATE["analysis_result"] = None
            else:
                if LIVE_STATE["capture_status"] == "waiting":
                    LIVE_STATE["capture_status"] = "capturing"
                    LIVE_STATE["capture_ch2"] = []
                    LIVE_STATE["analysis_result"] = None
                LIVE_STATE["capture_ch2"].extend(decoded_ch2)
                if len(LIVE_STATE["capture_ch2"]) >= capture_target_samples:
                    raw_capture = list(LIVE_STATE["capture_ch2"][:capture_target_samples])
                    LIVE_STATE["capture_status"] = "analyzing"
                    LIVE_STATE["analysis_counter"] += 1
                    analysis_id = int(LIVE_STATE["analysis_counter"])
                else:
                    raw_capture = []
                    analysis_id = 0
            if LIVE_STATE["capture_status"] not in {"analyzing", "ready"}:
                raw_capture = []
                analysis_id = 0
    _rewrite_csv_from_preview(preview_ch2, total_samples_received)
    if raw_capture:
        threading.Thread(target=_run_capture_analysis, args=(raw_capture, analysis_id), daemon=True).start()
    return _snapshot_payload()


def _update_config(payload: dict[str, Any]) -> dict[str, Any]:
    with _state_lock:
        if "contact_std_min_mv" in payload:
            value = float(payload["contact_std_min_mv"])
            LIVE_STATE["contact_std_min_mv"] = value
        if "contact_std_max_mv" in payload:
            value = float(payload["contact_std_max_mv"])
            LIVE_STATE["contact_std_max_mv"] = value
        if "contact_abs_mean_max_mv" in payload:
            value = float(payload["contact_abs_mean_max_mv"])
            LIVE_STATE["contact_abs_mean_max_mv"] = value
        if "capture_target_seconds" in payload:
            value = int(payload["capture_target_seconds"])
            if value in ALLOWED_CAPTURE_TARGET_SECONDS:
                LIVE_STATE["capture_target_seconds"] = value
                if LIVE_STATE["capture_status"] in {"waiting", "capturing"}:
                    LIVE_STATE["capture_status"] = "waiting"
                    LIVE_STATE["capture_ch2"] = []
                    LIVE_STATE["analysis_result"] = None
        if "paused" in payload:
            LIVE_STATE["paused"] = bool(payload["paused"])
            LIVE_STATE["contact_detected"] = False
            LIVE_STATE["capture_status"] = "waiting"
            LIVE_STATE["capture_ch2"] = []
            LIVE_STATE["analysis_result"] = None
        if "y_limit_mv" in payload:
            value = float(payload["y_limit_mv"])
            LIVE_STATE["y_limit_mv"] = max(0.1, min(5.0, value))
    return _snapshot_payload()


def read_json_body(handler: BaseHTTPRequestHandler) -> Any:
    content_length = int(handler.headers.get("Content-Length", "0"))
    payload = handler.rfile.read(content_length) if content_length > 0 else b"{}"
    return json.loads(payload.decode("utf-8"))


def send_json(handler: BaseHTTPRequestHandler, payload: Any, status: int = HTTPStatus.OK) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def send_file(handler: BaseHTTPRequestHandler, file_path: Path) -> None:
    if not file_path.exists() or not file_path.is_file():
        handler.send_error(HTTPStatus.NOT_FOUND, "File not found")
        return
    content = file_path.read_bytes()
    content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    handler.send_response(HTTPStatus.OK)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(content)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(content)


class ShowcaseRequestHandler(BaseHTTPRequestHandler):
    server_version = "ShowcaseDisplay/1.0"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/":
            send_file(self, FRONTEND_DIR / "index.html")
            return
        if parsed.path == "/api/health":
            payload = _snapshot_payload()
            payload["csv_path"] = str(CSV_PATH)
            payload["max_csv_rows"] = MAX_CSV_ROWS
            send_json(self, payload)
            return
        if parsed.path.startswith("/static/"):
            relative_path = parsed.path.removeprefix("/static/")
            send_file(self, FRONTEND_DIR / relative_path)
            return
        handler_path = FRONTEND_DIR / parsed.path.lstrip("/")
        if handler_path.exists():
            send_file(self, handler_path)
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/ch2/reset":
            _reset_live_state()
            reset_csv_file()
            send_json(self, _snapshot_payload())
            return
        if parsed.path == "/api/ch2/reset_cycle":
            _reset_capture_cycle()
            send_json(self, _snapshot_payload())
            return
        if parsed.path == "/api/config":
            try:
                payload = read_json_body(self)
                snapshot = _update_config(dict(payload))
            except Exception as exc:
                send_json(self, {"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
                return
            send_json(self, snapshot)
            return
        if parsed.path == "/api/ch2/packets":
            try:
                payload = read_json_body(self)
                snapshot = _ingest_packet_hex(payload.get("device_name"), list(payload.get("packets", [])))
            except Exception as exc:
                send_json(self, {"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
                return
            send_json(self, snapshot)
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def log_message(self, format: str, *args: Any) -> None:
        return


def run(host: str = HOST, port: int = PORT) -> None:
    _reset_live_state()
    reset_csv_file()
    server = ThreadingHTTPServer((host, port), ShowcaseRequestHandler)
    print(f"Showcase display server running at http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    run()
