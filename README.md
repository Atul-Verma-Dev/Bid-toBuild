# OmniView — Smart Event Crowd Management

FastAPI + SQLite backend **and web dashboard** for the Smart Event Crowd
Management hackathon project. It manages event venues/zones, calculates crowd
status, suggests redirection destinations, and serves announcements. Occupancy
is supplied through the API (no sensors).

The same server also hosts the four front-end pages in `templates/`, sharing the
assets in `static/` — one command starts everything.

## Run it (about 30 seconds)

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn main:app --reload
```

Web pages (served by FastAPI):

| Page           | URL          | Template                |
| -------------- | ------------ | ----------------------- |
| Landing page   | `/`          | `templates/home.html`   |
| Live dashboard | `/dashboard` | `templates/index.html`  |
| Zone monitor   | `/zones`     | `templates/zone-monitor.html` |
| Analytics      | `/analytics` | `templates/yash_dashboard.html` |

- Interactive docs (Swagger): http://127.0.0.1:8000/docs
- ReDoc: http://127.0.0.1:8000/redoc
- API info + endpoint map (JSON): http://127.0.0.1:8000/api
- Static assets: `/static/css/*`, `/static/js/*`

The SQLite file `app.db` is created and seeded automatically on first start.
Delete `app.db` to reset demo data.

## Demo accounts

| Username | Password   | Role  |
| -------- | ---------- | ----- |
| `admin`  | `admin123` | admin |
| `user`   | `user123`  | user  |

Admins can create/modify venues and announcements. Users (and unauthenticated
callers) can read venue/crowd data and announcements. Read endpoints are open
so the frontend can connect immediately.

## Auth flow

```bash
TOKEN=$(curl -s -X POST localhost:8000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | python -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
```

Send it as `Authorization: Bearer $TOKEN` on admin endpoints.

## Crowd status rules (computed by the API)

`occupancy_percentage = occupancy / capacity * 100`

| Percentage  | Status        |
| ----------- | ------------- |
| below 70%   | `NORMAL`      |
| 70% – 84%   | `MODERATE`    |
| 85% – 94%   | `WARNING`     |
| 95% – 100%  | `CRITICAL`    |
| above 100%  | `OVERCROWDED` |

`WARNING`, `CRITICAL`, and `OVERCROWDED` trigger a redirection suggestion.

## Endpoints

### Meta / pages

| Method | Path         | Description                  |
| ------ | ------------ | ---------------------------- |
| GET    | `/`          | Landing page (HTML)          |
| GET    | `/dashboard` | Live venue dashboard (HTML)  |
| GET    | `/zones`     | Zone monitoring console (HTML) |
| GET    | `/analytics` | Crowd analytics (HTML)       |
| GET    | `/api`       | API info + endpoint map      |
| GET    | `/health`    | Health check                 |

### Auth

| Method | Path           | Auth | Description             |
| ------ | -------------- | ---- | ----------------------- |
| POST   | `/auth/login`  | —    | Log in, returns a token |
| GET    | `/auth/me`     | any  | Current user + role     |

### Venues

| Method | Path                        | Auth  | Description                                   |
| ------ | --------------------------- | ----- | --------------------------------------------- |
| GET    | `/venues`                   | —     | List venues (filters: `crowd_status`, `active`) |
| GET    | `/venues/{id}`              | —     | Get one venue                                 |
| GET    | `/venues/{id}/suggestion`   | —     | Redirection suggestion                        |
| POST   | `/venues`                   | admin | Create a venue                                |
| PATCH  | `/venues/{id}`              | admin | Rename / capacity / occupancy / opening / closing |
| PATCH  | `/venues/{id}/occupancy`    | admin | Update current occupancy                      |
| DELETE | `/venues/{id}`              | admin | Remove a venue                                |

### Announcements

| Method | Path                  | Auth  | Description                                          |
| ------ | --------------------- | ----- | ---------------------------------------------------- |
| GET    | `/announcements`      | —     | Recent announcements (`type`, `venue_id`, `active_only`, `limit`) |
| POST   | `/announcements`      | admin | Create (`INFO`, `WARNING`, `REDIRECT`, `EMERGENCY`)  |
| PATCH  | `/announcements/{id}` | admin | Edit or deactivate                                   |
| DELETE | `/announcements/{id}` | admin | Delete                                               |

## Response shape

Every venue response includes calculated fields so the frontend does not need
to compute anything:

```json
{
  "id": 1,
  "name": "Main Auditorium",
  "capacity": 800,
  "occupancy": 760,
  "occupancy_percentage": 95.0,
  "status": "CRITICAL",
  "available_capacity": 40,
  "opening_time": "08:00",
  "closing_time": "23:00",
  "is_active": true,
  "created_at": "2026-10-02T05:20:06+00:00",
  "updated_at": "2026-10-02T05:20:06+00:00"
}
```

Redirection suggestion (`GET /venues/1/suggestion`):

```json
{
  "venue_id": 1,
  "venue_name": "Main Auditorium",
  "status": "CRITICAL",
  "needs_redirection": true,
  "suggestion": {
    "venue_id": 2,
    "venue_name": "Food Court",
    "occupancy_percentage": 35.0,
    "status": "NORMAL",
    "available_capacity": 390,
    "reason": "Food Court is only 35.0% full with 390 free spots."
  },
  "reason": null
}
```

## Redirection algorithm

Deterministic and dependency-free: among currently-open venues (excluding the
source), pick the one with free capacity and the lowest occupancy percentage.
Venues that are themselves `WARNING`, `CRITICAL`, or `OVERCROWDED` are never
suggested. If nothing is available, `suggestion` is `null` with a `reason`.

## Seed data

| Venue           | Occupancy | Status      |
| --------------- | --------- | ----------- |
| Main Auditorium | 760/800   | `CRITICAL`  |
| Food Court      | 210/600   | `NORMAL`    |
| Tech Expo Hall  | 510/600   | `WARNING`   |
| Workshop Arena  | 420/500   | `MODERATE`  |
| Central Plaza   | 700/600   | `OVERCROWDED` |
| VIP Lounge      | 120/150   | `MODERATE`  |
| Sunrise Stage   | 0/300     | `NORMAL` (inactive outside 06:00–06:30) |

## Project layout

```
main.py            # FastAPI app, CORS, static mount, page routes, router wiring
database.py        # SQLite schema, connection dependency, seed data
models.py          # Pydantic request/response models
auth.py            # password hashing, signed tokens, role dependencies
crowd.py           # occupancy %, status, active window, redirection
routers/           # auth.py, venues.py, announcements.py
templates/         # home.html, index.html, zone-monitor.html, yash_dashboard.html
static/css/        # monitoring.css, yash_dashboard.css
static/js/         # monitoring.js, yash_dashboard.js
```

## Front-end wiring

Every page talks to the API on the **same origin** (no CORS setup needed) and
falls back to local demo data if the backend is unreachable:

- **Live dashboard** (`/dashboard`) — `GET /venues` on load; `PATCH /venues/{id}/occupancy`,
  `PATCH /venues/{id}`, `POST /venues` and `DELETE /venues/{id}` when signed in as
  admin (otherwise changes stay local to the page). The redirection banner uses the
  backend's `GET /venues/{id}/suggestion` to confirm and explain its pick.
- **Zone monitor** (`/zones`) — polls `GET /venues` every 10 s for cards, alerts,
  redirection options and staff hints; the crowd simulation writes occupancy back
  through `PATCH /venues/{id}/occupancy` when an admin token is stored.
- **Analytics** (`/analytics`) — polls `GET /venues` + `GET /announcements` every 5 s
  and renders the doughnut / bar / trend charts with Chart.js.
- **Home** (`/`) — checks `/health`, lists live venues and links every dashboard.

Admin tokens are stored in `localStorage` (`token`, `auth_user`, `auth_role`), so
signing in on one page signs you in on the others.
