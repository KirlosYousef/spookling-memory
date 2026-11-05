"""Claude Code hooks, server side: the hook scripts POST their stdin here, so the transcript parsing is Python."""
from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

from .core.recall import ABSTAIN
from .store import jsonl

EVENTS = ("user-prompt-submit", "pre-compact", "stop")
CAP = 10_000  # Claude Code's cap, in UTF-16 units; a longer value reaches Claude only as a file path
OURS = re.compile(r"<(invariant|recalled-data|memory-index|kept-before-compaction)\b.*?</\1>", re.S)
COMMAND = ("<command-", "<local-command-")  # slash-command wrappers and their output
MNT = Path("/mnt")  # WSL's default automount root
TURN_CAP = 4000
PULSE = "x-spookling-pulse"  # a hook call's counts as JSON, for the status line; the body stays what Claude Code reads
LOG = logging.getLogger("uvicorn.error")  # uvicorn's, so it lands in .memory/server.log

# a wrapper is any closed <x-y> or <x_y> block: Claude Code's and our own
WRAPPER = re.compile(r"<([a-z][a-z0-9]*(?:[-_][a-z0-9]+)+)\b[^>]*>.*?</\1\b[^>]*>", re.S)  # </pasted_content id=..>
FENCE = re.compile(r"^[ \t]*(`{3,}|~{3,}).*?(?:^[ \t]*\1[ \t]*$|\Z)", re.S | re.M)  # an unclosed fence runs to the end
MARKER = re.compile(r"^\s*\[Request interrupted by user[^\]]*\]\s*$|\[Image #\d+\] ?", re.M)
NOISE = re.compile(r"""^\s*(?:
      [{\[]\s*(?:["{\[\d-]|$) | [}\]]                       # JSON: a line that opens or closes an object or array
    | "[^"\n]{1,80}"\s*:                                  # JSON: "key": ...
    | \d{4}-\d\d-\d\d[T\s]\d\d:\d\d | \d\d:\d\d:\d\d[.,\s]     # a log line's timestamp
    | \[?(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\b[\]:]   # a log level
    | Traceback\ \(most\ recent | File\ "[^"]+",\ line\ \d+ | at\ \S+\ \(\S+:\d+(?::\d+)?\)   # stack frames
    | \$\ \S | \S+@\S+:\S*\$ | >>>\ | \+\+\+\ | ---\ [ab/] | @@\ -\d   # a shell prompt, a REPL, a diff
    | .*[│┃┆].*[│┃┆]                                    # a terminal table row
    )""", re.X)
MASK = "[secret]"
MASK_INPUT_MAX = TURN_CAP + 256  # only this much of a turn is masked: some patterns rescan a run from each start
_NAME = r"(?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)"
I = re.I
# The same list, in the same order, as cli/src/mask.js (both are tested against cli/test/fixtures/secret-vectors.json).
PATTERNS = [
    (re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|(?![\s\S]))"), MASK),
    (re.compile(r"\bauthorization\s*[:=]\s*(?:bearer|basic|token)\s+\S+", I), MASK),
    (re.compile(r"\b(?:set-)?cookie\s*:\s*[^\r\n]+", I), MASK),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*"), MASK),
    (re.compile(r"\b([a-z][a-z0-9+.-]{0,20}://)[^\s:/@]+:[^\s/]+@", I), r"\1" + MASK + "@"),
    (re.compile(r"([?&](?:token|access_token|api[_-]?key|key|password|secret|sig|signature)=)[^&\s#]+", I), r"\1" + MASK),
    (re.compile(r"(\bcurl\b[^\n]*?\s-u\s+)\S+:\S+", I), r"\1" + MASK),
    (re.compile(r"\b(?:sk-[A-Za-z0-9_-]{20,}|A[KS]IA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{30,})\b"), MASK),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"), MASK),
    (re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}"), MASK),
    (re.compile(r"\bnpm_[A-Za-z0-9]{30,}"), MASK),
    (re.compile(r"\bhf_[A-Za-z0-9]{30,}"), MASK),
    (re.compile(r"\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}"), MASK),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"), MASK),
    (re.compile(r"\bxox[abeoprs]-[A-Za-z0-9-]{8,}"), MASK),
    (re.compile(r"\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}"), MASK),
    (re.compile(r"\bwhsec_[A-Za-z0-9]{16,}"), MASK),
    (re.compile(r"\bspk_[A-Za-z0-9_-]{20,}"), MASK),
    (re.compile(r"\b[\w.-]{0,40}" + _NAME + r"""[\w.-]{0,40}["']?\s*[=:]\s*(?!\[secret\])(?:"[^"]*"|'[^']*'|\S+)""", I), MASK),
]


