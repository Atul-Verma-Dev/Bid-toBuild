"""Smart Event Crowd Management API.

Run locally:
    .venv/bin/uvicorn main:app --reload

Interactive docs: http://127.0.0.1:8000/docs
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database import init_db
from routers import announcements, auth, venues


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


@app.get("/", tags=["meta"], summary="API info and endpoint map")
def root():
    return {
        "name": "Smart Event Crowd Management API",
        "status": "ok",
        "docs": "/docs",
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
