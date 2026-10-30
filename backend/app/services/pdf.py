"""A small, dependency-free PDF writer for the maintenance report.

Why not a PDF library: none is installed, and every dependency is pinned
exactly. PDF 1.4 with the standard Helvetica fonts is plain text and needs no
font embedding, so a few hundred lines cover headings, tables and vector bar
charts. Values are kept ASCII so the file renders in any viewer.
"""

import io
import zlib

# Standard AFM widths (per 1000 units) for ASCII 32..126, Helvetica regular/bold.
_REGULAR = (278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
            556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
            1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
            667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
            333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
            556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584)
_BOLD = (278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
         556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
         975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
         667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
         333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
         611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584)

MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def text_width(s: str, size: float, bold: bool = False) -> float:
    widths = _BOLD if bold else _REGULAR
    return sum(widths[min(ord(c), 126) - 32] if 32 <= ord(c) <= 126 else 556 for c in s) * size / 1000.0


def _escape(s: str) -> str:
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def wrap(s: str, size: float, max_width: float, bold: bool = False) -> list[str]:
    """Greedy word wrap using real Helvetica widths."""
    lines: list[str] = []
    current = ""
    for word in s.split():
        candidate = f"{current} {word}" if current else word
        if text_width(candidate, size, bold) <= max_width or not current:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def _cell(s: str, size: float, w: float, bold: bool = False) -> str:
    """Trim a table cell to its column."""
    label = s
    while label and text_width(label, size, bold) > w - 4:
        label = label[:-2] if len(label) > 2 else label[1:]
    return label


