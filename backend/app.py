import os
from typing import Dict

from dotenv import load_dotenv
from fastapi import FastAPI

load_dotenv()

app = FastAPI()

DEFAULT_BASE_URL = "http://127.0.0.1:8000"
BASE_URL = os.getenv("BASE_URL") or DEFAULT_BASE_URL


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok", "base_url": BASE_URL}
