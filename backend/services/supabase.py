from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from supabase import Client, create_client

TABLE_NAME = "capstone_ecg"
PRIMARY_KEY = "id"

_client: Optional[Client] = None


class SupabaseError(RuntimeError):
    pass


class RecordNotFound(SupabaseError):
    pass


def _require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise SupabaseError(f"Missing environment variable: {name}")
    return value


def get_client() -> Client:
    global _client
    if _client is None:
        url = _require_env("SUPABASE_URL")
        key = (
            os.getenv("SUPABASE_SERVICE_ROLE_KEY")
            or os.getenv("SUPABASE_ANON_KEY")
            or _require_env("SUPABASE_KEY")
        )
        _client = create_client(url, key)
    return _client


def _raise_on_error(response: Any) -> None:
    error = getattr(response, "error", None)
    if error:
        message = getattr(error, "message", None) or str(error)
        raise SupabaseError(message)


def list_records(limit: int = 100, offset: int = 0) -> List[Dict[str, Any]]:
    if limit <= 0:
        return []
    if offset < 0:
        raise SupabaseError("offset must be >= 0")

    client = get_client()
    end = offset + limit - 1
    response = (
        client.table(TABLE_NAME)
        .select("*")
        .range(offset, end)
        .execute()
    )
    _raise_on_error(response)
    return response.data or []


def get_record(record_id: str) -> Dict[str, Any]:
    client = get_client()
    response = (
        client.table(TABLE_NAME)
        .select("*")
        .eq(PRIMARY_KEY, record_id)
        .execute()
    )
    _raise_on_error(response)
    data = response.data or []
    if not data:
        raise RecordNotFound(f"Record not found: {record_id}")
    return data[0]


def create_record(payload: Dict[str, Any]) -> Dict[str, Any]:
    client = get_client()
    response = client.table(TABLE_NAME).insert(payload).execute()
    _raise_on_error(response)
    data = response.data or []
    if data:
        return data[0]
    return payload


def update_record(record_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    client = get_client()
    response = (
        client.table(TABLE_NAME)
        .update(payload)
        .eq(PRIMARY_KEY, record_id)
        .execute()
    )
    _raise_on_error(response)
    data = response.data or []
    if not data:
        raise RecordNotFound(f"Record not found: {record_id}")
    return data[0]


def delete_record(record_id: str) -> Dict[str, Any]:
    client = get_client()
    response = (
        client.table(TABLE_NAME)
        .delete()
        .eq(PRIMARY_KEY, record_id)
        .execute()
    )
    _raise_on_error(response)
    data = response.data or []
    if not data:
        raise RecordNotFound(f"Record not found: {record_id}")
    return data[0]
