#!/usr/bin/env python3
"""The contract a real TMS / SMMS / TDMS extract has to meet, and the loader
that reads one.

Every model in this prototype is fitted to generated history, and saying so is
not the same as being ready for the alternative. This module is what makes the
claim checkable: it states exactly which columns a division would have to hand
over, validates an extract against that contract line by line, and hands the
same shapes to the fitting code that the generator hands it. Nothing downstream
knows the difference.

    python tools/real_records.py --template tools/records    write blank templates
    python tools/real_records.py --check tools/records       validate an extract

Then refit against it:

    python tools/build_backlog.py --records tools/records
    python tools/build_weights.py --records tools/records

Four files, because four different things are fitted or seeded:

  assets.csv     the register: what exists, how often it is attended, how bad
                 a failure would be. Seeds the backlog.
  defects.csv    what is currently reported against those assets.
  cycles.csv     one row per completed maintenance cycle, and whether a
                 reportable defect was found at the end of it. This is the
                 hazard model's training set, and the one nobody can generate
                 honestly - it is a record of what actually broke.
  decisions.csv  how work was actually ordered, for the priority model.
  windows.csv    which block window was chosen out of those available, for the
                 planner objective. A sanctioned block register already holds
                 this, which makes it the easiest of the three to get.
"""

import argparse, csv, io, os, sys, datetime

SCHEMA = {
    'assets.csv': {
        'required': ['asset_id', 'section_id', 'line', 'activity', 'department',
                     'asset_class', 'periodicity_days', 'last_done', 'criticality'],
        'note': 'One row per maintainable asset on the register.',
        'example': ['A0001', 'S1', 'UP', 'Ultrasonic rail flaw testing', 'ENGG',
                    'Rail', '90', '2026-06-24', '0.95'],
    },
    'defects.csv': {
        'required': ['asset_id', 'reported_on', 'defect', 'severity'],
        'note': 'Open defects. severity 1-4, where 4 is a reported fracture or failure.',
        'example': ['A0001', '2026-08-30', 'Internal flaw indication', '3'],
    },
    'cycles.csv': {
        'required': ['asset_id', 'cycle_start', 'cycle_end', 'periodicity_days',
                     'traffic_density', 'asset_class', 'defect_found'],
        'note': ('One row per completed cycle. defect_found is 1 if a reportable '
                 'defect was found by the end of it, else 0. This is the hazard '
                 'model training set.'),
        'example': ['A0001', '2026-03-01', '2026-06-24', '90', '1.0', 'Rail', '1'],
    },
    'decisions.csv': {
        'required': ['decision_id', 'overdue_days', 'periodicity_days', 'severity',
                     'criticality', 'traffic_density', 'assigned_priority'],
        'note': ('How work was actually ordered. assigned_priority on any consistent '
                 'scale; it is rescaled to 0-100 during the fit.'),
        'example': ['D0001', '42', '90', '2', '0.95', '1.0', '78'],
    },
    'windows.csv': {
        'required': ['choice_set_id', 'candidate_id', 'clearance_min',
                     'minutes_into_day', 'trains_regulated', 'chosen'],
        'note': ('One row per candidate window that was on offer, chosen=1 for the '
                 'one sanctioned. Exactly one chosen per choice_set_id.'),
        'example': ['B0001', 'C1', '22', '615', '0', '1'],
    },
}


class RecordError(Exception):
    pass


def _rows(path):
    with io.open(path, newline='', encoding='utf-8-sig') as fh:
        return list(csv.DictReader(fh))


def write_templates(directory):
    os.makedirs(directory, exist_ok=True)
    for name, spec in SCHEMA.items():
        with io.open(os.path.join(directory, name), 'w', newline='', encoding='utf-8') as fh:
            w = csv.writer(fh)
            w.writerow(spec['required'])
            w.writerow(spec['example'])
        print('wrote %s  (%s)' % (os.path.join(directory, name), spec['note']))