def mask_secrets(text: str) -> str:
    """Mask secrets in the first MASK_INPUT_MAX characters (callers cut a turn to TURN_CAP anyway); the rest is dropped."""
    text = text[:MASK_INPUT_MAX]
    for rx, to in PATTERNS:
        text = rx.sub(to, text)
    return text


def cap(text: str, n: int = CAP) -> str:
    """At most n UTF-16 units (an emoji counts two, as in JavaScript), never half a character."""
    return text.encode("utf-16-le")[: 2 * n].decode("utf-16-le", "ignore")


def local_path(p: str) -> Path:
    """A Windows path reads as /mnt/<drive>/... in WSL. ponytail: the default root; read /etc/wsl.conf if moved."""
    m = re.match(r"([A-Za-z]):[\\/](.*)", p)
    if m and os.name != "nt" and (MNT / m[1].lower()).is_dir():
        return MNT.joinpath(m[1].lower(), *[x for x in re.split(r"[\\/]", m[2]) if x])
    return Path(p)


def clean(text: str) -> str:
    """The prose of one message: no wrappers, fences or noise lines; secrets masked; at most TURN_CAP characters."""
    text = MARKER.sub("", FENCE.sub("", WRAPPER.sub("", OURS.sub("", text))))
    keep = [x for x in text.split("\n") if not NOISE.match(x)
            and not (len(x.strip()) >= 20 and sum(c.isalpha() or c.isspace() for c in x) < 0.6 * len(x))]
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(keep)).strip()
    longer = len(text) > TURN_CAP
    text = mask_secrets(text).strip()  # mask the capped text only: no pattern ever sees an unbounded turn
    if len(text) > TURN_CAP:
        text = text[:text.rfind(" ", 0, TURN_CAP) if " " in text[:TURN_CAP] else TURN_CAP].rstrip() + " …"
    elif longer:
        text += " …"
    return text


def _entries(path: str | Path) -> list[dict]:
    out = []
    for line in jsonl(Path(path).read_text(encoding="utf-8", errors="replace")):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        out.append(e if isinstance(e, dict) else {})
    return out


def _build(entries: list[dict]) -> list[tuple[dict, int, int]]:
    """The turns of these transcript lines, each with the index of its first and last line."""
    out: list[tuple[dict, int, int]] = []
    tool = False  # a tool call since the assistant's last text: its next text replaces the narration
    for i, e in enumerate(entries):
        if e.get("type") not in ("user", "assistant") or e.get("isMeta") or e.get("isSidechain") or e.get("isCompactSummary"):
            continue
        c = (e.get("message") or {}).get("content")
        blocks = [b for b in c if isinstance(b, dict)] if isinstance(c, list) else []
        called = any(b.get("type") in ("tool_use", "tool_result") for b in blocks)
        text = c if isinstance(c, str) else "\n".join(b.get("text", "") for b in blocks if b.get("type") == "text")
        text = OURS.sub("", text).strip()
        if not text or text.startswith(COMMAND):  # what earlier versions skipped, so the places line up
            tool = tool or called
            continue
        text = clean(text)
        if out and out[-1][0]["role"] == e["type"]:
            turn, first, _ = out[-1]
            if e["type"] == "assistant" and tool and text:
                turn["content"] = text
            elif text:
                turn["content"] = (turn["content"] + "\n\n" + text).strip()
            out[-1] = (turn, first, i)
        else:
            out.append(({"role": e["type"], "content": text}, i, i))
        tool = called
    return out


