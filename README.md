# RBC — AI-Powered Automatic Block Planning

**SIH26027 · Ministry of Railways · Transportation & Logistics**

Maintenance demands from the Engineering, Signal & Telecom and Traction Distribution
departments are planned independently today. This prototype unifies them against real
corridor availability, ranks them with a trained priority model, and packs them into the
fewest safe possessions over a day, a week or a month.

Runs entirely locally. No login, no API keys, no package installation, no network calls.

## Start

Node.js 20 or newer. From this folder:

```sh
npm start          # http://127.0.0.1:5173
npm test           # 36 tests
npm run check      # syntax check every module
```

## What the problem statement asks for, and where it lives

| Requirement | Implementation |
| --- | --- |
| Integrate defects and overdue maintenance from TMS, SMMS, TDMS with corridor block availability | `dist/backlog.js` (register + backlog), `dist/corridor.js` (timetable + sanctioned windows) |
| Use AI/ML to prioritise and schedule maintenance tasks | `dist/priority-model.js` ranks; `dist/planner.js` schedules |
| Optimise block scheduling to maximise asset uptime | Objective in `dist/planner.js`; line-availability gain reported per plan |
| Block plans over multiple time horizons — weekly and monthly | Day / week / month selector, `optimize(..., {horizon})` |

## The corridor is real

