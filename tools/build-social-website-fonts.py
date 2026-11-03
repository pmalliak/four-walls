"""Prepare deterministic website typography for social images.

Authoring only: requires fontTools. The optional --source-dir supplies previously
downloaded, checksum-verified inputs; otherwise download pinned Google Fonts TTFs.
Run build-social-font-metrics.py afterwards. No runtime font-generation service.
"""
import argparse
import hashlib
import io
from pathlib import Path
import tempfile
import urllib.request

from fontTools import subset
from fontTools.merge import Merger
from fontTools.ttLib import TTFont
from fontTools.ttLib.scaleUpem import scale_upem

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "images/social"
SOURCES = {
    "Montserrat-600": (
        "https://fonts.gstatic.com/s/montserrat/v31/JTUHjIg1_i6t8kCHKm4532VJOt5-QNFgpCu170w-.ttf",
        "c535bb158e8cfc3c27654f73aa68a87732899e7d9b10d8496b68605a56d947a7",
    ),
    "Manrope-400": (
        "https://fonts.gstatic.com/s/manrope/v23/xn7_YHE41ni1AdIRqAuZuw1Bx9mbZk79FO_F.ttf",
        "ed335894f8d954263675f7e457bf657374d8b7be629be4dc43aef97c309ad3ae",
    ),
    "Manrope-600": (
        "https://fonts.gstatic.com/s/manrope/v23/xn7_YHE41ni1AdIRqAuZuw1Bx9mbZk4jE-_F.ttf",
        "68ed4be49ec7d32f07b42f9232dc01ca1df7a77be1d9b0731aac74db58235f34",
    ),
}


def source_bytes(name, directory):
    url, digest = SOURCES[name]
    data = (directory / f"{name}.ttf").read_bytes() if directory else urllib.request.urlopen(url, timeout=30).read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError(f"Unexpected {name} source checksum")
    return data


def build(directory=None):
    data = {name: source_bytes(name, directory) for name in SOURCES}
    primary = TTFont(io.BytesIO(data["Montserrat-600"]), recalcTimestamp=False)
    fallback = TTFont(io.BytesIO(data["Manrope-600"]), recalcTimestamp=False)
    primary_map, fallback_map = primary.getBestCmap(), fallback.getBestCmap()
    expected = {}
    for font in [fallback, primary]:
        for code, glyph in font.getBestCmap().items():
            expected[code] = font["hmtx"][glyph][0] / font["head"].unitsPerEm
    # Montserrat has no ordinary Greek alphabet; preserve all its available
    # glyphs and supply only missing code points from the site's Manrope fallback.
    missing = set(fallback_map) - set(primary_map)
    options = subset.Options()
    options.layout_features = ["*"]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=missing)
    subsetter.subset(fallback)
    # Both sources are static: doubling Montserrat's em keeps every coordinate
    # exact and avoids rounding the Manrope outlines down to a smaller em.
    scale_upem(primary, fallback["head"].unitsPerEm)
    with tempfile.TemporaryDirectory(prefix="fourwalls-social-fonts-") as folder:
        paths = [Path(folder) / "primary.ttf", Path(folder) / "fallback.ttf"]
        for font, path in zip([primary, fallback], paths):
            font.save(path)
        combined = Merger().merge([str(path) for path in paths])
    combined.recalcTimestamp = False
    combined["head"].created = primary["head"].created
    combined["head"].modified = max(primary["head"].modified, fallback["head"].modified)
    names = {
        0: "Copyright 2011 The Montserrat Project Authors; Copyright 2019 The Manrope Project Authors. Combined under SIL OFL 1.1.",
        1: "Four Walls Website",
        2: "SemiBold",
        3: "FourWallsWebsite-SemiBold-1.000",
        4: "Four Walls Website SemiBold",
        5: "Version 1.000; Montserrat 9.000 with Manrope 4.505 fallback",
        6: "FourWallsWebsite-SemiBold",
        13: "Licensed under the SIL Open Font License, Version 1.1. See OFL-Montserrat.txt and OFL-Manrope.txt distributed with this font.",
        14: "https://openfontlicense.org/",
        16: "Four Walls Website",
        17: "SemiBold",
    }
    combined["name"].names = []
    for name_id, value in names.items():
        combined["name"].setName(value, name_id, 3, 1, 0x409)
        combined["name"].setName(value, name_id, 1, 0, 0)
    combined["OS/2"].usWeightClass = 600
    OUTPUT.mkdir(parents=True, exist_ok=True)
    combined.save(OUTPUT / "FourWallsWebsite-SemiBold.ttf")
    (OUTPUT / "Manrope-Regular.ttf").write_bytes(data["Manrope-400"])
    (OUTPUT / "Manrope-SemiBold.ttf").write_bytes(data["Manrope-600"])
    verified = TTFont(OUTPUT / "FourWallsWebsite-SemiBold.ttf")
    cmap, em = verified.getBestCmap(), verified["head"].unitsPerEm
    for code, advance in expected.items():
        if code not in cmap or abs(verified["hmtx"][cmap[code]][0] / em - advance) > 0.00001:
            raise AssertionError(f"Unexpected combined-font width for U+{code:04X}")
    sample = "Ακίνητο Θεσσαλονίκη άέήίόύώ ϊϋΐΰ €530.000 120 τ.μ. FOUR WALLS"
    if any(ord(char) not in cmap for char in sample):
        raise AssertionError("Incomplete Greek, currency or brand glyph coverage")
    print(f"Built website heading fallback: {len(primary_map)} primary and {len(missing)} additional code points; all advances verified.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path)
    build(parser.parse_args().source_dir)