def turns(path: str | Path) -> list[dict]:
    """One entry per turn; a part that cleans to nothing stays as an empty entry, since Store.ingest counts places."""
    return [t for t, _, _ in _build(_entries(path))]


FORK_NOTE = re.compile(r"The user forked this session", re.I)


def fork_of(path: str | Path, sid: str) -> dict | None:
    """A forked transcript starts with lines copied from its parent, which still carry the PARENT's sessionId; the fork's own
    lines carry sid. Returns None for any other transcript, else:
      parent       the sessionId of the last copied line (the direct parent; a fork of a fork copies a fork's lines too)
      relation     "continued" when Claude Code left a summary / compact-summary marker at the top, else "side_chat"
      branched_at  the parent's own turn the fork branched after: the parent's turns found in the copy, minus 1. The parent
                   uploads only its own turns, numbered from 0, so this is that seq
      copied       how many of this transcript's logged turns come from the copy (a turn that continues copied text counts)
    ponytail: the continued marker (type "summary" + leafUuid, or isCompactSummary) is from Claude Code's format, not seen in a
    real file here; the side chat marker (the "forked this session" note) is."""
    entries = _entries(path)
    boundary = next((i for i, e in enumerate(entries) if e.get("sessionId") == sid), None)
    if not boundary:  # no own line, or the file starts with them: not a fork
        return None
    head = entries[:boundary]
    copied = [e["sessionId"] for e in head
              if e.get("type") in ("user", "assistant") and isinstance(e.get("sessionId"), str) and e["sessionId"] != sid]
    if not copied:
        return None
    parent = copied[-1]
    segment = [e if e.get("sessionId") == parent else {} for e in head]  # keep the indexes; drop the other sessions' lines
    parent_turns = [t for t, _, _ in _build(segment) if t["content"].strip()]
    built = _build(entries)
    text = json.dumps([e.get("message") for e in entries[boundary:boundary + 40] if e.get("type") == "user"], ensure_ascii=False)
    marker = any(e.get("type") == "summary" and e.get("leafUuid") for e in entries[:boundary + 40]) \
        or any(e.get("isCompactSummary") for e in entries[:boundary + 40])
    return {
        "parent": parent,
        "relation": "continued" if marker and not FORK_NOTE.search(text) else "side_chat",
        "branched_at": max(len(parent_turns) - 1, 0),
        "copied": sum(1 for t, first, _ in built if first < boundary and t["content"].strip()),
    }


