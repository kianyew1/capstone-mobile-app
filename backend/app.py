import base64
import json
import os
from math import sqrt
from typing import Dict, Union

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse

load_dotenv()

app = FastAPI()

DEFAULT_BASE_URL = "http://127.0.0.1:8001"
BASE_URL = os.getenv("BASE_URL") or DEFAULT_BASE_URL

LAST_CALIBRATION_SAMPLES = []
LAST_CALIBRATION_META = {
    "byte_length": 0,
    "sample_count": 0,
}


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok", "base_url": BASE_URL}


@app.get("/", response_class=HTMLResponse)
def root() -> str:
    sample_count = LAST_CALIBRATION_META["sample_count"]
    byte_length = LAST_CALIBRATION_META["byte_length"]
    data = LAST_CALIBRATION_SAMPLES
    has_data = sample_count > 0 and len(data) == sample_count

    return f"""<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>ECG Calibration Preview</title>
    <style>
      body {{ font-family: Arial, sans-serif; padding: 16px; background: #0b0b0b; color: #e5e5e5; }}
      .meta {{ margin-bottom: 12px; color: #a3a3a3; }}
      canvas {{ background: #111827; border: 1px solid #1f2937; }}
    </style>
  </head>
  <body>
    <h1>Calibration Signal</h1>
    <div class="meta">byte_length={byte_length} | sample_count={sample_count}</div>
    {"<div>No calibration data received yet.</div>" if not has_data else ""}
    <canvas id="ecg" width="1200" height="300"></canvas>
    <script>
      const data = {data};
      const canvas = document.getElementById("ecg");
      const ctx = canvas.getContext("2d");
      if (!data || data.length === 0) {{
        ctx.fillStyle = "#9ca3af";
        ctx.fillText("No data", 10, 20);
      }} else {{
        const maxPoints = 2000;
        const step = Math.max(1, Math.ceil(data.length / maxPoints));
        const sampled = [];
        for (let i = 0; i < data.length; i += step) sampled.push(data[i]);

        const mean = sampled.reduce((s, v) => s + v, 0) / sampled.length;
        let maxAbs = 0;
        for (const v of sampled) maxAbs = Math.max(maxAbs, Math.abs(v - mean));
        const scale = maxAbs || 1;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = "#22c55e";
        ctx.lineWidth = 1.5;
        const mid = canvas.height / 2;
        const stepX = canvas.width / (sampled.length - 1);

        ctx.beginPath();
        for (let i = 0; i < sampled.length; i++) {{
          const x = i * stepX;
          const y = mid - ((sampled[i] - mean) / scale) * mid;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }}
        ctx.stroke();
      }}
    </script>
  </body>
</html>"""

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
        "quality_percentage": round(quality, 2),
        "signal_suitable": signal_suitable,
    }
