# Capstone ECG App Backend

This service is a minimal FastAPI app with a `/health` endpoint.

## Local setup

1. Create and activate a virtual environment.

   ```bash
   python -m venv .venv
   source .venv/bin/activate
   ```

   ```powershell
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   ```

2. Ensure Python 3.12+ is available (see `pyproject.toml`).
3. Install dependencies:

   ```bash
   pip install -r requirements.txt
   ```

   ```powershell
   pip install -r requirements.txt
   ```

4. Run the dev server:

   ```bash
   fastapi dev
   ```

   ```powershell
   fastapi dev
   ```

   Or, if you prefer specifying the module directly:

   ```bash
   fastapi dev app.py
   ```

   ```powershell
   fastapi dev app.py
   ```

5. Verify the health check:

   ```bash
   curl http://127.0.0.1:8000/health
   ```

   ```powershell
   Invoke-RestMethod http://127.0.0.1:8000/health
   ```

## Deploy to FastAPI Cloud

1. Ensure dependencies are declared in `pyproject.toml` or `requirements.txt`.
2. From the project root, log in:

   ```bash
   fastapi login
   ```

3. Deploy:

   ```bash
   fastapi deploy
   ```

4. If auto-detection fails, set the entrypoint in `pyproject.toml`:

   ```toml
   [tool.fastapi]
   entrypoint = "app:app"
   ```

5. Re-deploy with `fastapi deploy`.
6. After deploy, FastAPI Cloud will provide a URL for your service. Use `/health` to verify responsiveness.

## Deploy to Render (CLI-first)

1. Create a Render account and add a payment method if prompted.
2. Create a Web Service once in the Render Dashboard with these settings:
  Language: `Python 3`
  Build Command: `pip install -r requirements.txt`
  Start Command: `uvicorn app:app --host 0.0.0.0 --port $PORT`
  Root Directory: `backend` (only if this repo is in a monorepo)
  Python version: set `PYTHON_VERSION=3.12.x` or add a `.python-version` file with `3.12`
3. Install the Render CLI and ensure `render` is on your PATH.
4. Log in and choose your workspace:

   ```bash
   render login
   render workspace set
   ```

5. List services and copy the service ID:

   ```bash
   render services
   ```

6. Deploy the latest commit for that service:

   ```bash
   render deploys create <SERVICE_ID> --wait
   ```

7. View recent deploys:

   ```bash
   render deploys list <SERVICE_ID>
   ```
