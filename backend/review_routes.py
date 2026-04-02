from __future__ import annotations

import base64
import io
import threading
from typing import Any, Callable, Dict, List

from fastapi import FastAPI, HTTPException
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402


def mount_review_routes(
    app: FastAPI,
    *,
    default_sample_rate_hz: int,
    channel_labels: List[str],
    logger: Any,
    review_response_model: Any,
    review_section_model: Any,
    vector_beat_response_model: Any,
    vector3d_beat_response_model: Any,
    beat_markers_model: Any,
    fetch_latest_recording_id: Callable[[], str | None],
    load_review_artifact: Callable[[str, str], Dict[str, Any]],
    sanitize_float: Callable[[Any], float | None],
) -> None:
    vector3d_image_cache: Dict[tuple[str, str, int, float, float, int], str] = {}
    vector3d_preload_state: Dict[tuple[str, str, float, float, int], Dict[str, Any]] = {}
    vector3d_preload_lock = threading.Lock()

    def _build_review_response(record_id: str, channel: str) -> Dict[str, Any]:
        selected_channel = (channel or "CH2").upper()
        if selected_channel not in channel_labels:
            raise HTTPException(status_code=400, detail="Invalid channel.")

        logger.info("[REVIEW] request record_id=%s channel=%s", record_id, selected_channel)
        artifact = load_review_artifact(record_id, selected_channel)
        calibration_section = artifact.get("calibration", {})
        session_section = artifact.get("session", {})
        sample_rate_hz = int(artifact.get("sample_rate_hz") or default_sample_rate_hz)

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
        return {
            "record_id": record_id,
            "channel": selected_channel,
            "sample_rate_hz": sample_rate_hz,
            "calibration": review_section_model(**calibration_section),
            "session": review_section_model(**session_section),
        }

    def _get_vector_beat_payload(record_id: str, section: str, beat_index: int) -> Dict[str, Any]:
        selected_section = (section or "calibration").lower()
        if selected_section not in {"calibration", "session"}:
            raise HTTPException(status_code=400, detail="Invalid section.")

        lead_x_artifact = load_review_artifact(record_id, "CH2")
        lead_z_artifact = load_review_artifact(record_id, "CH3")
        lead_y_artifact = load_review_artifact(record_id, "CH4")
        sample_rate_hz = int(lead_x_artifact.get("sample_rate_hz") or default_sample_rate_hz)

        lead_x_section = lead_x_artifact.get(selected_section, {})
        lead_z_section = lead_z_artifact.get(selected_section, {})
        lead_y_section = lead_y_artifact.get(selected_section, {})
        lead_x_signal = lead_x_section.get("signal", {}).get("full", []) or []
        lead_z_signal = lead_z_section.get("signal", {}).get("full", []) or []
        lead_y_signal = lead_y_section.get("signal", {}).get("full", []) or []
        beats = lead_x_section.get("beats", {}).get("items", []) or []
        beat_count = len(beats)
        if beat_count == 0:
            raise HTTPException(status_code=404, detail="No beats available for vector visualization.")

        bounded_index = max(1, min(beat_index, beat_count))
        beat = next((item for item in beats if int(item.get("index", 0)) == bounded_index), beats[0])
        start_sample = int(beat.get("start_sample") or 1)
        end_sample = int(beat.get("end_sample") or start_sample)

        return {
            "selected_section": selected_section,
            "sample_rate_hz": sample_rate_hz,
            "beat_count": beat_count,
            "beat_index": int(beat.get("index") or bounded_index),
            "start_sample": start_sample,
            "end_sample": end_sample,
            "exclude_from_analysis": bool(beat.get("exclude_from_analysis")),
            "exclusion_reasons": list(beat.get("exclusion_reasons", []) or []),
            "qr_duration_ms": sanitize_float(beat.get("qr_duration_ms")),
            "markers": beat_markers_model(**(beat.get("markers", {}) or {})),
            "lead_x": [float(value) for value in lead_x_signal[max(0, start_sample - 1) : max(0, end_sample)]],
            "lead_y": [float(value) for value in lead_y_signal[max(0, start_sample - 1) : max(0, end_sample)]],
            "lead_z": [float(value) for value in lead_z_signal[max(0, start_sample - 1) : max(0, end_sample)]],
            "max_abs_lead_x": max((abs(float(value)) for value in lead_x_signal), default=0.0),
            "max_abs_lead_y": max((abs(float(value)) for value in lead_y_signal), default=0.0),
            "max_abs_lead_z": max((abs(float(value)) for value in lead_z_signal), default=0.0),
        }

    def _render_vector3d_png(
        lead_x: List[float],
        lead_y: List[float],
        lead_z: List[float],
        markers: Any,
        progress_percent: int,
        y_min_mv: float,
        y_max_mv: float,
    ) -> str:
        count = min(len(lead_x), len(lead_y), len(lead_z))
        if count <= 0:
            raise HTTPException(status_code=404, detail="No vector samples available for 3D rendering.")

        bounded_progress = max(1, min(progress_percent, 100))
        visible_count = max(1, min(count, int(round((count * bounded_progress) / 100.0))))
        x = lead_x[:visible_count]
        y = lead_y[:visible_count]
        z = lead_z[:visible_count]

        fig = plt.figure(figsize=(8.4, 6.6), dpi=160)
        fig.patch.set_facecolor("#f5fafc")
        ax = fig.add_subplot(111, projection="3d")
        ax.set_facecolor("#f8fbfd")
        ax.plot([y_min_mv, y_max_mv], [0, 0], [0, 0], color="#dc2626", linewidth=1.2, alpha=0.72, zorder=1)
        ax.plot([0, 0], [y_min_mv, y_max_mv], [0, 0], color="#2563eb", linewidth=1.2, alpha=0.72, zorder=1)
        ax.plot([0, 0], [0, 0], [y_min_mv, y_max_mv], color="#16a34a", linewidth=1.2, alpha=0.72, zorder=1)
        ax.plot(x, y, z, color="#0c6c7e", linewidth=2.0, solid_capstyle="round", zorder=3)

        marker_specs = {"P": "#1f7aec", "Q": "#9a3412", "R": "#b91c1c", "S": "#0f766e", "T": "#6d28d9"}
        for label, color in marker_specs.items():
            positions = getattr(markers, label, []) or []
            for position in positions:
                if position >= visible_count:
                    continue
                ax.scatter(
                    [lead_x[position]],
                    [lead_y[position]],
                    [lead_z[position]],
                    color=color,
                    s=34,
                    edgecolors="#ffffff",
                    linewidths=0.75,
                    depthshade=False,
                    zorder=4,
                )
                ax.text(lead_x[position], lead_y[position], lead_z[position], f" {label}", color=color, fontsize=9)

        ax.set_xlim(y_min_mv, y_max_mv)
        ax.set_ylim(y_min_mv, y_max_mv)
        ax.set_zlim(y_min_mv, y_max_mv)
        ax.set_xlabel("Lead I / CH2 (mV)", labelpad=12)
        ax.set_ylabel("Lead III / CH4 (mV)", labelpad=12)
        ax.set_zlabel("Lead II / CH3 (mV)", labelpad=10)
        ax.set_box_aspect((1, 1, 1))
        ax.view_init(elev=22, azim=-58)
        ax.grid(True, alpha=0.25)
        ax.set_title("3D beat morphology", pad=14)
        tick_color = (0.28, 0.39, 0.49, 0.9)
        for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
            axis.pane.set_facecolor((0.972, 0.984, 0.992, 0.72))
            axis.pane.set_edgecolor((0.74, 0.82, 0.88, 0.9))
            axis._axinfo["grid"]["color"] = (0.64, 0.73, 0.8, 0.25)
            axis._axinfo["grid"]["linewidth"] = 0.8
        ax.xaxis.label.set_color(tick_color)
        ax.yaxis.label.set_color(tick_color)
        ax.zaxis.label.set_color(tick_color)
        ax.tick_params(colors=tick_color, labelsize=8)

        buffer = io.BytesIO()
        fig.tight_layout()
        fig.savefig(buffer, format="png", bbox_inches="tight", facecolor=fig.get_facecolor())
        plt.close(fig)
        return base64.b64encode(buffer.getvalue()).decode("ascii")

    def _vector3d_cache_key(
        record_id: str,
        section: str,
        beat_index: int,
        y_min_mv: float,
        y_max_mv: float,
        progress_percent: int,
    ) -> tuple[str, str, int, float, float, int]:
        return (record_id, section, beat_index, round(y_min_mv, 4), round(y_max_mv, 4), progress_percent)

    def _vector3d_preload_key(
        record_id: str,
        section: str,
        y_min_mv: float,
        y_max_mv: float,
        progress_percent: int,
    ) -> tuple[str, str, float, float, int]:
        return (record_id, section, round(y_min_mv, 4), round(y_max_mv, 4), progress_percent)

    def _build_vector3d_image_for_beat(
        record_id: str,
        section: str,
        beat_index: int,
        y_min_mv: float,
        y_max_mv: float,
        progress_percent: int,
    ) -> str:
        cache_key = _vector3d_cache_key(record_id, section, beat_index, y_min_mv, y_max_mv, progress_percent)
        cached = vector3d_image_cache.get(cache_key)
        if cached is not None:
            return cached
        payload = _get_vector_beat_payload(record_id, section, beat_index)
        image_png_base64 = _render_vector3d_png(
            lead_x=payload["lead_x"],
            lead_y=payload["lead_y"],
            lead_z=payload["lead_z"],
            markers=payload["markers"],
            progress_percent=progress_percent,
            y_min_mv=y_min_mv,
            y_max_mv=y_max_mv,
        )
        vector3d_image_cache[cache_key] = image_png_base64
        return image_png_base64

    def _warm_vector3d_cache(
        record_id: str,
        section: str,
        beat_count: int,
        y_min_mv: float,
        y_max_mv: float,
        progress_percent: int,
        start_beat_index: int,
    ) -> None:
        preload_key = _vector3d_preload_key(record_id, section, y_min_mv, y_max_mv, progress_percent)
        try:
            if beat_count <= 0:
                return
            bounded_start = max(1, min(start_beat_index, beat_count))
            beat_order = list(range(bounded_start, beat_count + 1)) + list(range(1, bounded_start))
            for offset, beat_number in enumerate(beat_order, start=1):
                _build_vector3d_image_for_beat(record_id, section, beat_number, y_min_mv, y_max_mv, progress_percent)
                with vector3d_preload_lock:
                    state = vector3d_preload_state.get(preload_key)
                    if state is not None:
                        state["ready_count"] = max(state.get("ready_count", 0), offset)
            logger.info(
                "[VECTOR3D] preload_ready record_id=%s section=%s total=%s progress=%s",
                record_id,
                section,
                beat_count,
                progress_percent,
            )
        except Exception as exc:
            logger.error(
                "[VECTOR3D] preload_failed record_id=%s section=%s progress=%s error=%s",
                record_id,
                section,
                progress_percent,
                exc,
            )
        finally:
            with vector3d_preload_lock:
                state = vector3d_preload_state.get(preload_key)
                if state is not None:
                    state["running"] = False

    def _schedule_vector3d_preload(
        record_id: str,
        section: str,
        beat_count: int,
        y_min_mv: float,
        y_max_mv: float,
        progress_percent: int,
        start_beat_index: int,
    ) -> None:
        preload_key = _vector3d_preload_key(record_id, section, y_min_mv, y_max_mv, progress_percent)
        with vector3d_preload_lock:
            state = vector3d_preload_state.get(preload_key)
            if state and state.get("running"):
                return
            vector3d_preload_state[preload_key] = {
                "running": True,
                "beat_count": beat_count,
                "ready_count": state.get("ready_count", 0) if state else 0,
            }
        worker = threading.Thread(
            target=_warm_vector3d_cache,
            kwargs={
                "record_id": record_id,
                "section": section,
                "beat_count": beat_count,
                "y_min_mv": y_min_mv,
                "y_max_mv": y_max_mv,
                "progress_percent": progress_percent,
                "start_beat_index": start_beat_index,
            },
            daemon=True,
        )
        worker.start()

    @app.get("/review/latest", response_model=review_response_model)
    async def review_latest(channel: str = "CH2", session_window_index: int = 1) -> Any:
        latest_id = fetch_latest_recording_id()
        if not latest_id:
            raise HTTPException(status_code=404, detail="No recordings found.")
        return review_response_model(**_build_review_response(latest_id, channel))

    @app.get("/review/{record_id}", response_model=review_response_model)
    async def review_record(record_id: str, channel: str = "CH2", session_window_index: int = 1) -> Any:
        return review_response_model(**_build_review_response(record_id, channel))

    @app.get("/review/{record_id}/vector_beat", response_model=vector_beat_response_model)
    async def review_vector_beat(record_id: str, section: str = "calibration", beat_index: int = 1) -> Any:
        payload = _get_vector_beat_payload(record_id, section, beat_index)
        logger.info(
            "[VECTOR] response record_id=%s section=%s beat_index=%s samples=%s excluded=%s",
            record_id,
            payload["selected_section"],
            payload["beat_index"],
            min(len(payload["lead_x"]), len(payload["lead_z"])),
            payload["exclude_from_analysis"],
        )
        return vector_beat_response_model(
            record_id=record_id,
            section=payload["selected_section"],
            sample_rate_hz=payload["sample_rate_hz"],
            beat_count=payload["beat_count"],
            beat_index=payload["beat_index"],
            start_sample=payload["start_sample"],
            end_sample=payload["end_sample"],
            exclude_from_analysis=payload["exclude_from_analysis"],
            exclusion_reasons=payload["exclusion_reasons"],
            qr_duration_ms=payload["qr_duration_ms"],
            markers=payload["markers"],
            max_abs_lead_x=payload["max_abs_lead_x"],
            max_abs_lead_y=payload["max_abs_lead_y"],
            max_abs_lead_z=payload["max_abs_lead_z"],
            lead_x=payload["lead_x"],
            lead_y=payload["lead_y"],
            lead_z=payload["lead_z"],
            max_abs_lead_i=payload["max_abs_lead_x"],
            max_abs_lead_ii=payload["max_abs_lead_z"],
            lead_i=payload["lead_x"],
            lead_ii=payload["lead_z"],
        )

    @app.get("/review/{record_id}/vector3d_beat", response_model=vector3d_beat_response_model)
    async def review_vector3d_beat(
        record_id: str,
        section: str = "calibration",
        beat_index: int = 1,
        progress_percent: int = 100,
        y_min_mv: float = -0.3,
        y_max_mv: float = 0.6,
    ) -> Any:
        payload = _get_vector_beat_payload(record_id, section, beat_index)
        bounded_progress = max(1, min(progress_percent, 100))
        if y_max_mv <= y_min_mv:
            raise HTTPException(status_code=400, detail="y_max_mv must be greater than y_min_mv.")
        image_png_base64 = _build_vector3d_image_for_beat(
            record_id=record_id,
            section=payload["selected_section"],
            beat_index=payload["beat_index"],
            y_min_mv=y_min_mv,
            y_max_mv=y_max_mv,
            progress_percent=bounded_progress,
        )
        _schedule_vector3d_preload(
            record_id=record_id,
            section=payload["selected_section"],
            beat_count=payload["beat_count"],
            y_min_mv=y_min_mv,
            y_max_mv=y_max_mv,
            progress_percent=bounded_progress,
            start_beat_index=payload["beat_index"],
        )

        logger.info(
            "[VECTOR3D] response record_id=%s section=%s beat_index=%s samples=%s excluded=%s progress=%s",
            record_id,
            payload["selected_section"],
            payload["beat_index"],
            min(len(payload["lead_x"]), len(payload["lead_y"]), len(payload["lead_z"])),
            payload["exclude_from_analysis"],
            bounded_progress,
        )
        return vector3d_beat_response_model(
            record_id=record_id,
            section=payload["selected_section"],
            sample_rate_hz=payload["sample_rate_hz"],
            beat_count=payload["beat_count"],
            beat_index=payload["beat_index"],
            start_sample=payload["start_sample"],
            end_sample=payload["end_sample"],
            exclude_from_analysis=payload["exclude_from_analysis"],
            exclusion_reasons=payload["exclusion_reasons"],
            qr_duration_ms=payload["qr_duration_ms"],
            markers=payload["markers"],
            image_png_base64=image_png_base64,
            progress_percent=bounded_progress,
            y_min_mv=y_min_mv,
            y_max_mv=y_max_mv,
        )

    @app.post("/review/{record_id}/vector3d_preload")
    async def review_vector3d_preload(
        record_id: str,
        section: str = "calibration",
        progress_percent: int = 100,
        y_min_mv: float = -0.3,
        y_max_mv: float = 0.6,
        start_beat_index: int = 1,
    ) -> Dict[str, Any]:
        if y_max_mv <= y_min_mv:
            raise HTTPException(status_code=400, detail="y_max_mv must be greater than y_min_mv.")
        payload = _get_vector_beat_payload(record_id, section, start_beat_index)
        bounded_progress = max(1, min(progress_percent, 100))
        _schedule_vector3d_preload(
            record_id=record_id,
            section=payload["selected_section"],
            beat_count=payload["beat_count"],
            y_min_mv=y_min_mv,
            y_max_mv=y_max_mv,
            progress_percent=bounded_progress,
            start_beat_index=payload["beat_index"],
        )
        logger.info(
            "[VECTOR3D] preload_started record_id=%s section=%s start_beat=%s total=%s progress=%s",
            record_id,
            payload["selected_section"],
            payload["beat_index"],
            payload["beat_count"],
            bounded_progress,
        )
        return {
            "record_id": record_id,
            "section": payload["selected_section"],
            "beat_count": payload["beat_count"],
            "start_beat_index": payload["beat_index"],
            "progress_percent": bounded_progress,
            "status": "scheduled",
        }
