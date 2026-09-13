# Gamma input: RBC AI-Powered Block Planning

How to use this file:
1. In Gamma choose **Create new → Paste in text**.
2. Copy everything from **"START PASTE"** to **"END PASTE"** below.
3. Choose **Presentation**, **10 cards**, and set text handling to **Preserve** (not "Generate"),
   so Gamma keeps the verified figures exactly.
4. Upload the images from `presentation/screenshots/`. Each card names the file it needs.
5. The **Project fact sheet** at the bottom is for you. Paste it into Gamma's "Additional
   instructions" box if it asks for context, or use it to answer questions.

Every number here was reproduced live from the running app on 2026-09-13.

---

## Gamma "Additional instructions" box (paste this there)

> Professional pitch deck for a Smart India Hackathon government problem statement (Ministry of
> Railways). Audience: railway officers and technical judges. Tone: confident, precise, no hype.
> Use a clean light theme: dark navy (#12303A), teal accent (#0F766E), and soft amber (#F2D9A0)
> only for "corridor block / trains regulated" highlights, matching the product UI. Put large app
> screenshots on the cards that call for them, use side-by-side layouts, and keep bullets short.
> Never change, round or invent numbers. Every figure is measured. Do not add stock photos of
> trains where a screenshot is specified.

---

START PASTE

# RBC: AI-Powered Automatic Block Planning
SIH26027 · Ministry of Railways · Transportation & Logistics

**Plan the corridor, not the department.**

One system that unifies Engineering, S&T and Traction Distribution maintenance against the real timetable, ranks the work with trained models, and packs it into the fewest safe track possessions.

Runs fully offline on one laptop. No login, no API keys, no install.

[Image: 01-dashboard.jpg]

---

# The problem: three departments, one track

- Engineering (TMS), Signal & Telecom (SMMS) and Traction Distribution (TDMS) each plan blocks separately
- Every block pays its own setup and clearance. Traction alone needs 30 min to isolate and earth, plus 20 min to restore.
- Repeated possessions on the same section = line time taken from trains
- No shared view of what is overdue, what is likely to fail, or which window is actually free

The problem statement asks for: unify the demands, prioritise with AI/ML, maximise asset uptime, plan over day, week and month.

---

# Built on the real corridor

Western Railway main line: **Vadodara Jn → Ahmedabad Jn**

- 6 block sections · 99.8 route km
- **180 timetabled trains · 1,044 section legs**, each resolved to its UP or DN running line
- Source: DataMeet Indian Railways open dataset (CC0)

The occupancy strip shows every half hour of both running lines, shaded by train count.

[Image: 01-dashboard.jpg, cropped to the Corridor occupancy panel]

---

# What the real timetable revealed

- With both lines closed, the longest free gap in 24 hours is **42 minutes**. Nothing fits.
- Split by running line, the longest natural gap is **131 minutes**, and most are under an hour.
- So we price **sanctioned corridor blocks** in the one unit that matters: trains regulated.

| Line | 120 min | 180 min | 240 min |
| --- | --- | --- | --- |
| UP | 10:15–12:15 · 6 trains | 09:15–12:15 · 9 trains | 19:45–23:45 · 12 trains |
| DN | 07:30–09:30 · 6 trains | 01:30–04:30 · 10 trains | 05:45–09:45 · 15 trains |
| Both lines | 09:00–11:00 · 17 trains | 07:45–10:45 · 27 trains | 10:15–14:15 · 33 trains |

[Image: 07-corridor-windows.jpg]

---

# Three models, each answering one question

| Question | Model | Held-out result |
| --- | --- | --- |
| What is likely to break? | Logistic hazard model, 4,800 asset cycles | AUC 0.774 · Brier 0.165 |
| What should be done first? | Ridge-regularised priority model, 4,000 decisions | RMSE 4.6 on a 0–100 scale |
| Which window should be taken? | Conditional logit on recorded window choices | 77% agreement vs 28% baseline |

- Failure **probability** and failure **consequence** are kept separate: a bridge fails rarely but expensively, a track circuit often but cheaply
- Planner weights are **learned, not hand-picked**: 14.77 minutes per regulated train (15 generating)

---

# Explainable by construction

- **Why?** on any work order shows exactly what drives its score
- Priority is linear, so each driver = coefficient × (feature − training mean), and the parts sum exactly
- Failure risk is logistic, so it decomposes exactly in log-odds, and the UI says so
- Caught in development: duplicated features taught the model that *higher risk lowers priority*. Removing them fixed the sign and improved accuracy.

[Image: 04-backlog-why.jpg]

---

# Fewer, safer possessions

| Horizon | Blocks | Work orders scheduled | Possessions avoided | Line availability gain |
| --- | --- | --- | --- | --- |
| Day | 13 | 64 of 144 | 51 | 60% |
| Week | 44 | 138 of 144 | 94 | 46.5% · 6,285 min recovered |

- Departments inside one block work in parallel; protection is paid **once per possession**
- Example: 10 work orders from 3 departments in one 235-min block. 615 min less line time than planning them apart, and 90 min of protection paid once instead of 10 times.
- Week plan computed in about 250 ms
- 6 orders honestly deferred (deep screening, rail grinding, heavy tamping): each needs longer than the longest sanctioned band

[Image: 02-block-plan.jpg]
[Image: 03-why-this-window.jpg]

---

# Humans and hard rules have the last word

- **Safety gate** re-checks every hard rule at approval: work duration, running line, sanctioned window, crews, machinery, shift hours
- Corridor blocks state their traffic cost in the approval dialog: *"Granting it regulates 30 trains."*
- Named controller approval, written to an audit trail. Any block can be withdrawn with a reason.
- Plans meet the real day: **train delays**, **emergency work orders**, **move window**, **withdraw**. Each one re-runs the gate.

[Image: 05-approval-dialog.jpg]
[Image: 06-approved-schedule.jpg]

---

# A local AI assistant that touches language, never arithmetic

Optional. Qwen 2.5 running on the same machine through Ollama. Nothing leaves the laptop.

| It does | It never does |
| --- | --- |
| Reads an inspector's defect note into a **draft** work order, cross-checked against the asset register | Rank work |
| Explains a refusal or deferral in plain words | Choose a window |
| Drafts a possession notice from computed figures | Validate or approve anything |
| Answers questions from the plan, or says "The plan does not record that." | Change state without a person acting |

Example note: *"rail fracture near km 42 on the up line between Anand and Nadiad, needs ultrasonic testing before the next shift"* → Anand–Nadiad section, UP line, Engineering, USFD trolley, severity 4, emergency. The controller still files it.

[Image: 08-intake-draft.jpg]
[Image: 09-ask-the-plan.jpg]

---

# Honest limits and the path to production

- **Real:** corridor, timetable, sanctioned-window traffic costs
- **Synthetic, and labelled:** maintenance backlog and all three training histories (TMS/SMMS/TDMS data is not public)
- **Ready for real data:** `real_records.py` validates a division's extract line by line and refits all three models
  - Easiest start: the sanctioned block register → planner weights
  - Most valuable: completed maintenance cycles with defect outcomes → hazard model
- **Next:** live NTES / Control Office delay feed · TMS/SMMS/TDMS integration · constraint solver for packing · authenticated multi-user approval
- 57 automated tests · deterministic, reproducible plans

**AI ranks and packs. Hard rules and authorised human approval have the final say.**

[Image: 10-audit-trail.jpg]

END PASTE

---

## Screenshot index

All files are in `presentation/screenshots/`, taken from the running app at 1600×900.

| File | Shows | Best card |
| --- | --- | --- |
| `01-dashboard.jpg` | KPI tiles (144 pending, 96 past periodicity) + corridor occupancy heat strip | 1, 3 |
| `02-block-plan.jpg` | Week plan: 44 blocks · 138 orders · 94 avoided · 6,285 min · 46.5%, first block card with per-department timeline | 7 |
| `03-why-this-window.jpg` | "Why this window": 615 min saved, 90 min protection paid once, 30 trains regulated | 7 |
| `04-backlog-why.jpg` | Ranked backlog with the Why? panel open: priority drivers and failure-risk drivers | 6 |
| `05-approval-dialog.jpg` | Human approval dialog with corridor-block traffic warning | 8 |
| `06-approved-schedule.jpg` | Approved schedule with controller name, Notice and Withdraw actions | 8 |
| `07-corridor-windows.jpg` | Sanctioned corridor windows table, trains regulated per band | 4 |
| `08-intake-draft.jpg` | Defect note → AI-drafted work order form (USFD trolley, UP line, Anand–Nadiad) | 9 |
| `09-ask-the-plan.jpg` | "Ask the plan" answering why deep screening was deferred | 9 |
| `10-audit-trail.jpg` | Safety alerts page with the approval audit trail | 10 (optional) |

---

## Project fact sheet (for context and Q&A)

**What it is:** a working prototype for SIH26027, AI-powered automatic block planning for Indian Railways. It combines maintenance demands from three departments with corridor block availability and produces day, week and month block plans.

**Tech:** Node.js 20+ web app, no dependencies. Planner, safety gate and models are plain JavaScript modules served over a local HTTP API. Python scripts rebuild the corridor from DataMeet data and fit the models. The optional assistant uses Ollama + Qwen 2.5 7B locally.

**Corridor:** Vadodara (BRC) – Vasad (VDA) – Anand (ANND) – Nadiad (ND) – Mahemadabad (MHD) – Vatva (VTA) – Ahmedabad (ADI). 6 sections, 99.8 km, 180 trains, 1,044 legs.

**Backlog:** 23 activity types across the 3 departments; 228 assets; 144 work orders due or overdue; 96 past periodicity; 33 with reported defects. Traffic density per asset comes from the real timetable.

**Department setup + clearance:** Engineering 15 + 10 min · S&T 10 + 5 min · Traction Distribution 30 + 20 min.

**Block length rule:** each department's stream = setup + its work back to back + clearance. Block = the longest stream, because departments work in parallel.

**Window score (minutes):** clearance to nearest train (capped at 45) × 1 − minutes later in the day × 0.0106 − trains regulated × 14.77. The last two weights are fitted.

**Search:** the score is piecewise linear, so only interval edges, midpoints and constraint boundaries are tried. A month plan over 1,044 legs runs in about 150–250 ms.

**Safety gate checks:** duration fits the stream, work on the correct running line, section-wide work closes both lines, corridor blocks sit inside a sanctioned window, no train conflicts in natural windows, crew count, single machinery units, department shift hours, named approver.

**Real-time handling:** running delays shift every leg of that train and re-validate the schedule; emergencies go ahead of the model ranking; preferred start re-searches around a time; withdrawal returns work orders to the backlog.

**Not modelled:** speed restrictions after work, gang travel between sections, single-line working, weather. Grouping is greedy, not globally optimal.

**Likely judge questions**
- *Is 77% good?* Against 28% for taking the first window that fits, on held-out choices. It recovers the generating weights (14.77 vs 15).
- *Why not deep learning?* Linear/logistic models give exact explanations a controller can argue with, and the planner stays deterministic and reproducible.
- *What if the AI assistant is wrong?* It only drafts. Drafts pass the same intake validation plus a register cross-check, and a person files them.
- *Where does real data plug in?* Backlog and corridor modules, via `tools/real_records.py`, which validates and refits.
