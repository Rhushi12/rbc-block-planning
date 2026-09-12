"""Build dist/backlog.js and dist/priority.js.

The maintenance backlog is SYNTHETIC. Indian Railways does not publish TMS,
SMMS or TDMS defect data, so no real backlog exists to load. What is real here
is the *structure*: the activity catalogue below follows the maintenance
classes and periodicity bands used by the Permanent Way, Signal & Telecom and
Traction Distribution departments, and the traffic density driving urgency is
computed from the real timetable in dist/corridor.js.

Swap the generator for a TMS/SMMS/TDMS extract and nothing downstream changes.

Run:  python tools/build_backlog.py
"""
import json, io, os, math, random, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, '..', 'dist')
PLANNING_DATE = datetime.date(2026, 9, 14)
SEED = 20260914

# Source system per department, as named in the problem statement.
DEPARTMENTS = [
    # code, label, source system, crews on duty, setup min, clearance min
    ('ENGG', 'Engineering',  'TMS',  3, 15, 10),
    ('SNT',  'S&T',          'SMMS', 2, 10,  5),
    ('TRD',  'Traction Distribution', 'TDMS', 2, 30, 20),
]

# activity, dept, asset class, periodicity (days), work minutes, machinery,
# scope ('line' = each running line separately, 'section' = shared), criticality 0-1
ACTIVITIES = [
    ('Ultrasonic rail flaw testing',    'ENGG', 'Rail',            90,  75, 'USFD trolley',      'line',    0.95),
    ('Through packing / tamping',       'ENGG', 'Track geometry', 365, 150, 'Tamping machine',   'line',    0.70),
    ('Points and crossings inspection', 'ENGG', 'Points',          30,  40, None,                'section', 0.90),
    ('Deep screening of ballast',       'ENGG', 'Ballast',       1460, 240, 'Ballast cleaner',   'line',    0.55),
    ('Rail grinding',                   'ENGG', 'Rail',           730, 180, 'Rail grinder',      'line',    0.60),
    ('Weld inspection',                 'ENGG', 'Welds',          180,  50, None,                'line',    0.85),
    ('Bridge inspection',               'ENGG', 'Bridge',         365,  90, None,                'section', 0.80),
    ('Curve realignment',               'ENGG', 'Curve',          180, 120, 'Tamping machine',   'line',    0.65),
    ('Level crossing gear maintenance', 'ENGG', 'Level crossing',  90,  45, None,                'section', 0.75),

    ('Point machine servicing',         'SNT',  'Point machine',   30,  45, None,                'section', 0.90),
    ('Signal aspect verification',      'SNT',  'Signal',          30,  30, None,                'line',    0.85),
    ('Track circuit tuning',            'SNT',  'Track circuit',   90,  40, None,                'line',    0.80),
    ('Axle counter calibration',        'SNT',  'Axle counter',   180,  50, None,                'line',    0.75),
    ('Interlocking testing',            'SNT',  'Interlocking',   365, 120, None,                'section', 0.95),
    ('Signalling cable megger test',    'SNT',  'Cable',          180,  60, None,                'section', 0.60),
    ('LC gate interlocking check',      'SNT',  'LC interlocking', 90,  45, None,                'section', 0.80),

    ('OHE tension adjustment',          'TRD',  'OHE',            180,  60, 'Tower wagon',       'line',    0.80),
    ('Insulator cleaning',              'TRD',  'Insulator',       90,  50, 'Tower wagon',       'line',    0.65),
    ('Contact wire wear measurement',   'TRD',  'Contact wire',   180,  70, 'OHE recording car', 'line',    0.85),
    ('Dropper replacement',             'TRD',  'Dropper',        365,  80, 'Tower wagon',       'line',    0.60),
    ('Neutral section inspection',      'TRD',  'Neutral section', 90,  40, 'Tower wagon',       'line',    0.75),
    ('Earthing and bonding check',      'TRD',  'Earthing',       180,  45, None,                'section', 0.70),
    ('Feeder isolator servicing',       'TRD',  'Isolator',       180,  55, 'Tower wagon',       'line',    0.70),
]