def validate(directory, required_files=None):
    """Check an extract against the contract. Returns {filename: [rows]}.

    Reports every problem it finds rather than stopping at the first, because a
    division sending an extract deserves one list of corrections, not five
    rounds of trial and error.
    """
    problems, loaded = [], {}
    wanted = required_files or list(SCHEMA)

    for name in wanted:
        path = os.path.join(directory, name)
        spec = SCHEMA[name]
        if not os.path.exists(path):
            problems.append('%s is missing. Columns: %s'
                            % (name, ', '.join(spec['required'])))
            continue
        try:
            rows = _rows(path)
        except Exception as e:
            problems.append('%s could not be read: %s' % (name, e))
            continue
        if not rows:
            problems.append('%s has a header but no rows.' % name)
            continue
        missing = [c for c in spec['required'] if c not in rows[0]]
        if missing:
            problems.append('%s is missing columns: %s' % (name, ', '.join(missing)))
            continue
        loaded[name] = rows

    def numeric(name, rows, col, lo=None, hi=None, integer=False):
        for i, r in enumerate(rows, start=2):
            raw = (r.get(col) or '').strip()
            try:
                v = int(raw) if integer else float(raw)
            except ValueError:
                problems.append('%s line %d: %s is %r, expected a number.'
                                % (name, i, col, raw))
                continue
            if lo is not None and v < lo or hi is not None and v > hi:
                problems.append('%s line %d: %s is %s, expected between %s and %s.'
                                % (name, i, col, v, lo, hi))

    def dates(name, rows, col):
        for i, r in enumerate(rows, start=2):
            raw = (r.get(col) or '').strip()
            try:
                datetime.date.fromisoformat(raw)
            except ValueError:
                problems.append('%s line %d: %s is %r, expected YYYY-MM-DD.'
                                % (name, i, col, raw))

    if 'assets.csv' in loaded:
        rows = loaded['assets.csv']
        numeric('assets.csv', rows, 'periodicity_days', lo=1, integer=True)
        numeric('assets.csv', rows, 'criticality', lo=0.0, hi=1.0)
        dates('assets.csv', rows, 'last_done')
        for i, r in enumerate(rows, start=2):
            if (r.get('line') or '').strip() not in ('UP', 'DN', '', 'BOTH'):
                problems.append('assets.csv line %d: line is %r, expected UP, DN or '
                                'blank for section-wide work.' % (i, r.get('line')))
        ids = [r['asset_id'] for r in rows]
        if len(set(ids)) != len(ids):
            problems.append('assets.csv: asset_id must be unique.')

    if 'defects.csv' in loaded:
        numeric('defects.csv', loaded['defects.csv'], 'severity', lo=1, hi=4, integer=True)
        dates('defects.csv', loaded['defects.csv'], 'reported_on')
        if 'assets.csv' in loaded:
            known = {r['asset_id'] for r in loaded['assets.csv']}
            for i, r in enumerate(loaded['defects.csv'], start=2):
                if r['asset_id'] not in known:
                    problems.append('defects.csv line %d: asset_id %r is not on the register.'
                                    % (i, r['asset_id']))

    if 'cycles.csv' in loaded:
        rows = loaded['cycles.csv']
        numeric('cycles.csv', rows, 'periodicity_days', lo=1, integer=True)
        numeric('cycles.csv', rows, 'traffic_density', lo=0.0, hi=1.0)
        numeric('cycles.csv', rows, 'defect_found', lo=0, hi=1, integer=True)
        dates('cycles.csv', rows, 'cycle_start')
        dates('cycles.csv', rows, 'cycle_end')
        found = sum(1 for r in rows if (r.get('defect_found') or '').strip() == '1')
        if rows and found in (0, len(rows)):
            problems.append('cycles.csv: every row has the same defect_found value, '
                            'so a hazard model cannot be fitted from it.')
        if 0 < len(rows) < 200:
            problems.append('cycles.csv: %d rows. A hazard model fitted on fewer than '
                            'a few hundred cycles should not be trusted; report it as '
                            'indicative.' % len(rows))

    if 'decisions.csv' in loaded:
        rows = loaded['decisions.csv']
        numeric('decisions.csv', rows, 'overdue_days', integer=True)
        numeric('decisions.csv', rows, 'periodicity_days', lo=1, integer=True)
        numeric('decisions.csv', rows, 'severity', lo=0, hi=4, integer=True)
        numeric('decisions.csv', rows, 'criticality', lo=0.0, hi=1.0)
        numeric('decisions.csv', rows, 'traffic_density', lo=0.0, hi=1.0)
        numeric('decisions.csv', rows, 'assigned_priority')

    if 'windows.csv' in loaded:
        rows = loaded['windows.csv']
        numeric('windows.csv', rows, 'clearance_min', lo=0.0)
        numeric('windows.csv', rows, 'minutes_into_day', lo=0.0)
        numeric('windows.csv', rows, 'trains_regulated', lo=0.0)
        numeric('windows.csv', rows, 'chosen', lo=0, hi=1, integer=True)
        sets = {}
        for r in rows:
            sets.setdefault(r['choice_set_id'], []).append(r)
        for sid, group in sets.items():
            picked = sum(1 for r in group if (r.get('chosen') or '').strip() == '1')
            if picked != 1:
                problems.append('windows.csv: choice set %s has %d chosen rows, '
                                'expected exactly 1.' % (sid, picked))
            if len(group) < 2:
                problems.append('windows.csv: choice set %s has one candidate, so it '
                                'carries no information about the tradeoff.' % sid)

    if problems:
        raise RecordError('\n'.join('  - ' + p for p in problems))
    return loaded


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--template', metavar='DIR', help='write blank templates into DIR')
    ap.add_argument('--check', metavar='DIR', help='validate an extract in DIR')
    args = ap.parse_args()

    if args.template:
        write_templates(args.template)
        return 0
    if args.check:
        try:
            loaded = validate(args.check)
        except RecordError as e:
            print('This extract does not meet the contract:\n%s' % e)
            return 1
        for name, rows in loaded.items():
            print('ok  %-16s %d rows' % (name, len(rows)))
        print('\nExtract accepted. Refit with:')
        print('  python tools/build_backlog.py --records %s' % args.check)
        print('  python tools/build_weights.py --records %s' % args.check)
        return 0
    ap.print_help()
    return 0


if __name__ == '__main__':
    sys.exit(main())
