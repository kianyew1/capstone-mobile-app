import json
import logging
import os
from datetime import datetime
from typing import Any, Dict, List, Optional
from urllib.parse import quote
from zoneinfo import ZoneInfo

import httpx
from fastapi import HTTPException

logger = logging.getLogger("ecg-backend")

REVIEW_PROCESSING_VERSION = "review_v7"
SG_TIMEZONE = ZoneInfo("Asia/Singapore")


def _sg_now_iso() -> str:
    return datetime.now(SG_TIMEZONE).isoformat()


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
            "elapsed_time_ms",
            "effective_sps",
            "byte_length",
            "created_at",
        ]
    )
    url = f"{config['url']}/rest/v1/ecg_recordings"
    params = {
        "id": f"eq.{record_id}",
        "select": select_fields,
    }
    headers = _supabase_headers(json_content=False)
    headers["Accept"] = "application/json"
    try:
        with httpx.Client(timeout=30) as client:
            response = client.get(url, headers=headers, params=params)
            response.raise_for_status()
            data = response.json()
    except httpx.HTTPStatusError as exc:
        logger.error(
            "[FETCH] record_http_error record_id=%s status=%s body=%s",
            record_id,
            exc.response.status_code,
            exc.response.text,
        )
        raise HTTPException(
            status_code=502,
            detail=f"Supabase REST error: {exc.response.status_code} {exc.response.text}",
        ) from exc
    except httpx.RequestError as exc:
        logger.error("[FETCH] record_request_error record_id=%s error=%s", record_id, exc)
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
    headers = _supabase_headers(json_content=False)
    headers["Accept"] = "application/json"
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
    normalized_object_key = (object_key or "").lstrip("/")
    encoded_object_key = quote(normalized_object_key, safe="/")
    url = f"{config['url']}/storage/v1/object/{config['bucket']}/{encoded_object_key}"
    headers = {
        "apikey": config["key"],
        "Authorization": f"Bearer {config['key']}",
    }
    logger.info(
        "[FETCH] storage raw_object_key=%r normalized_object_key=%r url=%s",
        object_key,
        normalized_object_key,
        url,
    )
    try:
        with httpx.Client(timeout=60) as client:
            response = client.get(url, headers=headers)
            response.raise_for_status()
            return response.content
    except httpx.HTTPStatusError as exc:
        logger.error(
            "[FETCH] storage_http_error raw_object_key=%r normalized_object_key=%r url=%s status=%s body=%s",
            object_key,
            normalized_object_key,
            url,
            exc.response.status_code,
            exc.response.text,
        )
        raise HTTPException(
            status_code=502,
            detail=f"Supabase Storage error: {exc.response.status_code} {exc.response.text}",
        ) from exc
    except httpx.RequestError as exc:
        logger.error(
            "[FETCH] storage_request_error raw_object_key=%r normalized_object_key=%r url=%s error=%s",
            object_key,
            normalized_object_key,
            url,
            exc,
        )
        raise HTTPException(
            status_code=502,
            detail=f"Supabase Storage unreachable: {exc}",
        ) from exc