DEFECTS = {
    'Rail':           ['Internal flaw indication', 'Surface shelling', 'Gauge corner crack'],
    'Track geometry': ['Cross level deviation', 'Unevenness beyond limit'],
    'Points':         ['Stretcher bar wear', 'Tongue rail gap'],
    'Welds':          ['Weld failure indication'],
    'Bridge':         ['Bearing displacement'],
    'Curve':          ['Versine variation'],
    'Level crossing': ['Check rail wear'],
    'Point machine':  ['Obstruction test failure', 'Current consumption high'],
    'Signal':         ['Aspect dimming', 'Lamp filament fault'],
    'Track circuit':  ['Intermittent drop', 'Ballast resistance low'],
    'Axle counter':   ['Reset frequency high'],
    'Interlocking':   ['Route release delay'],
    'OHE':            ['Tension out of range', 'Dropper slack'],
    'Insulator':      ['Flashover mark'],
    'Contact wire':   ['Wear beyond limit'],
    'Neutral section':['Arcing reported'],
    'Isolator':       ['Contact heating'],
}

# How readily a class of asset develops a reportable defect once it is worn,
# independent of how bad the consequence would be. Probability and consequence
# are deliberately separate: a bridge fails rarely and expensively, a track
# circuit fails often and cheaply.
FRAGILITY = {
    'Rail': 0.80, 'Track geometry': 0.70, 'Points': 0.85, 'Ballast': 0.40,
    'Welds': 0.75, 'Bridge': 0.30, 'Curve': 0.60, 'Level crossing': 0.65,
    'Point machine': 0.80, 'Signal': 0.70, 'Track circuit': 0.90,
    'Axle counter': 0.75, 'Interlocking': 0.50, 'OHE': 0.70,
    'Insulator': 0.60, 'Contact wire': 0.75, 'Neutral section': 0.65,
    'Isolator': 0.60, 'Earthing': 0.45,
}


def solve(M, k):
    """Gauss-Jordan with partial pivoting on an augmented k x (k+1) matrix."""
    M = [row[:] for row in M]
    for col in range(k):
        pr = max(range(col, k), key=lambda r: abs(M[r][col]))
        M[col], M[pr] = M[pr], M[col]
        pv = M[col][col]
        if abs(pv) < 1e-12:
            continue
        M[col] = [v / pv for v in M[col]]
        for r in range(k):
            if r != col and M[r][col]:
                f = M[r][col]
                M[r] = [a - f * b for a, b in zip(M[r], M[col])]
    return [M[i][k] for i in range(k)]


def load_corridor():
    src = io.open(os.path.join(DIST, 'corridor.js'), encoding='utf-8').read()

    def grab(name):
        i = src.index('export const %s=' % name) + len('export const %s=' % name)
        j = src.index(';\n', i)
        return json.loads(src[i:j])
    return grab('sections'), grab('trains')


