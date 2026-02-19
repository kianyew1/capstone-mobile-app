from typing import Any, Dict

from fastapi import Body, FastAPI, HTTPException, Query

from services import supabase as supabase_service

app = FastAPI()


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
