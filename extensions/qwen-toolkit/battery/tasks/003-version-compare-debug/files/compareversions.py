"""Dot-separated numeric version string comparison."""


def compare_versions(a: str, b: str) -> int:
    a_parts = [int(p) for p in a.split(".")]
    b_parts = [int(p) for p in b.split(".")]
    for x, y in zip(a_parts, b_parts):
        if x != y:
            return -1 if x < y else 1
    return 0
