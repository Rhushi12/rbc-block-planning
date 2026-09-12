#!/usr/bin/env python3
"""Fit the planner's objective weights instead of choosing them by hand.

The planner scores a candidate window as

    clearance to the nearest train  x  w_headroom
  - minutes later in the day        x  w_earliness
  - trains regulated                x  w_trainRegulated

Those three numbers used to be typed in. "Who picked 15?" is a fair question
and "it felt about right" is a poor answer, so they are learned here from which
window was chosen out of the ones that were available.

The model is a conditional logit: given a set of admissible windows, the
probability of choosing one is proportional to exp(utility). That is the
standard discrete-choice model for exactly this - a decision maker picking one
option from a set - and it is what makes the weights recoverable at all.

Only ratios are identified in a conditional logit (scaling every weight and the
noise together changes nothing), so the fit is reported normalised to
w_headroom = 1, which is also the unit the planner works in: minutes.

The choice history is SYNTHETIC. What is real is the structure: controllers
prefer a window with room either side, prefer earlier in the day, and dislike
regulating traffic far more than either. The fitting procedure and the
inference path are the deliverable; point it at a division's sanctioned block
register and refit.

    python tools/build_weights.py
"""

import json, io, os, math, random

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, '..', 'dist')
SEED = 20260914
SETS = 3000
NAMES = ['headroom', 'earliness', 'trainRegulated']

# What a controller actually trades off, in minutes. Recovering these is the
# test of the procedure; in production they are unknown and the register decides.
TRUTH = {'headroom': 1.0, 'earliness': 0.01, 'trainRegulated': 15.0}
BETA = 9.0          # judgement noise: how sharply the best option is preferred
HEADROOM_CAP = 45   # clearance past this buys nothing, as in the planner


def utility(w, f):
    return w[0] * f[0] - w[1] * f[1] - w[2] * f[2]


def softmax(vals):
    m = max(vals)
    e = [math.exp(v - m) for v in vals]
    t = sum(e)
    return [v / t for v in e]


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


def candidates(rng):
    """One admissible set, shaped like the choices the planner actually faces.

    Identification depends on this. If every set held a natural gap, a corridor
    window would never be chosen - the traffic weight is large enough that it
    always loses - and the data would fix only a lower bound on it, not a value.
    What pins the number down is the sets where the timetable leaves nothing
    long enough and the choice is between sanctioned windows of differing cost,
    which on this corridor is the common case rather than the exception.
    """
    roll = rng.random()
    out = []
    if roll < 0.35:
        # Nothing natural is long enough: sanctioned windows only.
        for _ in range(rng.randint(2, 5)):
            out.append([0.0, float(rng.randint(0, 1400)), float(rng.randint(1, 40))])
    elif roll < 0.80:
        # Both kinds on offer.
        for _ in range(rng.randint(2, 4)):
            out.append([float(min(HEADROOM_CAP, rng.randint(1, 60))),
                        float(rng.randint(0, 1400)), 0.0])
        for _ in range(rng.randint(1, 3)):
            out.append([0.0, float(rng.randint(0, 1400)), float(rng.randint(1, 40))])
    else:
        # A quiet section: several natural gaps, nothing to regulate.
        for _ in range(rng.randint(3, 6)):
            out.append([float(min(HEADROOM_CAP, rng.randint(1, 60))),
                        float(rng.randint(0, 1400)), 0.0])
    rng.shuffle(out)
    return out