def save_fork(folder: Path, sid: str, fork: dict) -> None:
    """forks.json beside log.jsonl, for the uploader. log.jsonl itself is never touched. Written only when it changed."""
    path = Path(folder) / "forks.json"
    try:
        have = json.loads(path.read_text(encoding="utf-8"))
        have = have if isinstance(have, dict) else {}
    except (OSError, ValueError):
        have = {}
    if have.get(sid) == fork:
        return
    have[sid] = fork
    tmp = path.with_name(f"forks.json.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(have, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def payload(body: bytes) -> dict:
    """{} for an empty body; ValueError (a 400) for a body that is not one JSON object."""
    text = body.decode("utf-8", "replace").strip()
    if not text:
        return {}
    try:
        p = json.loads(text, strict=False)
    except ValueError as e:
        raise ValueError(f"the body is not JSON: {getattr(e, 'msg', e)} at character {getattr(e, 'pos', '?')} of "
                         f"{len(text)}") from None
    if not isinstance(p, dict):
        raise ValueError(f"the body is a JSON {type(p).__name__}, not an object")
    return p


def codex_turns(path: Path) -> list[dict]:
    """Codex rollout response_item messages only; never developer context, tool output, reasoning or commentary.
    The rollout format is internal (observed with codex-cli 0.164.0); event_msg duplicates are deliberately skipped.
    Use the same cleaning and whole-transcript tail deduplication as Claude Code.
    """
    out: list[dict] = []
    for line in jsonl(path.read_text(encoding="utf-8", errors="replace")):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if not isinstance(e, dict) or e.get("type") != "response_item":
            continue
        p = e.get("payload")
        if not isinstance(p, dict) or p.get("type") != "message" or p.get("role") not in ("user", "assistant"):
            continue
        role = p["role"]
        if role == "assistant" and p.get("phase") not in (None, "final_answer"):
            continue
        content = p.get("content") or []
        text = content if isinstance(content, str) else "\n".join(
            b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") in ("input_text", "output_text"))
        # Codex writes its bootstrap instructions and environment as user messages, too.
        if text.lstrip().startswith(("# AGENTS.md instructions", "<environment_context>", "<permissions instructions>")):
            continue
        text = clean(text)
        if out and out[-1]["role"] == role:
            if text:
                out[-1]["content"] = (out[-1]["content"] + "\n\n" + text).strip()
        else:
            out.append({"role": role, "content": text})
    return out


def counts(ctx: str) -> dict:
    """What a recall block holds: fact records, standing rules, timeline events, dated past chats, and its size."""
    rules = re.search(r"<rules>\n(.*?)</rules>", ctx, re.S)
    data = "".join(re.findall(r"<recalled-data\b[^>]*>\n(.*?)</recalled-data>", ctx, re.S))
    return {"facts": len(re.findall(r"^.*\(true from ", data, re.M)),
            "rules": len(re.findall(r"^- ", rules[1], re.M)) if rules else 0,
            "events": len(re.findall(r"^E\d+ ", data, re.M)),
            "chats": len(re.findall(r"^\[\d{1,2} [A-Z][a-z]{2} \d{4}\]", data, re.M)),
            "chars": len(ctx), "cap": CAP}


def handle(store, event: str, p: dict) -> tuple[dict, dict]:
    """What the hook prints, and its pulse. Stop and PreCompact log new turns; PreCompact then keeps the session's rules."""
    agent = "codex" if p.get("harness") == "codex" else "claude-code"
    sid = str(p.get("session_id") or agent)
    if event == "user-prompt-submit":
        prompt = p.get("prompt") or ""
        ctx = store.retrieve(prompt)["context"] if prompt.strip() else ""
        if not ctx or ctx == ABSTAIN:
            return {}, {}
        ctx = cap(ctx)
        return {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": ctx}}, counts(ctx)
    path = local_path(str(p.get("transcript_path") or ""))
    if path.suffix == ".jsonl" and path.is_file():
        conversation = codex_turns(path) if agent == "codex" else turns(path)
        if agent != "codex":
            try:
                fork = fork_of(path, sid)
                if fork:
                    save_fork(store.folder, sid, fork)
            except Exception as e:  # a fork note is never worth a failed hook
                LOG.warning("fork detection failed for %s: %r", sid, e)
        last = clean(str(p.get("last_assistant_message") or ""))
        if conversation and last and event == "stop":  # the file can lag the final reply at Stop
            if conversation[-1]["role"] != "assistant":
                conversation.append({"role": "assistant", "content": last})
            else:
                conversation[-1]["content"] = last
        if conversation:  # Stop is after the reply: it may wait for a rebuild
            store.ingest(sid, conversation, agent=agent, tail=True, patient=event == "stop")
    if event == "pre-compact":
        c = store.compact(sid)
        return {}, {"kept": c["kept"], "rules": counts(c["block"])["rules"], "lines": len(re.findall(r"^- ", c["block"], re.M))}
    return {}, {}