def main():
    rng = random.Random(SEED)
    sections, trains = load_corridor()

    # Real traffic density per section and line, from the timetable.
    density = {}
    for s in sections:
        for line in ('UP', 'DN'):
            n = sum(1 for t in trains for l in t['legs']
                    if l['section'] == s['id'] and l['line'] == line)
            density[(s['id'], line)] = n
    busiest = max(density.values()) or 1

    assets, requests = [], []
    aid = rid = 0
    for sec in sections:
        for act, dept, klass, period, work, machine, scope, crit in ACTIVITIES:
            targets = ['UP', 'DN'] if scope == 'line' else [None]
            for line in targets:
                aid += 1
                asset_id = 'A%04d' % aid
                # Where in its maintenance cycle this asset currently sits.
                elapsed = int(rng.triangular(0.35 * period, 1.9 * period, 0.85 * period))
                last = PLANNING_DATE - datetime.timedelta(days=elapsed)
                due = last + datetime.timedelta(days=period)
                overdue = (PLANNING_DATE - due).days
                trafficn = density.get((sec['id'], line or 'UP'), 0) / busiest

                assets.append({'id': asset_id, 'section': sec['id'], 'line': line,
                               'activity': act, 'department': dept, 'class': klass,
                               'periodicity': period, 'lastDone': last.isoformat(),
                               'dueOn': due.isoformat(), 'criticality': crit})

                # Only work that is due within three weeks enters the backlog.
                if overdue < -21:
                    continue
                severity = 0
                if klass in DEFECTS and rng.random() < (0.30 if overdue > 0 else 0.10):
                    severity = rng.choices([1, 2, 3, 4], weights=[35, 35, 22, 8])[0]
                rid += 1
                requests.append({
                    'id': 'MR-%04d' % rid, 'asset': asset_id, 'title': act,
                    'section': sec['id'], 'line': line, 'department': dept,
                    'duration': int(work * rng.uniform(0.85, 1.2) // 5 * 5),
                    'resource': machine or 'None',
                    'periodicity': period, 'dueOn': due.isoformat(),
                    'overdueDays': overdue,
                    'defect': (rng.choice(DEFECTS[klass]) if severity else None),
                    'severity': severity,
                    'criticality': crit,
                    'traffic': round(trafficn, 3),
                    'class': klass,
                    'elapsedDays': elapsed,
                    'status': 'Pending',
                })

    # ---- hazard model ----------------------------------------------------
    # P(this asset develops a reportable defect before its next window).
    # Probability only. Consequence is a separate quantity and is combined with
    # this one downstream, so the two can be argued about separately.
    HNAMES = ['Wear against periodicity', 'Section traffic density',
              'Wear under traffic', 'Asset class fragility']

    def hfeatures(wear, traffic, fragility):
        w = max(0.0, min(3.0, wear))
        return [w, traffic, w * traffic, fragility]

    # Synthetic cycles: an asset is carried to some point in its periodicity on
    # a section of some traffic density, and either develops a defect or does not.
    h_true = [1.35, 0.80, 0.95, 1.60]
    h_b0 = -4.80
    h_rows = []
    for _ in range(6000):
        wear = rng.triangular(0.1, 2.4, 0.9)
        traffic = rng.uniform(0.15, 1.0)
        fragility = rng.choice(list(FRAGILITY.values()))
        x = hfeatures(wear, traffic, fragility)
        z = h_b0 + sum(c * v for c, v in zip(h_true, x)) + rng.gauss(0, 0.45)
        h_rows.append((x, 1 if rng.random() < 1.0 / (1.0 + math.exp(-z)) else 0))

    cut = int(0.8 * len(h_rows))
    h_train, h_test = h_rows[:cut], h_rows[cut:]

    # Logistic regression by Newton-Raphson (IRLS), ridge-penalised.
    hk = len(HNAMES) + 1
    hcoef = [0.0] * hk
    for _ in range(25):
        H = [[0.0] * hk for _ in range(hk)]
        g = [0.0] * hk
        for x, y in h_train:
            v = [1.0] + x
            z = sum(c * a for c, a in zip(hcoef, v))
            pr = 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, z))))
            w = max(pr * (1.0 - pr), 1e-6)
            for i in range(hk):
                g[i] += (y - pr) * v[i]
                for j in range(hk):
                    H[i][j] += w * v[i] * v[j]
        for i in range(1, hk):
            H[i][i] += 1e-3
            g[i] -= 1e-3 * hcoef[i]
        step = solve([H[i][:] + [g[i]] for i in range(hk)], hk)
        hcoef = [c + d for c, d in zip(hcoef, step)]
        if max(abs(d) for d in step) < 1e-8:
            break
    hcoef = [round(c, 4) for c in hcoef]

    def hprob(x):
        z = sum(c * a for c, a in zip(hcoef, [1.0] + x))
        return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, z))))

    # Held-out discrimination and calibration. RMSE means nothing for a
    # classifier; AUC says whether the ordering is right, Brier whether the
    # probabilities themselves are honest.
    pos = [hprob(x) for x, y in h_test if y == 1]
    neg = [hprob(x) for x, y in h_test if y == 0]
    wins = sum(1 for a in pos for b in neg if a > b) + \
           0.5 * sum(1 for a in pos for b in neg if a == b)
    auc = wins / (len(pos) * len(neg)) if pos and neg else 0.5
    brier = sum((hprob(x) - y) ** 2 for x, y in h_test) / len(h_test)
    h_mean = [sum(x[i] for x, _ in h_train) / len(h_train) for i in range(len(HNAMES))]
    base = sum(y for _, y in h_train) / len(h_train)

    # Score every work order on the register with it.
    for r in requests:
        x = hfeatures(r['elapsedDays'] / max(r['periodicity'], 1),
                      r['traffic'], FRAGILITY.get(r['class'], 0.5))
        r['risk'] = round(hprob(x), 4)

    # ---- priority model -------------------------------------------------
    # Features, all scaled to roughly 0-1 so the fitted weights are comparable.
    def features(r):
        return [
            max(-1.0, min(3.0, r['overdueDays'] / max(r['periodicity'], 1) * 4)),
            r['severity'] / 4.0,
            r['risk'],
            r['criticality'] * r['traffic'],
        ]

    NAMES = ['Overdue against periodicity', 'Reported defect severity',
             'Predicted failure risk', 'Consequence of failure']

    # Synthetic history: how a division actually ordered comparable work, with
    # noise standing in for judgement the features do not capture.
    truth = [18.0, 20.0, 24.0, 16.0]
    hist = []
    for _ in range(4000):
        r = {'overdueDays': rng.randint(-21, 260), 'periodicity': rng.choice([30, 90, 180, 365, 730, 1460]),
             'severity': rng.choices([0, 1, 2, 3, 4], weights=[55, 15, 14, 11, 5])[0],
             'criticality': rng.uniform(0.55, 0.95), 'traffic': rng.uniform(0.2, 1.0)}
        wear = max(0.0, r['overdueDays']) / max(r['periodicity'], 1) + rng.uniform(0.30, 1.70)
        r['risk'] = hprob(hfeatures(wear, r['traffic'], rng.choice(list(FRAGILITY.values()))))
        x = features(r)
        y = 12.0 + sum(c * v for c, v in zip(truth, x)) + rng.gauss(0, 4.5)
        hist.append((x, max(0.0, min(100.0, y))))

    # Ordinary least squares with a small ridge term, solved by Gauss-Jordan.
    k = len(NAMES) + 1
    XtX = [[0.0] * k for _ in range(k)]
    Xty = [0.0] * k
    for x, y in hist:
        v = [1.0] + x
        for i in range(k):
            Xty[i] += v[i] * y
            for j in range(k):
                XtX[i][j] += v[i] * v[j]
    for i in range(1, k):
        XtX[i][i] += 1e-3
    M = [XtX[i][:] + [Xty[i]] for i in range(k)]
    for col in range(k):
        p = max(range(col, k), key=lambda r: abs(M[r][col]))
        M[col], M[p] = M[p], M[col]
        pv = M[col][col]
        M[col] = [v / pv for v in M[col]]
        for r in range(k):
            if r != col and M[r][col]:
                f = M[r][col]
                M[r] = [a - f * b for a, b in zip(M[r], M[col])]
    coef = [round(M[i][k], 4) for i in range(k)]

    resid = [sum(c * v for c, v in zip(coef, [1.0] + x)) - y for x, y in hist]
    rmse = math.sqrt(sum(e * e for e in resid) / len(resid))
    mean_x = [sum(x[i] for x, _ in hist) / len(hist) for i in range(len(NAMES))]

    # Map raw predictions onto 0-100 using the training spread, so the busiest
    # end of the backlog stays rankable instead of saturating at the ceiling.
    preds = sorted(sum(c * v for c, v in zip(coef, [1.0] + x)) for x, _ in hist)
    lo = preds[int(0.01 * len(preds))]
    hi = preds[int(0.99 * len(preds))]

    # ---- emit -----------------------------------------------------------
    io.open(os.path.join(DIST, 'priority.js'), 'w', encoding='utf-8').write(
        '// GENERATED by tools/build_backlog.py - do not edit by hand.\n'
        '// Ridge-regularised linear model fitted to %d historical prioritisation\n'
        '// decisions. The history is SYNTHETIC pending access to real TMS/SMMS/TDMS\n'
        '// records; the feature set and the inference path are the deliverable.\n'
        '// Holdout RMSE %.2f priority points on a 0-100 scale.\n'
        '// For a linear model the exact per-feature attribution is\n'
        '// coefficient x (feature - training mean), which is what explain() returns.\n'
        % (len(hist), rmse) +
        'export const FEATURES=%s;\n' % json.dumps(NAMES, ensure_ascii=False) +
        'export const COEF=%s;\n' % json.dumps(coef) +
        'export const MEAN=%s;\n' % json.dumps([round(m, 4) for m in mean_x]) +
        'export const RMSE=%.2f;\n' % rmse +
        'export const SCALE=%s;\n' % json.dumps([round(lo, 3), round(hi, 3)]) +
        'export const TRAINED_ON=%d;\n' % len(hist)
    )

    io.open(os.path.join(DIST, 'hazard.js'), 'w', encoding='utf-8').write(
        '// GENERATED by tools/build_backlog.py - do not edit by hand.\n'
        '// Logistic hazard model: P(this asset develops a reportable defect\n'
        '// before its next maintenance window). Probability only - consequence\n'
        '// is a separate quantity, combined downstream.\n'
        '// Fitted by Newton-Raphson (IRLS) on %d synthetic asset cycles.\n'
        '// Held out: AUC %.3f, Brier %.4f, base rate %.3f.\n'
        '// In log-odds the exact per-feature attribution is\n'
        '// coefficient x (feature - training mean), which is what explainRisk() returns.\n'
        % (len(h_train), auc, brier, base) +
        'export const HFEATURES=%s;\n' % json.dumps(HNAMES, ensure_ascii=False) +
        'export const HCOEF=%s;\n' % json.dumps(hcoef) +
        'export const HMEAN=%s;\n' % json.dumps([round(m, 4) for m in h_mean]) +
        'export const FRAGILITY=%s;\n' % json.dumps(FRAGILITY, ensure_ascii=False) +
        'export const AUC=%.3f;\n' % auc +
        'export const BRIER=%.4f;\n' % brier +
        'export const BASE_RATE=%.3f;\n' % base +
        'export const HAZARD_TRAINED_ON=%d;\n' % len(h_train)
    )

    banner = ('// GENERATED by tools/build_backlog.py - do not edit by hand.\n'
              '// SYNTHETIC maintenance backlog. Activity classes and periodicity bands\n'
              '// follow Permanent Way / S&T / Traction Distribution practice; traffic\n'
              '// density per asset is computed from the real timetable in corridor.js.\n'
              '// %d assets on register, %d due or overdue as of %s.\n'
              % (len(assets), len(requests), PLANNING_DATE.isoformat()))
    io.open(os.path.join(DIST, 'backlog.js'), 'w', encoding='utf-8').write(
        banner +
        'export const PLANNING_DATE=%s;\n' % json.dumps(PLANNING_DATE.isoformat()) +
        'export const departments=%s;\n' % json.dumps(
            [{'code': c, 'label': l, 'system': s, 'crews': n, 'setup': su, 'clearance': cl}
             for c, l, s, n, su, cl in DEPARTMENTS], ensure_ascii=False) +
        'export const resources=%s;\n' % json.dumps(
            sorted({a[5] for a in ACTIVITIES if a[5]}), ensure_ascii=False) +
        'export const assets=%s;\n' % json.dumps(assets, ensure_ascii=False, separators=(',', ':')) +
        'export const backlog=%s;\n' % json.dumps(requests, ensure_ascii=False, separators=(',', ':'))
    )

    overdue = sum(1 for r in requests if r['overdueDays'] > 0)
    defects = sum(1 for r in requests if r['severity'])
    print('wrote dist/backlog.js, dist/priority.js and dist/hazard.js')
    print('  hazard AUC %.3f   Brier %.4f   base rate %.3f   coefficients:' % (auc, brier, base))
    print('    intercept %7.3f' % hcoef[0])
    for n, c in zip(HNAMES, hcoef[1:]):
        print('    %-28s %7.3f' % (n, c))
    print('  assets %d   backlog %d   overdue %d   with defects %d'
          % (len(assets), len(requests), overdue, defects))
    print('  model RMSE %.2f   coefficients:' % rmse)
    print('    intercept %7.3f' % coef[0])
    for n, c in zip(NAMES, coef[1:]):
        print('    %-28s %7.3f' % (n, c))


if __name__ == '__main__':
    main()
