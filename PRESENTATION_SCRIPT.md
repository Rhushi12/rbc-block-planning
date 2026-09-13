# RBC — AI-Powered Automatic Block Planning
## 10-slide presentation script · SIH26027 · Ministry of Railways

Every figure below was reproduced live on 2026-09-13 from `npm test`, `npm run build`
and the running API, so each one can be demonstrated if a judge asks.
Target length: about 8 minutes of talking plus a 3-minute live demo at slide 8.

---

### Slide 1 — Title

**On the slide**
- RBC — AI-Powered Automatic Block Planning
- SIH26027 · Ministry of Railways · Transportation & Logistics
- *"Plan the corridor, not the department."*

**Visual:** the dashboard's corridor-occupancy strip as a full-bleed background.

**Say (≈30 s)**
> "Every day, Engineering, Signal & Telecom and Traction Distribution each ask for time on the
> same track, and each one plans on its own. We built a system that plans all three together
> against the real timetable, ranks the work with trained models, and packs it into the fewest
> safe possessions. It runs on one laptop with no internet, no login and no API keys."

---

### Slide 2 — The problem

**On the slide**
- 3 departments · 3 systems (TMS, SMMS, TDMS) · 1 shared track
- Each department pays its own setup and clearance, every time
- Line time lost to repeated possessions = lost trains
- No shared view of what is overdue, what is risky, or what window is free

**Visual:** three separate block requests on one section, overlapping and repeating protection.

**Say (≈45 s)**
> "Today a signal crew takes a block, clears, and an hour later an OHE crew takes another block
> on the same section. Traction alone needs 30 minutes to isolate and earth, plus 20 to restore,
> before anyone touches the wire. When each department plans separately, that overhead is paid
> again and again, and every one of those minutes is track that could have carried trains.
> The problem statement asks us to unify these demands, prioritise them, and plan over a day,
> a week and a month."

---

### Slide 3 — Built on the real corridor

**On the slide**
- Western Railway main line, **Vadodara Jn → Ahmedabad Jn**
- 6 block sections · 99.8 route km
- **180 timetabled trains · 1,044 section legs**, each on UP or DN
- Source: DataMeet Indian Railways open dataset (CC0)

**Visual:** the corridor map BRC–VDA–ANND–ND–MHD–VTA–ADI with the occupancy heat strip.

**Say (≈45 s)**
> "We didn't draw a toy railway. The corridor is built from the real DataMeet timetable:
> 180 trains resolved onto the correct running line in each of six sections. That mattered
> immediately. The textbook assumption is that a block closes a section. On this corridor,
> with both lines treated as occupied, the longest gap in 24 hours is 42 minutes.
> Nothing fits."

---

### Slide 4 — What the real timetable revealed

**On the slide**
- Both lines closed → longest free gap **42 min**
- Split by running line → longest natural gap **131 min**, most under an hour
- Answer: **sanctioned corridor blocks**, priced in trains regulated

| Line | 120 min | 180 min | 240 min |
| --- | --- | --- | --- |
| UP | 10:15–12:15 · 6 trains | 09:15–12:15 · 9 | 19:45–23:45 · 12 |
| DN | 07:30–09:30 · 6 trains | 01:30–04:30 · 10 | 05:45–09:45 · 15 |
| Both | 09:00–11:00 · 17 trains | 07:45–10:45 · 27 | 10:15–14:15 · 33 |

**Visual:** the table, with "Both lines" shaded to show the cost.

**Say (≈50 s)**
> "Splitting by running line helps, but the longest natural window is still 131 minutes. That's
> exactly why Indian Railways sanctions corridor blocks, where time is bought by regulating
> traffic. So we priced every candidate window. Our tool slides each band across the real
> timetable and finds the cheapest one, measured in trains cancelled, diverted or rescheduled.
> Section-wide work like points or a bridge closes both lines, which is why it costs 17 to 33
> trains instead of 6."

---

### Slide 5 — Three models, each answering one question

**On the slide**

| Question | Model | Held-out result |
| --- | --- | --- |
| What is likely to break? | Logistic hazard model | **AUC 0.774** · Brier 0.165 |
| What should be done first? | Ridge-regularised priority model | **RMSE 4.6** on 0–100 |
| Which window should be taken? | Conditional logit on window choices | **77%** agreement vs 28% baseline |

- Probability and consequence kept **separate**: a bridge fails rarely but expensively, a track circuit often but cheaply

**Visual:** three boxes feeding into the planner.

**Say (≈60 s)**
> "We didn't build one black box. We built three models, because there are three different
> questions. The hazard model predicts the probability that an asset develops a defect before
> its next window. The priority model ranks the work on overdue days, defect severity,
> predicted risk and consequence. And the planner's trade-off weights aren't typed in by hand.
> They're learned from which window was actually chosen out of those on offer. That answers
> 'who picked that number?' with data, not opinion. The weights agree with the recorded choice
> 77% of the time, against 28% for simply taking the first window that fits."

---

### Slide 6 — Explainable by construction

**On the slide**
- Every priority score decomposes **exactly** into its drivers
  - linear model → `coefficient × (feature − mean)`
- Hazard decomposes exactly in **log-odds**, and the UI says so
- A fitting bug we caught: duplicated features made *higher risk lower priority*. Removing them fixed the sign and improved error.

**Visual:** screenshot of the **Why?** panel on the top-ranked work order.

