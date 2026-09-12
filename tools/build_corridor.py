"""Build dist/corridor.js from the DataMeet Indian Railways dataset (CC0).

Source: https://github.com/datameet/railways  (stations.json, schedules.json)
Download those two files into tools/raw/ and run:  python tools/build_corridor.py

Produces the real Vadodara Jn - Ahmedabad Jn corridor: six block sections, their
real route kilometres, and every timetabled train leg over them, split by line.
"""
import json, io, math, os, collections

HERE = os.path.dirname(os.path.abspath(__file__))
RAW  = os.path.join(HERE, 'raw')
OUT  = os.path.join(HERE, '..', 'dist', 'corridor.js')

# Block stations on the Western Railway Vadodara-Ahmedabad main line, in order.
NODES = ['BRC', 'VDA', 'ANND', 'ND', 'MHD', 'VTA', 'ADI']
NAMES = {'BRC': 'Vadodara Jn', 'VDA': 'Vasad Jn', 'ANND': 'Anand Jn',
         'ND': 'Nadiad Jn', 'MHD': 'Mahemdavad Kheda Rd', 'VTA': 'Vatva',
         'ADI': 'Ahmedabad Jn'}


def haversine(a, b):
    (x1, y1), (x2, y2) = a, b
    p = math.pi / 180
    return 2 * 6371.0 * math.asin(math.sqrt(
        math.sin((y2 - y1) * p / 2) ** 2 +
        math.cos(y1 * p) * math.cos(y2 * p) * math.sin((x2 - x1) * p / 2) ** 2))


def minutes(s):
    if not s or s == 'None':
        return None
    h, m = s.split(':')[:2]
    return int(h) * 60 + int(m)


def main():
    stations = json.load(io.open(os.path.join(RAW, 'stations.json'), encoding='utf-8'))['features']
    coords = {f['properties']['code']: f['geometry']['coordinates']
              for f in stations if f.get('geometry') and f.get('properties')}

    sections = []
    for i in range(len(NODES) - 1):
        a, b = NODES[i], NODES[i + 1]
        sections.append({
            'id': 'S%d' % (i + 1), 'a': a, 'b': b,
            'name': '%s — %s' % (NAMES[a], NAMES[b]),
            'code': '%s–%s' % (a, b),
            'km': round(haversine(coords[a], coords[b]), 1),
        })

    rows = json.load(io.open(os.path.join(RAW, 'schedules.json'), encoding='utf-8'))
    by_train = collections.defaultdict(list)
    for r in rows:
        by_train[r['train_number']].append(r)
    for t in by_train:
        by_train[t].sort(key=lambda r: r['id'])

    trains = []
    for number, stops in by_train.items():
        order = {r['station_code']: k for k, r in enumerate(stops)}
        legs = []
        for sec in sections:
            a, b = sec['a'], sec['b']
            if a not in order or b not in order:
                continue
            ra, rb = stops[order[a]], stops[order[b]]
            up = order[a] < order[b]          # BRC -> ADI is the UP direction here
            dep = minutes(ra['departure'] if up else rb['departure'])
            arr = minutes(rb['arrival'] if up else ra['arrival'])
            if dep is None or arr is None:
                continue
            if arr < dep:
                arr += 1440                    # leg crosses midnight
            if not 0 < arr - dep <= 180:
                continue                       # drop implausible timings
            legs.append({'section': sec['id'], 'line': 'UP' if up else 'DN',
                         'start': dep, 'end': arr})
        if not legs:
            continue
        legs.sort(key=lambda l: l['start'])
        trains.append({'id': number, 'name': stops[0]['train_name'].title(), 'legs': legs})

    trains.sort(key=lambda t: t['legs'][0]['start'])

    # ---- corridor block windows ------------------------------------------
    # A corridor block is a sanctioned window in which traffic is regulated, so
    # it is not free: its cost is the trains that must be cancelled, diverted or
    # rescheduled. Pick, per running line, the band that disrupts the fewest.
    # A corridor-wide band means a train is regulated once, not once per section.
    # 'BOTH' is the band for work that closes the whole section, such as points,
    # interlocking or a bridge: it must clear traffic on every running line.
    windows = []
    for line in ('UP', 'DN', 'BOTH'):
        legs = [l for t in trains for l in t['legs']
                if line == 'BOTH' or l['line'] == line]
        owner = {}
        for t in trains:
            for l in t['legs']:
                if line == 'BOTH' or l['line'] == line:
                    owner.setdefault(id(l), t['id'])
        def regulated(start, end):
            # A window may run past midnight, so compare in a two-day space.
            hit = set()
            for l in legs:
                if any(start < l['end'] + o and l['start'] + o < end
                       for o in (-1440, 0, 1440)):
                    hit.add(owner[id(l)])
            return hit

        for length in (120, 180, 240):
            best = None
            for start in range(0, 1440, 15):
                n = len(regulated(start, start + length))
                if best is None or n < best[2]:
                    best = (start, start + length, n)
            windows.append({'line': line, 'start': best[0], 'end': best[1],
                            'minutes': length, 'trainsAffected': best[2]})

    for s in sections:
        del s['a'], s['b']

    banner = ('// GENERATED by tools/build_corridor.py - do not edit by hand.\n'
              '// Real Western Railway timetable data derived from the DataMeet\n'
              '// Indian Railways dataset (CC0): https://github.com/datameet/railways\n'
              '// %d trains, %d section legs over %d block sections.\n'
              % (len(trains), sum(len(t['legs']) for t in trains), len(sections)))

    js = banner
    js += 'export const sections=' + json.dumps(sections, ensure_ascii=False) + ';\n'
    js += 'export const lines=["UP","DN"];\n'
    js += 'export const trains=' + json.dumps(trains, ensure_ascii=False, separators=(',', ':')) + ';\n'
    js += ('// Sanctioned corridor block windows: the lowest-disruption band per running\n'
           '// line, with the number of trains that must be regulated to grant it.\n')
    js += 'export const corridorWindows=' + json.dumps(windows, ensure_ascii=False) + ';\n'
    io.open(OUT, 'w', encoding='utf-8').write(js)

    print('wrote %s' % os.path.normpath(OUT))
    print('  sections %d   trains %d   legs %d'
          % (len(sections), len(trains), sum(len(t['legs']) for t in trains)))
    for w in windows:
        print('  corridor %s %3dmin  %02d:%02d-%02d:%02d  regulates %d trains'
              % (w['line'], w['minutes'], w['start'] // 60, w['start'] % 60,
                 (w['end'] // 60) % 24, w['end'] % 60, w['trainsAffected']))


if __name__ == '__main__':
    main()