def _fetch_storage_json(object_key: str) -> Dict[str, Any]:
    payload = _fetch_storage_bytes(object_key)
    try:
        return json.loads(payload.decode("utf-8"))
    except Exception as exc:
        logger.error("[FETCH] storage_json_decode_error object_key=%s error=%s", object_key, exc)
        raise HTTPException(
            status_code=502,
            detail=f"Stored JSON artifact is invalid for object_key={object_key}: {exc}",
        ) from exc


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
        logger.error(
            "[UPLOAD] storage_http_error object_key=%s status=%s body=%s",
            object_key,
            exc.response.status_code,
            exc.response.text,
        )
        raise HTTPException(
            status_code=502,
            detail=f"Supabase Storage upload error: {exc.response.status_code} {exc.response.text}",
        ) from exc
    except httpx.RequestError as exc:
        logger.error("[UPLOAD] storage_request_error object_key=%s error=%s", object_key, exc)
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
        logger.error(
            "[UPLOAD] storage_json_http_error object_key=%s status=%s body=%s",
            object_key,
            exc.response.status_code,
            exc.response.text,
        )
        raise HTTPException(
            status_code=502,
            detail=f"Supabase Storage upload error: {exc.response.status_code} {exc.response.text}",
        ) from exc
    except httpx.RequestError as exc:
        logger.error("[UPLOAD] storage_json_request_error object_key=%s error=%s", object_key, exc)
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
        logger.error(
            "[DB] insert_http_error table=ecg_recordings status=%s body=%s",
            exc.response.status_code,
            exc.response.text,
        )
        raise HTTPException(
            status_code=502,
            detail=f"Supabase insert error: {exc.response.status_code} {exc.response.text}",
        ) from exc
    except httpx.RequestError as exc:
        logger.error("[DB] insert_request_error table=ecg_recordings error=%s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"Supabase insert unreachable: {exc}",
        ) from exc
    if not data:
        logger.error("[DB] insert_empty table=ecg_recordings payload_keys=%s", list(payload.keys()))
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
        logger.error(
            "[DB] update_http_error table=ecg_recordings record_id=%s status=%s body=%s",
            record_id,
            exc.response.status_code,
            exc.response.text,
        )
        raise HTTPException(
            status_code=502,
            detail=f"Supabase update error: {exc.response.status_code} {exc.response.text}",
        ) from exc
    except httpx.RequestError as exc:
        logger.error("[DB] update_request_error table=ecg_recordings record_id=%s error=%s", record_id, exc)
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
        logger.error(
            "[DB] upsert_http_error table=%s status=%s body=%s",
            table,
            exc.response.status_code,
            exc.response.text,
        )
        raise HTTPException(
            status_code=502,
            detail=f"Supabase upsert error ({table}): {exc.response.status_code} {exc.response.text}",
        ) from exc
    except httpx.RequestError as exc:
        logger.error("[DB] upsert_request_error table=%s error=%s", table, exc)
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
            "updated_at": _sg_now_iso(),
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
    object_key = data[0].get("object_key") if data else None
    logger.info(
        "[PROCESSING] fetch_artifact record_id=%s artifact_type=%s url=%s params=%s object_key=%r",
        record_id,
        artifact_type,
        url,
        params,
        object_key,
    )
    return object_key


def _upsert_processed_artifact(record_id: str, artifact_type: str, object_key: str) -> None:
    _upsert_table_row(
        "ecg_processed_artifacts",
        {
            "record_id": record_id,
            "artifact_type": artifact_type,
            "object_key": object_key,
            "processing_version": REVIEW_PROCESSING_VERSION,
            "updated_at": _sg_now_iso(),
        },
        "record_id,artifact_type",
    )


def _insert_session_chunk_row(payload: Dict[str, Any]) -> None:
    _upsert_table_row(
        "ecg_session_chunks",
        payload,
        "record_id,chunk_index",
    )


def _upsert_live_preview_row(payload: Dict[str, Any]) -> None:
    _upsert_table_row(
        "ecg_live_preview",
        payload,
        "record_id",
    )


def _fetch_live_preview_row(record_id: str) -> Optional[Dict[str, Any]]:
    config = _get_supabase_config()
    url = f"{config['url']}/rest/v1/ecg_live_preview"
    params = {
        "record_id": f"eq.{record_id}",
        "select": "record_id,ch2_preview,ch3_preview,ch4_preview,sample_count,elapsed_time_ms,updated_at",
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
        logger.error("[PREVIEW] fetch_failed record_id=%s error=%s", record_id, exc)
        return None
    return data[0] if data else None


def _fetch_latest_live_preview_row() -> Optional[Dict[str, Any]]:
    config = _get_supabase_config()
    url = f"{config['url']}/rest/v1/ecg_live_preview"
    params = {
        "select": "record_id,ch2_preview,ch3_preview,ch4_preview,sample_count,elapsed_time_ms,updated_at",
        "order": "updated_at.desc",
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
        logger.error("[PREVIEW] fetch_latest_failed error=%s", exc)
        return None
    return data[0] if data else None
