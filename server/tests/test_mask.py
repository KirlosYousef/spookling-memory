"""The secret masker agrees with cli/src/mask.js on every vector in cli/test/fixtures/secret-vectors.json."""
import json
import time
from pathlib import Path

import pytest

from spookling_memory import hooks

VECTORS = json.loads((Path(__file__).resolve().parents[2] / "cli" / "test" / "fixtures" / "secret-vectors.json").read_text("utf-8"))


@pytest.mark.parametrize("v", VECTORS, ids=[v["name"] for v in VECTORS])
def test_vector(v):
    assert hooks.mask_secrets(v["in"]) == v["out"]
    assert hooks.mask_secrets(v["out"]) == v["out"]  # idempotent


ADVERSARIAL = {
    "a. repeated": "a." * 50_000,
    "a: repeated": "a:" * 50_000,
    "at signs": "@" * 100_000,
    "url then at signs": "x://a:" + "@" * 100_000,
    "jwt starts": "eyJ-" * 25_000,
    "curl words": "curl " * 20_000,
    "sk starts": "sk-" * 33_000,
    "token words": "token " * 16_000,
    "token= quotes": 'token="' * 14_000,
    "authorization words": "authorization " * 7_000,
    "unterminated pem starts": "\u002d----BEGIN PRIVATE KEY-----" * 3_700,
    "cookie words": "cookie " * 14_000,
    "key chars": "password." * 11_000,
    "spaces": " " * 100_000,
}


@pytest.mark.parametrize("name", ADVERSARIAL)
def test_fast_on_100k(name):
    text = ADVERSARIAL[name]
    t = time.perf_counter()
    out = hooks.mask_secrets(text)
    assert (time.perf_counter() - t) * 1000 < 1000  # a quadratic blow-up takes seconds; this only has to survive a slow CI runner (the rescans cover 16k characters now)
    assert len(out) <= hooks.MASK_INPUT_MAX + 16


def test_clean_masks_after_the_cap_and_is_fast():
    t = time.perf_counter()
    out = hooks.clean(("eyJ-" * 25_000) + " end")
    assert (time.perf_counter() - t) * 1000 < 1000
    assert len(out) <= hooks.TURN_CAP + 2
    key = "sk-" + "a" * 30
    out = hooks.clean(("word " * 790) + key + " tail words here " * 80)
    assert "sk-" not in out


def test_clean_masks_what_the_old_pattern_missed():
    out = hooks.clean("deploy with the header Authorization: Bearer abcdef123456 and password=hunter2 today")
    assert "abcdef123456" not in out and "hunter2" not in out
