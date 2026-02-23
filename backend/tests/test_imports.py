import importlib
import traceback

def test_backend_imports_cleanly():
    try:
        importlib.import_module("app")
    except Exception as exc:  # pragma: no cover - assertion path
        traceback.print_exc()
        raise AssertionError(f"backend/app.py failed to import: {exc}")