**Say (≈45 s)**
> "A section controller has to be able to argue with the system. Press 'Why?' on any work
> order and you see exactly how much each factor added. Not an approximation: the exact
> attribution, because the model is linear. We also kept an honest trail. An early version
> counted criticality twice and learned that riskier assets deserve lower priority. We found
> it, removed the duplicate, and the fix also improved accuracy."

---

### Slide 7 — Fewer, safer possessions

**On the slide**

| Horizon | Blocks | Orders scheduled | Possessions avoided | Line availability gain |
| --- | --- | --- | --- | --- |
| Day | 13 | 64 of 144 | 51 | **60%** |
| Week | 44 | 138 of 144 | 94 | **46.5%** · 6,285 min recovered |

- Crews in one block work **in parallel**; protection is paid **once per possession**
- Whole-month plan over 1,044 train legs in about a quarter of a second
- 6 orders honestly deferred: deep screening, rail grinding, heavy tamping all exceed the longest sanctioned band

**Visual:** one block card showing 10 work orders across 3 departments in a single 235-minute possession.

**Say (≈60 s)**
> "Here's the payoff. Over a week, 138 of 144 work orders fit into 44 possessions, which is 94
> fewer than planning each one separately and 6,285 line-minutes handed back to traffic. The
> saving comes from consolidation: departments work side by side inside one block, so traction's
> 50 minutes of protection is paid once, not five times. And we don't pad the numbers. Six
> jobs never fit, because they need more time than the longest sanctioned band. The plan says
> so and tells the controller to raise an extended block with traffic diverted."

---

### Slide 8 — Live demonstration (≈3 min)

**On the slide**
- Dashboard → Backlog → **Why?** → Block Plan (Week) → Approve → Approved Schedule

**Visual:** switch to the running app at `http://127.0.0.1:5173`.

**Demo path**
1. **Dashboard:** "144 pending orders over 228 assets, and here's how busy both lines are."
2. **Maintenance Backlog:** open **Why?** on the top order.
3. **Block Plan:** choose **Week** → **Generate plan**. *"44 blocks, 138 orders, in about 250 milliseconds."*
4. Read one card's **Why this window**: orders combined, minutes saved, protection paid once, trains regulated.
5. **Approve:** type a controller name. *"The safety gate re-runs every rule before it commits."*
6. **Corridor & Traffic:** add a running delay → the approved block is re-checked and flagged in **Safety Alerts**.

> Before presenting, click **Reset data** in the sidebar. The browser remembers delays and
> approvals from earlier sessions, and a leftover delay will change the plan's figures.

---

### Slide 9 — Humans and hard rules have the last word

**On the slide**
- **Safety gate** re-validates at approval: duration, running line, sanctioned window, crews, machinery, shifts
- Plans meet reality: **train delays**, **emergencies**, **move window**, **withdraw block**. Each one re-runs the gate.
- Local language assistant (Qwen via Ollama), optional:
  - reads a defect note into a **draft** work order, checked against the asset register
  - writes possession notices and plain-English explanations from computed facts
  - answers questions only from the plan, or says *"The plan does not record that."*
  - **never ranks, schedules, validates or approves**

**Visual:** the approval dialog ("This corridor block regulates 30 trains") beside the intake draft.

**Say (≈50 s)**
> "AI ranks and packs, but it never has the final say. Every approval re-runs the hard rules
> against current data, so a stale recommendation is rejected and logged. A late train, an
> emergency or a withdrawn block each trigger the same check. The optional local assistant
> handles language only. It turns an inspector's sentence into a draft form, checked against
> the asset register, and the controller files it. It has no path to the ranking, the search
> or the gate."

---

### Slide 10 — Honest limits and the path to production

**On the slide**
- **Real:** corridor, timetable, sanctioned-window costs
- **Synthetic, and labelled so:** the backlog and the training history for all three models
- **Ready for real data:** `tools/real_records.py` validates a division's extract and refits every model
  - easiest: block register → planner weights · hardest: completed-cycle defect history → hazard model
- **Next:** live NTES/COA delay feed · TMS/SMMS/TDMS integration · a constraint solver for packing · multi-user authority
- 57 automated tests · runs fully offline · no install

**Visual:** a three-step roadmap: Prototype → Division pilot on real records → Integration.

**Say (≈45 s, then close)**
> "We're clear about what's real. The corridor and timetable are real. The maintenance backlog
> is synthetic, because TMS, SMMS and TDMS data isn't public, so our model accuracy figures
> show that the method works, not how it performs on the railway. That's why we built the path
> out: a validator that checks a division's real extract line by line and refits all three
> models from it. A block register is enough to start. Give us one division's records and this
> becomes a pilot.
>
> AI ranks and packs. Hard rules and authorised human approval have the final say. Thank you."

---

### Likely questions, with short answers

- **"Is 77% good?"** It's against a 28% baseline of taking the first window that fits, on held-out choices. On synthetic history it shows the fit recovers the true weights (14.77 learned vs 15 generating).
- **"Why not deep learning?"** Linear and logistic models decompose exactly, so every score can be explained to a controller. The planner is deterministic, so every plan is reproducible.
- **"Is the packing optimal?"** No. Grouping is greedy, deterministic and explainable. A constraint solver is on the roadmap.
- **"What if the language model gets something wrong?"** It only drafts. Every draft passes the same intake validation and a register cross-check, and a person files it.
- **"What isn't modelled?"** Speed restrictions after work, gang travel between sections, single-line working, and weather.