class ReportPDF:
    """A4 portrait document with pages of text, tables and bar charts."""

    W, H = 595, 842
    MARGIN = 46

    def __init__(self) -> None:
        self.pages: list[list[str]] = []
        self._start()

    def _start(self) -> None:
        self.ops: list[str] = []
        self.y = self.H - self.MARGIN
        self.pages.append(self.ops)

    def _need(self, height: float) -> None:
        if self.y - height < self.MARGIN:
            self._start()

    def text(self, s: str, size: float = 10.5, bold: bool = False, x: float | None = None,
             width: float | None = None, gray: bool = False, gap: float = 1.25) -> None:
        box = width or (self.W - 2 * self.MARGIN)
        color = "0.42 g" if gray else "0 g"
        for line in wrap(s, size, box, bold):
            self._need(size + 4)
            self.y -= size * gap
            self.ops.append(f"BT {color} /{'F2' if bold else 'F1'} {size} Tf "
                            f"{x or self.MARGIN} {self.y:.1f} Td ({_escape(line)}) Tj ET")
        self.y -= 2.5

    def rule(self) -> None:
        self._need(14)
        self.y -= 6
        self.ops.append(f"0.82 G 0.8 w {self.MARGIN} {self.y:.1f} m {self.W - self.MARGIN} {self.y:.1f} l S")
        self.y -= 8

    def spacer(self, h: float) -> None:
        self.y -= h

    def table(self, headers: list[str], rows: list[list[str]], widths: list[float],
              size: float = 9.5) -> None:
        """Text columns with a shaded header row and hairline separators."""
        self._need((size + 7) * 2 + 8)
        self._draw_row(headers, widths, size, bold=True, header=True)
        for row in rows:
            self._need(size + 7)
            self._draw_row(row, widths, size, bold=False, header=False)
        self.spacer(7)

    def _draw_row(self, cells: list[str], widths: list[float], size: float, *, bold: bool, header: bool) -> None:
        self.y -= size + 6
        if header:
            self.ops.append(f"0.93 g {self.MARGIN} {self.y - 3.5:.1f} {self.W - 2 * self.MARGIN} {size + 7:.1f} re f")
        x = self.MARGIN
        for cell, w in zip(cells, widths, strict=True):
            label = _cell(str(cell), size, w, bold)
            self.ops.append(f"BT {'0.25 g' if bold else '0 g'} /{'F2' if bold else 'F1'} {size} Tf "
                            f"{x:.1f} {self.y:.1f} Td ({_escape(label)}) Tj ET")
            x += w
        self.ops.append(f"0.85 G 0.6 w {self.MARGIN} {self.y - 3.5:.1f} m {self.W - self.MARGIN} {self.y - 3.5:.1f} l S")

    def bars(self, labels: list[str], datasets: list[tuple[str, list[float], str]], width: float | None = None) -> None:
        """Grouped shaded rectangle chart with a legend and month axis labels."""
        chart_w = width or (self.W - 2 * self.MARGIN)
        chart_h = 120
        legend_lines = 1 if len(datasets) > 1 else 0
        self._need(chart_h + 40 + legend_lines * 16)
        base = self.y - chart_h - 4
        if legend_lines:
            lx, ly = self.MARGIN, base + chart_h + 12
            for name, _, shade in datasets:
                self.ops.append(f"{shade} rg {lx:.1f} {ly:.1f} 7 7 re f")
                self.ops.append(f"BT 0 g /F1 8.5 Tf {lx + 11:.1f} {ly + 1.5:.1f} Td ({_escape(name)}) Tj ET")
                lx += text_width(name, 8.5) + 34
                if lx > self.W - self.MARGIN - 90:
                    lx, ly = self.MARGIN, ly - 14
        n_series = len(datasets)
        group = chart_w / max(1, len(labels))
        peak = max([1.0] + [max(vals) if vals else 0 for _, vals, _ in datasets])
        self.ops.append(f"0.78 G 0.8 w {self.MARGIN} {base:.1f} m {self.MARGIN + chart_w:.1f} {base:.1f} l S")
        for s_i, (_, vals, shade) in enumerate(datasets):
            bar = min(15.0, group * 0.8 / max(1, n_series))
            offset = (group - bar * n_series) / 2 + s_i * bar
            for g_i, v in enumerate(vals):
                if not v:
                    continue
                h = (v / peak) * (chart_h - 4)
                x = self.MARGIN + g_i * group + offset
                self.ops.append(f"{shade} rg {x:.1f} {base + 1:.1f} {bar - 1.1:.1f} {h:.1f} re f")
        for g_i, label in enumerate(labels):
            cx = self.MARGIN + g_i * group + group / 2 - text_width(label, 7.5) / 2
            self.ops.append(f"BT 0 g /F1 7.5 Tf {cx:.1f} {base - 11:.1f} Td ({_escape(label)}) Tj ET")
        self.y = base - 14
        self.spacer(8)

    def bytes(self) -> bytes:
        out = io.BytesIO()
        n = len(self.pages)
        kids = " ".join(f"{4 + i * 2} 0 R" for i in range(n))
        # Objects: 1 catalog, 2 pages, then page/content pairs, then the two fonts.
        header = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
        objects: list[bytes] = [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            f"<< /Type /Pages /Kids [{kids}] /Count {n} >>".encode(),
        ]
        content_first = len(objects) + 1
        for i in range(n):
            objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {self.W} {self.H}] "
                           f"/Resources << /Font << /F1 {content_first + 2 * n} 0 R "
                           f"/F2 {content_first + 2 * n + 1} 0 R >> >> /Contents {content_first + 2 * i + 1} 0 R >>".encode())
        for ops in self.pages:
            stream = zlib.compress(" ".join(ops).encode("latin-1", "replace"))
            objects.append(b"<< /Length " + str(len(stream)).encode() + b" /Filter /FlateDecode >>\nstream\n" + stream + b"\nendstream")
        objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
        objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")

        out.write(header)
        offsets: list[int] = []
        for i, obj in enumerate(objects, start=1):
            offsets.append(out.tell())
            out.write(f"{i} 0 obj\n".encode())
            out.write(obj)
            out.write(b"\nendobj\n")
        xref_pos = out.tell()
        out.write(f"xref\n0 {len(objects) + 1}\n".encode())
        out.write(b"0000000000 65535 f \n")
        for off in offsets:
            out.write(f"{off:010d} 00000 n \n".encode())
        out.write(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode())
        return out.getvalue()
