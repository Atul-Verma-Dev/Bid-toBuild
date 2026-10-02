"""Smart Event Crowd Management API + OmniView web dashboard.

Run locally:
    .venv/bin/uvicorn main:app --reload

Web pages:
    http://127.0.0.1:8000/            landing page (templates/home.html)
    http://127.0.0.1:8000/dashboard   live venue dashboard (templates/index.html)
    http://127.0.0.1:8000/zones       zone monitor (templates/zone-monitor.html)
    http://127.0.0.1:8000/analytics   analytics overview (templates/yash_dashboard.html)

API docs: http://127.0.0.1:8000/docs
"""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from database import init_db
from routers import announcements, auth, venues

BASE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"

# Every page the backend serves, keyed by its route. All of them live in
# templates/ and share the assets under static/ (exposed at /static).
PAGES = {
    "/": "home.html",
    "/dashboard": "index.html",
    "/zones": "zone-monitor.html",
    "/analytics": "yash_dashboard.html",
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()  # create tables + seed demo data on first start
    yield


app = FastAPI(
    title="Smart Event Crowd Management API",
    description="Monitor venue occupancy, crowd status, redirections, and announcements.",
    version="1.0.0",
    lifespan=lifespan,
)

# Allow any frontend origin during the hackathon.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(venues.router)
app.include_router(announcements.router)

# Serve the CSS/JS that the templates reference (/static/css/*, /static/js/*).
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _page(template_name: str) -> FileResponse:
    path = TEMPLATES_DIR / template_name
    if not path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Template '{template_name}' is missing.",
        )
    return FileResponse(path)


@app.get("/", tags=["pages"], summary="OmniView landing page")
def home_page():
    return _page(PAGES["/"])


@app.get("/dashboard", tags=["pages"], summary="Live venue dashboard")
def dashboard_page():
    return _page(PAGES["/dashboard"])


@app.get("/zones", tags=["pages"], summary="Zone monitoring console")
def zones_page():
    return _page(PAGES["/zones"])


@app.get("/analytics", tags=["pages"], summary="Event overview and crowd analytics")
def analytics_page():
    return _page(PAGES["/analytics"])


@app.get("/api", tags=["meta"], summary="API info and endpoint map")
def api_index():
    return {
        "name": "Smart Event Crowd Management API",
        "status": "ok",
        "docs": "/docs",
        "pages": {page_route: template for page_route, template in PAGES.items()},
        "endpoints": {
            "login": "POST /auth/login",
            "current_user": "GET /auth/me",
            "list_venues": "GET /venues",
            "get_venue": "GET /venues/{id}",
            "redirection": "GET /venues/{id}/suggestion",
            "create_venue": "POST /venues (admin)",
            "update_venue": "PATCH /venues/{id} (admin)",
            "update_occupancy": "PATCH /venues/{id}/occupancy (admin)",
            "delete_venue": "DELETE /venues/{id} (admin)",
            "list_announcements": "GET /announcements",
            "create_announcement": "POST /announcements (admin)",
        },
    }


@app.get("/health", tags=["meta"], summary="Health check")
def health():
    return {"status": "ok"}
