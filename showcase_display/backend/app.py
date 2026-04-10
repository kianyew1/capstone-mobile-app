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

BASE_DIR = Path(__file__).resolve().parents[1]
FRONTEND_DIR = BASE_DIR / "frontend"
DATA_DIR = BASE_DIR / "data"
CSV_PATH = DATA_DIR / "live_ch2.csv"
CSV_HEADERS = ["sample_index", "timestamp_ms", "ch2_mv", "packet_index"]
MAX_CSV_ROWS = 5000
VISIBLE_SAMPLES = 2500
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
}


def _reset_live_state() -> None:
    with _state_lock:
        LIVE_STATE["device_name"] = None
        LIVE_STATE["total_packets_received"] = 0
        LIVE_STATE["total_samples_received"] = 0
        LIVE_STATE["preview_ch2"] = []


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
    if preview_ch2_raw:
        try:
            preview_ch2 = nk.ecg_clean(preview_ch2_raw, sampling_rate=SAMPLE_RATE_HZ, method="neurokit")
            if hasattr(preview_ch2, "tolist"):
                preview_ch2 = preview_ch2.tolist()
            else:
                preview_ch2 = list(preview_ch2)
        except Exception:
            preview_ch2 = preview_ch2_raw
    else:
        preview_ch2 = []
    return {
        "ok": True,
        "device_name": device_name,
        "sample_rate_hz": SAMPLE_RATE_HZ,
        "total_packets_received": total_packets_received,
        "total_samples_received": total_samples_received,
        "buffer_samples": len(preview_ch2),
        "visible_samples": min(VISIBLE_SAMPLES, len(preview_ch2)),
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
    _rewrite_csv_from_preview(preview_ch2, total_samples_received)
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
