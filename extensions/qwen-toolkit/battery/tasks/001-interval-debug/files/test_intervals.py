"""Tests for intervals.py.

Run with: python3 -m unittest -v test_intervals
"""

import unittest

from intervals import merge, subtract


class MergeTests(unittest.TestCase):
    def test_no_overlap_stays_separate(self):
        self.assertEqual(merge([(1, 3), (4, 6)]), [(1, 3), (4, 6)])

    def test_overlapping_intervals_combine(self):
        self.assertEqual(merge([(1, 5), (3, 8)]), [(1, 8)])

    def test_touching_intervals_combine(self):
        # Half-open: (1, 3) covers up to but not including 3; (3, 5) starts
        # exactly there. There is no gap between them, so they represent one
        # contiguous range and must merge into (1, 5).
        self.assertEqual(merge([(1, 3), (3, 5)]), [(1, 5)])

    def test_unsorted_input(self):
        self.assertEqual(merge([(10, 12), (0, 2), (1, 4)]), [(0, 4), (10, 12)])

    def test_empty_input(self):
        self.assertEqual(merge([]), [])

    def test_single_interval(self):
        self.assertEqual(merge([(2, 5)]), [(2, 5)])


class SubtractTests(unittest.TestCase):
    def test_no_overlap(self):
        self.assertEqual(subtract([(0, 5)], [(10, 15)]), [(0, 5)])

    def test_full_cover(self):
        self.assertEqual(subtract([(0, 5)], [(0, 5)]), [])

    def test_middle_bite(self):
        self.assertEqual(subtract([(0, 10)], [(3, 6)]), [(0, 3), (6, 10)])

    def test_b_interval_extends_past_a_start(self):
        # b starts before a and ends inside it: only the tail of a survives.
        self.assertEqual(subtract([(5, 10)], [(2, 8)]), [(8, 10)])

    def test_multiple_a_intervals_one_b_interval_apiece(self):
        self.assertEqual(
            subtract([(0, 5), (10, 15)], [(2, 4), (12, 13)]),
            [(0, 2), (4, 5), (10, 12), (13, 15)],
        )

    def test_b_interval_spans_across_a_intervals(self):
        # A single b-interval overlaps the tail of the first a-interval and
        # the head of the second. The subtract cursor must not permanently
        # retire it after the first a-interval is done.
        self.assertEqual(
            subtract([(0, 5), (10, 15)], [(3, 12)]),
            [(0, 3), (12, 15)],
        )

    def test_empty_a(self):
        self.assertEqual(subtract([], [(0, 5)]), [])

    def test_empty_b(self):
        self.assertEqual(subtract([(0, 5)], []), [(0, 5)])


if __name__ == "__main__":
    unittest.main()
