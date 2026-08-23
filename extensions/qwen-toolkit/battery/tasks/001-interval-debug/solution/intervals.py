"""Interval arithmetic over half-open ranges [start, end)."""


def merge(intervals):
    """Merge overlapping and touching half-open intervals.

    Input: an iterable of (start, end) pairs, not required to be sorted.
    Output: a sorted list of (start, end) pairs, minimal and non-overlapping.
    Touching intervals -- e.g. (1, 3) and (3, 5), which share no gap under
    the half-open convention -- are combined into one.
    """
    if not intervals:
        return []
    ivs = sorted(intervals)
    out = [list(ivs[0])]
    for s, e in ivs[1:]:
        if s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [tuple(iv) for iv in out]


def subtract(a_intervals, b_intervals):
    """Return the parts of a_intervals not covered by b_intervals.

    Both a_intervals and b_intervals must already be sorted, non-overlapping,
    half-open (start, end) pairs -- callers typically pass them through
    merge() first.
    """
    result = []
    bi = 0
    n = len(b_intervals)
    for a_start, a_end in a_intervals:
        cur = a_start
        # b-intervals fully behind the cursor can never overlap anything
        # from here on; retire them so later a-intervals don't re-scan them.
        while bi < n and b_intervals[bi][1] <= cur:
            bi += 1
        k = bi
        while cur < a_end and k < n and b_intervals[k][0] < a_end:
            b_start, b_end = b_intervals[k]
            if b_start > cur:
                result.append((cur, min(b_start, a_end)))
            cur = max(cur, b_end)
            k += 1
        if cur < a_end:
            result.append((cur, a_end))
        # A b-interval that outlasts this a-interval may still overlap the
        # next one, so only retire indices we're certain are exhausted.
        bi = k - 1 if k > bi else bi
    return result
