"""CSV output helpers.

Spreadsheet apps execute cells beginning with = + - @ (and tab/CR) as formulas.
Every exported cell passes through safe_cell (plan 18.2, OWASP CSV injection).
"""

import csv
import io
from collections.abc import Iterable, Sequence

_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def safe_cell(value) -> str:
    if value is None:
        return ""
    s = str(value)
    if s.startswith(_FORMULA_PREFIXES):
        return "'" + s
    return s


def to_csv(header: Sequence[str], rows: Iterable[Sequence]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow([safe_cell(h) for h in header])
    for row in rows:
        w.writerow([safe_cell(c) for c in row])
    # BOM so Excel opens UTF-8 (Hindi names) correctly.
    return "\ufeff" + buf.getvalue()
