# OmniView — Smart Event Crowd Management

FastAPI + SQLite backend **and web dashboard** for the Smart Event Crowd
Management hackathon project. It manages venues/zones and the event programme,
calculates crowd status, suggests redirection destinations, tracks staff
deployment, and serves announcements. Occupancy is supplied through the API
(no sensors).

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

## Accounts & roles

| Username | Password   | Role  | Can do                                                         |
| -------- | ---------- | ----- | -------------------------------------------------------------- |
| `user`   | `user123`  | user  | Operations: venues, events, staff deployment, redirections      |
| `admin`  | `admin123` | admin | Everything a `user` can do, plus announcements                 |

Reads are open, so every dashboard renders without signing in. Every write
(venue name/capacity/occupancy, events, staff deployments, redirections) needs a
bearer token from **either** role. Announcements stay admin-only.

The pages deliberately do not advertise credentials: the Live Dashboard and the
Zone Monitor open **signed in as the `user` operator account** (silently calling
`POST /auth/login`), so staff deployment, venue and event work out of the box;
signing out leaves them read-only. The `admin` account is available via
“Switch account”.

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

| Method | Path                        | Auth     | Description                                   |
| ------ | --------------------------- | -------- | --------------------------------------------- |
| GET    | `/venues`                   | —        | List venues (filters: `crowd_status`, `active`) |
| GET    | `/venues/{id}`              | —        | Get one venue                                 |
| GET    | `/venues/{id}/suggestion`   | —        | Redirection suggestion                        |
| POST   | `/venues`                   | signed in | Create a venue                               |
| PATCH  | `/venues/{id}`              | signed in | Rename / capacity / occupancy / opening / closing |
| PATCH  | `/venues/{id}/occupancy`    | signed in | Update current occupancy                     |
| DELETE | `/venues/{id}`              | signed in | Remove a venue                               |

Every venue response carries `current_event` — the event scheduled in that
venue, or `null` — so any page can show what is on where.

### Events (the programme)

| Method | Path            | Auth      | Description                                          |
| ------ | --------------- | --------- | ---------------------------------------------------- |
| GET    | `/events`       | —         | List events (filter: `venue_id`), soonest first       |
| GET    | `/events/{id}`  | —         | Get one event                                        |
| POST   | `/events`       | signed in | Create an event and assign a venue                   |
| PATCH  | `/events/{id}`  | signed in | Rename / move to another venue (`venue_id: null` clears it) |
| DELETE | `/events/{id}`  | signed in | Delete an event                                      |

### Staff deployment

| Method | Path                          | Auth      | Description                                     |
| ------ | ----------------------------- | --------- | ----------------------------------------------- |
| GET    | `/staff`                      | —         | Pool size, deployed/available totals, per-venue headcount |
| POST   | `/staff/deployments`          | signed in | Deploy `{venue_id, count}` from the shared pool |
| DELETE | `/staff/deployments/{venue_id}` | signed in | Recall every staff member from a venue        |

The pool holds 12 staff. Deployments live in SQLite, so the headcount is shared
by the dashboard, the zone monitor and the landing-page snapshot, and survives
reloads. Deploying more than the pool holds returns `409` with a clear message.

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
  "updated_at": "2026-10-02T05:20:06+00:00",
  "current_event": {
    "id": 1,
    "name": "OmniHack 2026",
    "event_date": "2026-10-02"
  }
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

The same first run seeds an event programme — `OmniHack 2026` (today, Main
Auditorium), `Opening Night Gala` (tomorrow, Central Plaza), `TechDay Summit` and
`Genomics Workshop` — plus an empty staff pool.

## Project layout

```
main.py            # FastAPI app, CORS, static mount, page routes, router wiring
database.py        # SQLite schema, connection dependency, seed data
models.py          # Pydantic request/response models
auth.py            # password hashing, signed tokens, role dependencies
crowd.py           # occupancy %, status, active window, redirection
routers/           # auth.py, venues.py, events.py, staff.py, announcements.py
templates/         # home.html, index.html, zone-monitor.html, yash_dashboard.html
static/css/        # monitoring.css, yash_dashboard.css
static/js/         # monitoring.js, yash_dashboard.js
```

## Front-end wiring

Every page talks to the API on the **same origin** (no CORS setup needed) and
falls back to local demo data if the backend is unreachable:

- **Live dashboard** (`/dashboard`) — `GET /venues` + `GET /events` + `GET /staff`;
  renames venues (`PATCH /venues/{id}`), edits capacity/occupancy, adds venues, and
  renames, deletes or creates events with their venue (`/events`). Each venue card
  shows the event running in it and the staff deployed there. The redirection banner
  uses the backend's `GET /venues/{id}/suggestion` to confirm and explain its pick.
- **Zone monitor** (`/zones`) — polls `GET /venues` + `GET /events` + `GET /staff`
  every 10 s for zone cards, alerts and redirection options. **Deploy staff** and
  **Recall** write straight to `/staff/deployments`, and the crowd simulation writes
  occupancy through `PATCH /venues/{id}/occupancy`.
- **Analytics** (`/analytics`) — polls `GET /venues` + `GET /announcements` every 5 s
  and renders the doughnut / bar charts plus a trend line built from the live samples
  collected while the page is open (no fabricated history).
- **Home** (`/`) — checks `/health`, lists live venues with the event on in each one
  and the staff on site, and links every dashboard.

Auth tokens are stored in `localStorage` (`token`, `auth_user`, `auth_role`), so
signing in on one page signs you in on the others.
