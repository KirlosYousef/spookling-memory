"""Forked Claude Code transcripts: lines copied from the parent still carry the parent's sessionId."""
import json
from pathlib import Path

from spookling_memory import hooks

PARENT, OTHER, FORK = "aaaa1111", "gggg0000", "ffff2222"


def line(sid, kind, text=None, uuid=0, **extra):
    e = {"type": kind, "sessionId": sid, "uuid": f"u{uuid}"}
    if text is not None:
        e["message"] = {"role": kind, "content": [{"type": "text", "text": text}]}
    return {**e, **extra}


def write(path: Path, rows):
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return path


def conversation(sid, n=2, start=0):
    """n question/answer pairs: 2n turns, plus a tool result line the turn builder skips."""
    rows = []
    for i in range(n):
        rows.append(line(sid, "user", f"{sid} question {i}", uuid=start + 4 * i))
        rows.append(line(sid, "assistant", f"{sid} answer {i}", uuid=start + 4 * i + 1))
    rows.insert(2, {"type": "user", "sessionId": sid, "message": {"role": "user", "content": [{"type": "tool_result", "content": "x"}]}})
    return rows


NOTE = "<system-reminder>\n## The user forked this session from another session\n</system-reminder>\n\n"


def side_chat(tmp_path, copied=None, own_first="assistant"):
    """The parent's lines (id PARENT), then the fork's: a title line, a filler assistant line, the new question, its answer."""
    rows = [line(PARENT, "queue-operation")] + (copied or conversation(PARENT)) + [
        line(PARENT, "custom-title"), line(FORK, "custom-title"), line(FORK, "atis-latch"),
        line(FORK, own_first, "No response requested.", uuid=900),
        line(FORK, "user", NOTE + "A brand new side question", uuid=901),
        line(FORK, "assistant", "The side answer", uuid=902),
    ]
    return write(tmp_path / f"{FORK}.jsonl", rows)


def test_side_chat_is_detected_with_the_branch_point(tmp_path):
    f = hooks.fork_of(side_chat(tmp_path), FORK)
    assert f == {"parent": PARENT, "relation": "side_chat", "branched_at": 3, "copied": 4}
    # 4 copied turns -> the parent's seq 3 is the last one copied; the filler assistant line merged into that last copied turn
    t = hooks.turns(tmp_path / f"{FORK}.jsonl")
    assert [x["role"] for x in t] == ["user", "assistant", "user", "assistant", "user", "assistant"]
    assert t[-2]["content"].endswith("A brand new side question") and t[-1]["content"] == "The side answer"


def test_a_filler_in_the_other_role_is_the_forks_first_own_turn(tmp_path):
    p = side_chat(tmp_path, own_first="user")
    f = hooks.fork_of(p, FORK)
    assert f["copied"] == 4 and f["branched_at"] == 3
    assert hooks.turns(p)[4]["role"] == "user"


def test_a_summary_at_the_top_marks_a_continued_session(tmp_path):
    rows = [{"type": "summary", "summary": "earlier work", "leafUuid": "u9"}] + [line(PARENT, "queue-operation")] + conversation(PARENT) + [
        line(FORK, "custom-title"), line(FORK, "user", "carry on please", uuid=800), line(FORK, "assistant", "ok", uuid=801)]
    f = hooks.fork_of(write(tmp_path / f"{FORK}.jsonl", rows), FORK)
    assert f["relation"] == "continued" and f["parent"] == PARENT and f["branched_at"] == 3
    # the fork note wins: a side chat that happens to sit under a summary is still a side chat
    assert hooks.fork_of(side_chat(tmp_path), FORK)["relation"] == "side_chat"


def test_a_fork_of_a_fork_counts_only_the_direct_parents_turns(tmp_path):
    rows = conversation(OTHER) + conversation(PARENT, n=3, start=100) + [
        line(FORK, "custom-title"), line(FORK, "user", "new", uuid=800), line(FORK, "assistant", "answer", uuid=801)]
    f = hooks.fork_of(write(tmp_path / f"{FORK}.jsonl", rows), FORK)
    assert f["parent"] == PARENT
    assert f["branched_at"] == 5, "the parent has 6 own turns in the copy; the grandparent's 4 are not its seq"
    assert f["copied"] == 10, "but all 10 copied turns are in this fork's log, ahead of its own"


def test_other_transcripts_are_not_forks(tmp_path):
    own = write(tmp_path / f"{FORK}.jsonl", [line(FORK, "queue-operation")] + conversation(FORK))
    assert hooks.fork_of(own, FORK) is None
    assert hooks.fork_of(write(tmp_path / "e.jsonl", []), FORK) is None
    # leading non-conversation lines of another session do not make a fork
    meta = write(tmp_path / "m.jsonl", [line(PARENT, "queue-operation"), line(PARENT, "custom-title")] + conversation(FORK))
    assert hooks.fork_of(meta, FORK) is None
    # a foreign line in the middle is not a copied head
    mid = write(tmp_path / "mid.jsonl", conversation(FORK) + [line(PARENT, "user", "stray", uuid=5)])
    assert hooks.fork_of(mid, FORK) is None


def test_turns_of_a_normal_transcript_are_unchanged(tmp_path):
    p = write(tmp_path / f"{FORK}.jsonl", conversation(FORK, n=2))
    assert hooks.turns(p) == [{"role": "user", "content": f"{FORK} question 0"}, {"role": "assistant", "content": f"{FORK} answer 0"},
                              {"role": "user", "content": f"{FORK} question 1"}, {"role": "assistant", "content": f"{FORK} answer 1"}]


class Recorder:
    def __init__(self, folder):
        self.folder, self.ingested = folder, []

    def ingest(self, sid, conversation, **kw):
        self.ingested.append((sid, len(conversation)))
        return len(conversation)


def test_stop_records_the_fork_beside_the_log_and_ingests_everything_as_before(tmp_path):
    transcript = side_chat(tmp_path)
    folder = tmp_path / ".memory"
    folder.mkdir()
    store = Recorder(folder)
    hooks.handle(store, "stop", {"session_id": FORK, "transcript_path": str(transcript)})
    hooks.handle(store, "stop", {"session_id": FORK, "transcript_path": str(transcript)})
    assert json.loads((folder / "forks.json").read_text()) == {FORK: {"parent": PARENT, "relation": "side_chat", "branched_at": 3, "copied": 4}}
    assert store.ingested == [(FORK, 6), (FORK, 6)], "the log keeps the whole conversation: places and part ids are as before"
    assert not list(folder.glob("*.tmp"))
    normal = write(tmp_path / "n.jsonl", conversation("nnnn"))
    other = tmp_path / "o"
    other.mkdir()
    hooks.handle(Recorder(other), "stop", {"session_id": "nnnn", "transcript_path": str(normal)})
    assert not (other / "forks.json").exists()
