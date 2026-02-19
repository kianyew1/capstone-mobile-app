from typing import Any, Dict, Optional
from uuid import uuid4

from fastapi import Body, FastAPI, HTTPException, Query

from services import supabase as supabase_service

app = FastAPI()

TEST_CREATE_PAYLOAD: Dict[str, Any] = {
    # Minimal example. Update keys to match your table schema.
    "id": "test-ecg",
}

TEST_UPDATE_PAYLOAD: Dict[str, Any] = {
    # Optional. If empty, the test will try to derive an update from the created row.
}


def _build_test_create_payload() -> Dict[str, Any]:
    payload = dict(TEST_CREATE_PAYLOAD)
    primary_key = supabase_service.PRIMARY_KEY
    if primary_key in payload:
        base_value = str(payload.get(primary_key) or "test")
        payload[primary_key] = f"{base_value}-{uuid4().hex}"
    return payload


def _derive_update_payload(created: Dict[str, Any]) -> Dict[str, Any]:
    primary_key = supabase_service.PRIMARY_KEY
    for key, value in created.items():
        if key == primary_key:
            continue
        if isinstance(value, bool):
            return {key: not value}
        if isinstance(value, int):
            return {key: value + 1}
        if isinstance(value, float):
            return {key: value + 0.1}
        if isinstance(value, str):
            return {key: f"{value}-updated"}
        if value is None:
            return {key: "updated"}
    return {}


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/ecg")
def list_ecg(
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> Dict[str, Any]:
    try:
        data = supabase_service.list_records(limit=limit, offset=offset)
        return {"data": data}
    except supabase_service.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/ecg/{record_id}")
def get_ecg(record_id: str) -> Dict[str, Any]:
    try:
        data = supabase_service.get_record(record_id)
        return {"data": data}
    except supabase_service.RecordNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except supabase_service.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.post("/ecg")
def create_ecg(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    try:
        data = supabase_service.create_record(payload)
        return {"data": data}
    except supabase_service.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.put("/ecg/{record_id}")
def update_ecg(
    record_id: str,
    payload: Dict[str, Any] = Body(...),
) -> Dict[str, Any]:
    try:
        data = supabase_service.update_record(record_id, payload)
        return {"data": data}
    except supabase_service.RecordNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except supabase_service.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.delete("/ecg/{record_id}")
def delete_ecg(record_id: str) -> Dict[str, Any]:
    try:
        data = supabase_service.delete_record(record_id)
        return {"data": data}
    except supabase_service.RecordNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except supabase_service.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.post("/ecg/test")
def test_ecg_crud(payload: Optional[Dict[str, Any]] = Body(default=None)) -> Dict[str, Any]:
    create_payload: Optional[Dict[str, Any]] = None
    update_payload: Optional[Dict[str, Any]] = None
    if payload:
        create_payload = payload.get("create_payload")
        update_payload = payload.get("update_payload")
        if not isinstance(create_payload, dict):
            raise HTTPException(
                status_code=400,
                detail="Body must include a 'create_payload' object.",
            )
        if update_payload is not None and not isinstance(update_payload, dict):
            raise HTTPException(
                status_code=400,
                detail="'update_payload' must be an object when provided.",
            )
    else:
        create_payload = _build_test_create_payload()

    try:
        created = supabase_service.create_record(create_payload)
        record_id = created.get(
            supabase_service.PRIMARY_KEY,
            create_payload.get(supabase_service.PRIMARY_KEY),
        )
        if record_id is None:
            raise HTTPException(
                status_code=500,
                detail=(
                    "Create succeeded but no primary key was returned. "
                    "Update PRIMARY_KEY in services/supabase.py to match your table."
                ),
            )

        record_id_str = str(record_id)
        fetched = supabase_service.get_record(record_id_str)
        if update_payload is None:
            update_payload = dict(TEST_UPDATE_PAYLOAD) or _derive_update_payload(created)
        if not update_payload:
            raise HTTPException(
                status_code=400,
                detail=(
                    "No update payload available. Add fields to TEST_UPDATE_PAYLOAD "
                    "in app.py to match your table schema."
                ),
            )
        updated = supabase_service.update_record(record_id_str, update_payload)
        deleted = supabase_service.delete_record(record_id_str)
        return {
            "primary_key": record_id,
            "steps": {
                "create": created,
                "read": fetched,
                "update": updated,
                "delete": deleted,
            },
        }
    except supabase_service.RecordNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except supabase_service.SupabaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
