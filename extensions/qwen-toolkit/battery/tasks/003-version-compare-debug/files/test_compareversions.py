"""Grading oracle for compareversions.py. Do not modify this file.

Run with: python3 -m unittest -v test_compareversions
"""

import unittest

from compareversions import compare_versions


class CompareVersionsTests(unittest.TestCase):
    def test_equal_versions(self) -> None:
        self.assertEqual(compare_versions("1.2.3", "1.2.3"), 0)

    def test_simple_less_than(self) -> None:
        self.assertEqual(compare_versions("1.2.0", "1.3.0"), -1)

    def test_simple_greater_than(self) -> None:
        self.assertEqual(compare_versions("2.0.0", "1.9.9"), 1)

    def test_missing_trailing_component_is_treated_as_zero(self) -> None:
        # "1.2" has no third component; it is treated as "1.2.0".
        self.assertEqual(compare_versions("1.2", "1.2.0"), 0)

    def test_missing_trailing_component_still_compares_correctly(self) -> None:
        self.assertEqual(compare_versions("1.2", "1.2.1"), -1)
        self.assertEqual(compare_versions("1.2.1", "1.2"), 1)

    def test_numeric_not_lexicographic_ordering(self) -> None:
        # Components compare numerically, not as strings -- "1.10" is
        # version ten, greater than "1.9" (version nine), even though the
        # strings would sort the other way.
        self.assertEqual(compare_versions("1.10", "1.9"), 1)
        self.assertEqual(compare_versions("1.9", "1.10"), -1)

    def test_leading_zeros_do_not_change_numeric_value(self) -> None:
        self.assertEqual(compare_versions("1.02", "1.2"), 0)


if __name__ == "__main__":
    unittest.main()