def main():
    rng = random.Random(SEED)
    truth = [TRUTH[n] for n in NAMES]

    sets = []
    for _ in range(SETS):
        opts = candidates(rng)
        probs = softmax([utility(truth, f) / BETA for f in opts])
        pick, acc, roll = 0, 0.0, rng.random()
        for i, p in enumerate(probs):
            acc += p
            if roll <= acc:
                pick = i
                break
        sets.append((opts, pick))

    cut = int(0.8 * len(sets))
    train, test = sets[:cut], sets[cut:]

    # Newton-Raphson on the conditional log-likelihood.
    #
    # Gradient descent was the wrong tool here: clearance runs to 45 minutes,
    # lateness to 1400 and regulated trains to 40, so no single step size suits
    # all three and the traffic weight converged far too slowly to be trusted.
    # Newton uses the curvature, is invariant to how the features are scaled,
    # and settles in about ten passes.
    #
    # Signed features, so utility is a plain dot product: clearance counts for,
    # lateness and regulated traffic count against.
    def signed(f):
        return [f[0], -f[1], -f[2]]

    rows = [([signed(f) for f in opts], pick) for opts, pick in train]

    w = [0.0, 0.0, 0.0]
    for _ in range(60):
        g = [0.0, 0.0, 0.0]
        H = [[0.0] * 3 for _ in range(3)]
        for zs, pick in rows:
            ps = softmax([sum(a * b for a, b in zip(w, z)) for z in zs])
            bar = [sum(p * z[j] for p, z in zip(ps, zs)) for j in range(3)]
            for j in range(3):
                g[j] += zs[pick][j] - bar[j]
                for k2 in range(3):
                    # Var(z) under the choice probabilities: the negative Hessian.
                    H[j][k2] += sum(p * z[j] * z[k2] for p, z in zip(ps, zs))                                 - bar[j] * bar[k2]
        for j in range(3):
            H[j][j] += 1e-8                      # keep it invertible near the optimum
        step = solve([H[j][:] + [g[j]] for j in range(3)], 3)
        w = [a + b for a, b in zip(w, step)]
        if max(abs(d) for d in step) < 1e-10:
            break

    # Normalise to minutes of clearance, the unit the planner already works in.
    scale = w[0] if w[0] > 1e-9 else 1.0
    learned = [v / scale for v in w]

    def hit_rate(rows):
        ok = 0
        for opts, pick in rows:
            us = [utility(learned, f) for f in opts]
            if max(range(len(us)), key=lambda i: us[i]) == pick:
                ok += 1
        return ok / len(rows)

    ll = 0.0
    for opts, pick in test:
        ps = softmax([utility(w, f) for f in opts])
        ll += math.log(max(ps[pick], 1e-12))
    ll /= len(test)

    train_hit, test_hit = hit_rate(train), hit_rate(test)
    # What you would get by always taking the first admissible window.
    naive = sum(1 for opts, pick in test if pick == 0) / len(test)

    io.open(os.path.join(DIST, 'weights.js'), 'w', encoding='utf-8').write(
        '// GENERATED by tools/build_weights.py - do not edit by hand.\n'
        '// Conditional-logit fit of the planner objective to %d recorded window\n'
        '// choices. The history is SYNTHETIC pending access to a division\'s\n'
        '// sanctioned block register; the fitting procedure is the deliverable.\n'
        '// Held out: top-1 agreement %.3f against %.3f for taking the first\n'
        '// admissible window, mean log-likelihood %.4f.\n'
        '// Only ratios are identified in a conditional logit, so the weights are\n'
        '// normalised to headroom = 1 - which is also the planner\'s unit, minutes.\n'
        % (len(train), test_hit, naive, ll) +
        'export const LEARNED={headroom:%.4f,earliness:%.4f,trainRegulated:%.4f};\n'
        % tuple(learned) +
        'export const FIT={sets:%d,agreement:%.3f,baseline:%.3f,logLik:%.4f,trainAgreement:%.3f};\n'
        % (len(train), test_hit, naive, ll, train_hit)
    )

    print('wrote dist/weights.js')
    print('  choice sets %d   held-out agreement %.3f (first-window baseline %.3f)'
          % (len(train), test_hit, naive))
    print('  mean log-likelihood %.4f' % ll)
    for n, v, t in zip(NAMES, learned, truth):
        print('    %-16s learned %8.4f   generating %8.4f' % (n, v, t))


if __name__ == '__main__':
    main()