`dist/corridor.js` is generated from the [DataMeet Indian Railways dataset](https://github.com/datameet/railways)
(CC0), covering the Western Railway main line from **Vadodara Jn to Ahmedabad Jn**:

- 6 block sections between BRC, VDA, ANND, ND, MHD, VTA and ADI — 99.8 route km
- **180 timetabled trains, 1,044 section legs**, each resolved to a running line (UP or DN)
- Section distances computed from real station coordinates

Rebuild it by downloading `stations.json` and `schedules.json` into `tools/raw/` and running
`python tools/build_corridor.py`.

### What the real timetable revealed

The naive assumption — that a block closes a whole section — collapses on real data. Treating
both running lines as occupied, **the longest gap anywhere in 24 hours is 42 minutes**. Nothing
can be scheduled.

Split by running line, the picture is workable but still tight: the longest natural window on
any section and line is **131 minutes**, and most are under an hour. That is precisely why
Indian Railways sanctions **corridor blocks** — windows bought by regulating traffic. The
problem statement names "corridor block and block availability" as an input for this reason.

`tools/build_corridor.py` slides every candidate band across the timetable and reports the
cheapest, measured in trains that must be cancelled, diverted or rescheduled:

| Line | 120 min | 180 min | 240 min |
| --- | --- | --- | --- |
| UP | 10:15–12:15 · 6 trains | 09:15–12:15 · 9 trains | 19:45–23:45 · 12 trains |
| DN | 07:30–09:30 · 6 trains | 01:30–04:30 · 10 trains | 05:45–09:45 · 15 trains |
| Both lines | 09:00–11:00 · 17 trains | 07:45–10:45 · 27 trains | 10:15–14:15 · 33 trains |

Section-wide work — points, interlocking, a bridge — closes every running line and is
sanctioned as a single band, which is why "Both lines" costs so much more.

## The maintenance backlog is synthetic, and says so

Indian Railways does not publish TMS, SMMS or TDMS defect data. No real backlog exists to
load, so `tools/build_backlog.py` generates one. What is real is the **structure**:

- 23 maintenance activities across the three departments, each with an asset class,
  a periodicity band and a work duration — following Permanent Way, S&T and Traction
  Distribution practice
- **228 assets** on the register, each with a last-done date, a due date and days overdue
- **144 work orders** currently due or overdue, 96 of them past periodicity, 33 carrying a
  reported defect with a severity
- Traffic density per asset computed from the **real** timetable

Swap the generator for a TMS/SMMS/TDMS extract and nothing downstream changes.

## Prioritisation

`tools/build_backlog.py` fits a ridge-regularised linear model to 4,000 historical
prioritisation decisions and writes the coefficients to `dist/priority.js`. Inference is a
handful of multiplies in `dist/priority-model.js`, so the app keeps its zero-dependency,
runs-offline property.

Features: days overdue against periodicity · reported defect severity · asset criticality ·
section traffic density · consequence of failure. Holdout RMSE is 6.7 priority points on a
0–100 scale.

For a linear model the exact Shapley attribution of a feature is
`coefficient × (feature − training mean)`, so every score decomposes exactly into its drivers.
The backlog page shows that breakdown per work order behind **Why?**.

The training history is synthetic. The feature set, the fitting pipeline and the inference
path are the deliverable; point them at real records and retrain.

## How a window is chosen

Candidates come in two kinds — windows the timetable already leaves open, and sanctioned
corridor windows bought by regulating traffic:

```
score = clearance to the nearest train (capped at 45 min)
      − minutes later in the day        × 0.01
      − trains regulated                × 15
```

Every weight is in minutes, so they are directly comparable and arguable. The traffic term
dominates by design: a natural gap always beats a granted window, and among granted windows
the cheapest one wins. Weights live in `WEIGHTS` in `dist/planner.js`.

The score is piecewise linear inside a free interval, so the optimum sits at an interval edge,
its midpoint, or a constraint boundary. Four candidates per interval replaces scanning the day
minute by minute — a full month plan over 1,044 train legs runs in about 150 ms.

## Blocks, crews and clearance

Departments inside one block work in parallel. Two orders for the *same* department share that
department's crew and run back to back. So a possession is as long as its longest department
stream, not the sum of its work:

```
stream   = setup + Σ work for that department + clearance
block    = max(stream) over the departments present
```

Setup and clearance are real and department-specific: Engineering 15/10 minutes, S&T 10/5,
Traction Distribution 30/20 — traction needs isolation, a permit to work and earthing before
anyone touches the wire, then the reverse. Paying that **once per possession instead of once
per work order** is where most of the saving comes from.

Each department has a crew count, which is how many separate blocks it can hold at once across
the division. Machinery is a single unit, so two parallel departments cannot share a tamping
machine or a tower wagon.

## Results on the seeded data

| Horizon | Blocks | Work orders scheduled | Line availability gain | Deferred |
| --- | --- | --- | --- | --- |
| Day | 13 | 64 of 144 | 60% | 80 |
| Week | 44 | 138 of 144 | 47% | 6 |
| Month | 44 | 138 of 144 | 47% | 6 |

The backlog clears inside a week, so the month horizon adds nothing — reported honestly rather
than padded. The six that never schedule are deep screening, rail grinding and heavy tamping:
each needs more minutes than the longest sanctioned band, so the plan says so explicitly and
tells the controller to raise an extended traffic block with traffic diverted.

## Five-minute demonstration

1. **Dashboard** — 144 pending orders over 228 assets. The occupancy strip shows why this is
   hard: every half hour of both running lines, shaded by train count.
2. **Maintenance Backlog** — ranked by the model. Open **Why?** on the top order to see the
   exact per-feature attribution behind its score.
3. **Block Plan** — choose **Week**, generate. 44 blocks covering 138 orders in ~250 ms.
4. Read one recommendation's **Why this window**: orders combined, line time saved against
   planning them apart, protection paid once, and either the clearance to the nearest train or
   the number of trains the corridor block regulates.
5. Approve one. The gate revalidates before committing; the order moves to
   **Approved Schedule** and the availability figure updates.
6. Scroll to **Deferred** to see what could not be scheduled and precisely why.

### Other things worth showing

- **The gate has the last word.** Generate a plan, then add trains or take a department off
  duty in **Departments**, and approve a stale recommendation. Approval re-runs every hard
  rule and rejects it; the attempt is logged in **Safety Alerts**.
- **Crew strength is a real constraint.** Drop Engineering to one crew and regenerate — blocks
  that used to run in parallel across sections serialise.
- **Traffic cost is visible.** Corridor blocks carry the number of trains regulated, on the
  card and again in the approval dialog.

## Planning API

The planner and the safety gate are plain modules, so the same code the browser runs is served
over HTTP.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Liveness and corridor summary |
| `GET /api/reference` | Sections, corridor windows, departments, model metadata |
| `GET /api/demo` | The seeded planning state |
| `POST /api/prioritise` | Rank the backlog, with per-feature drivers |
| `POST /api/plan` | Build a day, week or month plan |
| `POST /api/windows` | Free windows on one section and running line |
| `POST /api/validate` | Run the hard-rule gate against one block |
| `POST /api/approve` | Validate and commit one block |

```sh
curl -s -X POST http://127.0.0.1:5173/api/plan -d '{"horizon":"week"}'
curl -s -X POST http://127.0.0.1:5173/api/prioritise -d '{}'
```

`POST` bodies accept an optional `state` (defaults to the seeded day). Bodies are capped at
1 MB and a malformed state is rejected with a 400. `PORT` overrides the port.

## Layout

```
dist/corridor.js        GENERATED  real sections, trains, sanctioned windows
dist/backlog.js         GENERATED  asset register and maintenance backlog
dist/priority.js        GENERATED  fitted model coefficients
dist/priority-model.js  scoring and exact per-feature attribution
dist/data.js            reference data, time and horizon helpers, block arithmetic
dist/safety.js          the hard-rule gate and atomic approval
dist/planner.js         free-window search, objective, horizon planning
dist/app.js             interface
server.mjs              static server and planning API, loopback only
tools/build_corridor.py rebuilds the corridor from the DataMeet dataset
tools/build_backlog.py  regenerates the backlog and refits the priority model
tests/planner.test.mjs  36 tests
```

`dist/` is authored source and is committed. There is no build step for the app itself; the
Python tools only regenerate the three GENERATED files.

## Explicit limits

This is not railway control software.

- **The backlog is synthetic.** Activity classes and periodicity bands follow departmental
  practice, but the defects, dates and durations are generated. The priority model is trained
  on synthetic history.
- **The timetable is real but static.** No live running data, no delays, no cancellations. Every
  path is treated as occupied — the conservative assumption.
- **No integration.** Nothing reads TMS, SMMS, TDMS or the Control Office Application. The
  module boundary where those feeds would land is `dist/backlog.js` and `dist/corridor.js`.
- **Approval is a demonstration acknowledgement**, not authenticated authority. State lives in
  one browser's localStorage. Not multi-user, not a system of record.
- **Grouping is greedy**, not optimal. It is deterministic and explainable and does not claim
  global optimality; a constraint solver would do better on the packing.
- **Not modelled:** temporary speed restrictions after work, gang and machinery travel between
  sections, single-line working during a block, interlocking and possession procedure beyond
  the setup and clearance allowance, and weather or seasonal effects.

AI ranks and packs. Hard rules and authorised human approval have final say.
