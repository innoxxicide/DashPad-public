#!/usr/bin/env python3
"""DashPad progress publisher.

Pushes the «Ход работ» chains and page template to the DashPad Worker, so the tablet can show them
without a claude.ai login. Also pushes the newest standup brief (/api/brief).

Config: %USERPROFILE%\\.dashpad\\publisher.json (outside the repo; --config picks another file, whose folder
then holds the log and the replay state; --url/--key override it for local testing):
  {"url": "https://…workers.dev", "writeKey": "…", "transcripts": "…", "template": "…"}
  transcripts  optional: replay the Claude Code transcripts under this folder (e.g. %USERPROFILE%\\.claude\\projects)
               into <config folder>\\progress\\chains.js; without it chains.js and the template come from
               an external replayer's folder, %USERPROFILE%\\claude-sessions-sync\\progress
  template     optional: path to the «Ход работ» page template (overrides that folder's template)

Commands:
  run        watch loop (what the scheduled task starts; a second copy exits at once)
  once       push the current state once and exit
  status     print what would be sent
  install    create the scheduled task "DashPad progress publisher" (every 5 min, single instance)
  uninstall  delete the scheduled task
Standard library only.
"""
import argparse
import glob
import hashlib
import http.client
import json
import logging
import logging.handlers
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime

HOME = os.path.expanduser("~")
PROGRESS_DIR = os.path.join(HOME, "claude-sessions-sync", "progress")
CHAINS = os.path.join(PROGRESS_DIR, "chains.js")
TEMPLATE = os.path.join(PROGRESS_DIR, "progress_template.html")
CONFIG = os.path.join(HOME, ".dashpad", "publisher.json")
TASK = "DashPad progress publisher"
LOCK_PORT = 47614          # single-instance guard (bind on loopback)
POLL_S = 2                 # how often to look at file mtimes
MIN_PUSH_S = 10            # at most one data push per 10 s
HEARTBEAT_S = 300          # heartbeat-only push when nothing changed
TIMEOUT_S = 20
MIRROR_HORIZON_DAYS = 35   # the first replay skips transcripts older than this
MIRROR_STALE_S = 300       # mirror failing this long -> no heartbeat, so the Worker's 15-min "PC silent" note shows
PENDING_TTL_S = 7 * 86400  # a tool_use still without a result a week of records later was a killed call
OFFSETS_SAVE_S = 60        # a poll that only moved read offsets saves the state at most this often
FUTURE_SLACK_S = 86400     # a record dated further ahead of the clock never becomes `newest`
# Written by the standup-brief skill (another repo) into its session scratchpad; the sibling json proves the source.
BRIEF_GLOB = os.path.join(tempfile.gettempdir(), "claude", "*", "*", "scratchpad", "standup_brief.html")
BRIEF_SCAN_S = 60

log = logging.getLogger("publisher")


def setup_logging(quiet, state_dir):
    os.makedirs(state_dir, exist_ok=True)
    path = os.path.join(state_dir, "publisher.log")
    handler = logging.handlers.RotatingFileHandler(path, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(handler)
    if not quiet:
        log.addHandler(logging.StreamHandler(sys.stdout))
    log.setLevel(logging.INFO)


def read_config(path):
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8-sig") as f:
            cfg = json.load(f)
    except ValueError as e:
        sys.exit(f"{path}: неверный JSON: {e}")
    if not isinstance(cfg, dict):
        sys.exit(f"{path}: ожидался JSON-объект")
    return cfg


def load_config(args):
    url = (args.url or args.cfg.get("url") or "").rstrip("/")
    key = args.key or args.cfg.get("writeKey") or ""
    if not url or not key:
        sys.exit(f"нет url/writeKey: заполните {args.config} или передайте --url/--key")
    return url, key


def config_path(cfg, name):
    """A path field of publisher.json with ~ and %VARS% expanded; None when absent or empty."""
    value = cfg.get(name)
    if not isinstance(value, str) or not value.strip():
        return None
    return os.path.abspath(os.path.expandvars(os.path.expanduser(value.strip())))


def sources(cfg, state_dir):
    """(chains_path, template_path, mirror_spec); the spec (Mirror arguments) is None unless `transcripts` is set."""
    template = config_path(cfg, "template") or TEMPLATE
    transcripts = config_path(cfg, "transcripts")
    if transcripts is None:
        return CHAINS, template, None
    out_dir = os.path.join(state_dir, "progress")
    spec = (transcripts, out_dir, os.path.join(out_dir, "progress_state.json"))
    return os.path.join(out_dir, "chains.js"), template, spec


def record_time(rec):
    """A transcript record's ISO timestamp as epoch seconds; 0.0 when absent or malformed."""
    try:
        return datetime.fromisoformat(rec["timestamp"].replace("Z", "+00:00")).timestamp()
    except (KeyError, AttributeError, TypeError, ValueError):
        return 0.0


def walk_jsonl(root):
    """(path, stat) of every *.jsonl under root, the set glob "**/*.jsonl" found; DirEntry.stat() reuses the listing."""
    try:
        entries = list(os.scandir(root))
    except OSError:
        return
    for e in entries:
        if e.name.startswith("."):
            continue
        try:
            if e.is_dir(follow_symlinks=False):
                yield from walk_jsonl(e.path)
            elif e.name.lower().endswith(".jsonl") and e.is_file():
                yield e.path, e.stat()
        except OSError:
            continue


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


class Mirror:
    """Replays the ArtifactData writes to the `chains` collection found in Claude Code transcripts.
    A write applies only after its own tool_result arrives without is_error; render() writes chains.js."""
    KEEP = ("action", "doc_id", "data", "file_path", "field", "old_str", "new_str", "replace_all")

    def __init__(self, projects_dir, out_dir=None, state_path=None, horizon_days=MIRROR_HORIZON_DAYS):
        self.projects_dir, self.out_dir, self.state_path = projects_dir, out_dir, state_path
        self.chains_path = os.path.join(out_dir, "chains.js") if out_dir else None
        self.horizon_days = horizon_days
        st = read_json(state_path) if state_path else None
        st = st if isinstance(st, dict) else {}
        self.offsets, self.docs, self.pending, stamps = (
            st[k] if isinstance(st.get(k), dict) else {} for k in ("offsets", "docs", "pending", "stamps"))
        # pending: id -> [record time, writes]; stamps: doc_id -> [record time of its newest applied write,
        # write ids applied at that time], kept after a delete as a tombstone
        self.pending = {k: v for k, v in self.pending.items()
                        if isinstance(v, list) and len(v) == 2 and isinstance(v[1], list)}
        self.stamps = {d: [float(s), []] if isinstance(s, (int, float)) else s for d, s in stamps.items()
                       if isinstance(s, (int, float))
                       or (isinstance(s, list) and len(s) == 2 and isinstance(s[1], list))}
        self.newest = float(st["newest"]) if isinstance(st.get("newest"), (int, float)) else 0.0
        self.first = not self.offsets
        self.dirty = self.unsaved = self.urgent = self.root_missing = False
        self.skipped = self.bad = self.future = 0
        self.failing, self.saved_at = set(), time.time()

    def _save_state(self):
        os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
        tmp = self.state_path + ".tmp"
        state = {"offsets": self.offsets, "docs": self.docs, "pending": self.pending, "stamps": self.stamps,
                 "newest": self.newest}
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
        os.replace(tmp, self.state_path)

    @staticmethod
    def _writes(inp):
        if inp.get("action") == "batch":
            ops = [dict(w, action=w.get("op")) for w in inp.get("writes") or [] if isinstance(w, dict)]
        else:
            ops = [inp]
        return [{k: o.get(k) for k in Mirror.KEEP} for o in ops
                if o.get("collection") == "chains" and isinstance(o.get("doc_id"), str) and o.get("doc_id")
                and o.get("action") in ("set", "update", "delete", "str_replace")]

    def _apply(self, w, ts=0.0):
        """Apply one write; False when it was skipped, so it must not stamp the doc."""
        if w["action"] == "delete":
            self.docs.pop(w["doc_id"], None)
            return True
        if w["action"] != "str_replace":
            return self._merge(w, ts)
        doc, field, old, new = self.docs.get(w["doc_id"]), w["field"], w["old_str"], w["new_str"] or ""
        if doc is None:
            return False
        if isinstance(doc.get(field), str) and isinstance(old, str) and old and isinstance(new, str):
            doc[field] = doc[field].replace(old, new, -1 if w["replace_all"] else 1)
        return True

    def _merge(self, w, ts=0.0):
        """Skips (False) an update for an unseen doc, whose set is outside the replay (a partial doc would show
        as an untitled open chain), and a file_path write whose file changed after it (not what was written)."""
        if w["action"] == "update" and w["doc_id"] not in self.docs:
            return False
        data = w["data"]
        if data is None and isinstance(w["file_path"], str) and w["file_path"]:
            changed_at = mtime(w["file_path"])
            if ts and changed_at is not None and changed_at / 1e9 > ts:
                self.skipped += 1
                return False
            data = read_json(w["file_path"])
            if data is None:
                return False
        if not isinstance(data or {}, dict):
            return False
        doc = {} if w["action"] == "set" else dict(self.docs.get(w["doc_id"], {}))
        for k, v in (data or {}).items():
            if isinstance(v, dict) and v.get("__delete__") is True:
                doc.pop(k, None)
            else:
                doc[k] = v
        self.docs[w["doc_id"]] = doc
        return True

    def _item(self, item, ts, ready, order):
        """Queue the writes of a successful tool_result into `ready` as (sort time, its record time, id, writes)."""
        if not isinstance(item, dict):
            return
        if item.get("type") == "tool_use" and item.get("name") == "ArtifactData" and isinstance(item.get("id"), str):
            inp = item.get("input")
            writes = self._writes(inp) if isinstance(inp, dict) else []
            if writes:
                self.pending[item["id"]] = [ts, writes]
                self.urgent = True
        elif item.get("type") == "tool_result" and isinstance(item.get("tool_use_id"), str):
            entry = self.pending.pop(item["tool_use_id"], None)
            self.urgent = self.urgent or entry is not None
            if entry and not item.get("is_error"):
                ready.append((order, ts, item["tool_use_id"], entry[1]))

    def _scan(self, chunk, ready):
        last = self.newest
        for raw in chunk.split(b"\n"):
            if b'"ArtifactData"' not in raw and not any(t.encode() in raw for t in self.pending):
                continue
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            # Replica lines only: service lines ("api-request-blob") repeat finished calls and would stay pending.
            msg = rec.get("message") if isinstance(rec, dict) and rec.get("type") in ("assistant", "user") else None
            content = msg.get("content") if isinstance(msg, dict) else None
            ts = record_time(rec)
            if ts > time.time() + FUTURE_SLACK_S:
                self.future += 1
            else:
                self.newest, last = max(self.newest, ts), ts
            try:
                for item in content if isinstance(content, list) else []:
                    self._item(item, ts, ready, min(ts, last))
            except (TypeError, KeyError, ValueError, AttributeError):
                self.bad += 1

    def _read_new(self, path, st, horizon):
        """Advance the file's offset; the new complete lines, b"" when skipped, None when nothing moved."""
        off = self.offsets.get(path, 0)
        if st.st_size < off:
            off = 0
        if st.st_size == off:
            return None
        if self.first and horizon is not None and st.st_mtime < horizon:
            self.offsets[path] = st.st_size
            return b""
        try:
            with open(path, "rb") as f:
                f.seek(off)
                data = f.read()
        except OSError as e:
            if path not in self.failing:
                self.failing.add(path)
                log.warning("transcript unreadable (the heartbeat stops if it stays so): %s", e)
            return None
        if path in self.failing:
            self.failing.discard(path)
            log.info("transcript readable again: %s", path)
        cut = data.rfind(b"\n") + 1
        self.offsets[path] = off + cut
        self.unsaved = True
        return data[:cut] if cut else None

    def _floor(self):
        """Oldest record time a write may have: newest record seen minus the horizon (None = no floor)."""
        return None if self.horizon_days is None or not self.newest else self.newest - self.horizon_days * 86400

    def _is_new(self, doc_id, ts, wid):
        """False for a write the doc's stamp covers: an older one, or the same write id at the same time (a fork copy,
        a re-read after truncation). In steady state a write below the floor may hit a pruned tombstone. A stamp
        ahead of the clock (it ran ahead) is matched by write ids only, so it never holds back a later real write."""
        if not ts:
            return True
        floor = self._floor()
        if not self.first and floor is not None and ts < floor:
            return False
        stamp_ts, ids = self.stamps.get(doc_id, (0.0, []))
        if stamp_ts > time.time():
            return wid not in ids
        return ts > stamp_ts or (ts == stamp_ts and wid not in ids)

    def _apply_ready(self, ready):
        """Apply in record-time order (sessions live in separate files, so glob order is not time order)."""
        changed = False
        for _, ts, tid, writes in sorted(ready, key=lambda r: r[0]):
            for i, w in enumerate(writes):
                wid, doc_id = f"{tid}:{i}", w["doc_id"]
                try:
                    if not self._is_new(doc_id, ts, wid) or not self._apply(w, ts):
                        continue
                except (TypeError, KeyError, ValueError, AttributeError):
                    self.bad += 1
                    self.dirty = self.unsaved = self.urgent = True
                    continue
                if ts:
                    stamp_ts, ids = self.stamps.get(doc_id, (0.0, []))
                    keep = ts == stamp_ts or stamp_ts > time.time()
                    self.stamps[doc_id] = [max(ts, stamp_ts), ids + [wid]] if keep else [ts, [wid]]
                changed = self.dirty = self.unsaved = self.urgent = True
        return changed

    def _prune(self):
        """Keep the state bounded: old tombstones, killed tool calls; report this poll's skips once."""
        floor, sizes = self._floor(), (len(self.stamps), len(self.pending))
        if floor is not None:
            self.stamps = {d: s for d, s in self.stamps.items() if d in self.docs or s[0] >= floor}
        if self.newest:
            self.pending = {k: v for k, v in self.pending.items() if v[0] >= self.newest - PENDING_TTL_S}
        self.urgent = self.urgent or sizes != (len(self.stamps), len(self.pending))
        if self.skipped:
            log.warning("%d file_path writes skipped: the file changed after the write", self.skipped)
        if self.bad or self.future:
            log.warning("transcript records: %d malformed skipped, %d dated over a day ahead", self.bad, self.future)
        self.skipped = self.bad = self.future = 0

    def poll(self):
        """Read the new transcript lines and apply them; chains.js and the state file catch up after a failure."""
        moved, ready, seen = False, [], set()
        horizon = None if self.horizon_days is None else time.time() - self.horizon_days * 86400
        if self.newest > time.time() + FUTURE_SLACK_S:
            self.newest, self.future = time.time() + FUTURE_SLACK_S, self.future + 1
        for path, st in walk_jsonl(self.projects_dir):
            seen.add(path)
            chunk = self._read_new(path, st, horizon)
            if chunk is None:
                continue
            moved = True
            if chunk and (b'"ArtifactData"' in chunk or self.pending):
                self._scan(chunk, ready)
        changed = self._apply_ready(ready)
        if os.path.isdir(self.projects_dir):
            self.failing &= seen
            if not seen.issuperset(self.offsets):
                self.offsets, moved = {p: o for p, o in self.offsets.items() if p in seen}, True
        self._prune()
        self.first = self.first and not seen
        self.unsaved = self.unsaved or moved
        if self.chains_path and (self.dirty or not os.path.exists(self.chains_path)):
            self.render()
            self.dirty = False
        if self.unsaved and (self.urgent or time.time() - self.saved_at >= OFFSETS_SAVE_S):
            self.flush()
        return changed

    def flush(self):
        """Save the state now if anything is unsaved; offsets-only moves otherwise wait up to OFFSETS_SAVE_S."""
        if self.unsaved and self.state_path:
            try:
                self._save_state()
            except OSError as e:
                log.warning("mirror state not saved (retried on the next poll): %s", e)
                return
        self.unsaved = self.urgent = False
        self.saved_at = time.time()

    def render(self):
        os.makedirs(self.out_dir, exist_ok=True)
        js = (f"window.__chains = {json.dumps(self.docs, ensure_ascii=False)};\n"
              f"window.__chainsStamp = {int(time.time() * 1000)};\n")
        tmp = self.chains_path + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            f.write(js)
        os.replace(tmp, self.chains_path)


def poll_mirror(mirror):
    """True when every transcript under an existing root was read and chains.js matches docs (True without a mirror)."""
    if mirror is None:
        return True
    try:
        mirror.poll()
    except (OSError, ValueError, TypeError, AttributeError) as e:
        log.warning("transcript replay failed: %s", e)
        return False
    missing = not os.path.isdir(mirror.projects_dir)
    if missing and not mirror.root_missing:
        log.warning("transcripts folder not found: %s (the heartbeat stops)", mirror.projects_dir)
    mirror.root_missing = missing
    return not (missing or mirror.dirty or mirror.failing)


def mirror_live(mirror, ok_at, was_live):
    """False once the mirror has not polled and rendered cleanly for MIRROR_STALE_S; each switch is logged once."""
    live = mirror is None or time.time() - ok_at <= MIRROR_STALE_S
    if live and not was_live:
        log.info("transcript mirror recovered: pushes resume")
    elif was_live and not live:
        log.warning("transcript mirror not read cleanly within %d s: heartbeat stopped, the wall will show the PC "
                    "as silent", MIRROR_STALE_S)
    return live


def missing_chains_message(args):
    return (f"нет файла {args.chains}: укажите \"transcripts\" в {args.config} "
            "или запустите внешний источник «Ход работ»")


def warn_missing_chains(args):
    if not os.path.isfile(args.chains):
        log.warning(missing_chains_message(args))


def read_chains(path):
    """Parse chains.js (Mirror.render() or a replayer): `window.__chains = {...};\nwindow.__chainsStamp = N;`"""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    head, sep, tail = text.partition("\nwindow.__chainsStamp = ")
    if not sep or not head.startswith("window.__chains = "):
        raise ValueError("unexpected chains.js format")
    docs = json.loads(head[len("window.__chains = "):].rstrip().rstrip(";"))
    stamp = int(tail.strip().rstrip(";") or 0)
    return docs, stamp


def read_template(path):
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as f:
        return f.read()


def count_open(docs):
    return sum(1 for d in docs.values() if (d.get("pct") or 0) < 100)


def mtime(path):
    try:
        return os.stat(path).st_mtime_ns
    except OSError:
        return None


def has_brief_json(path):
    return os.path.isfile(os.path.join(os.path.dirname(path), "standup_brief.json"))


def find_brief():
    """Newest (path, mtime_ns, size) among the briefs that have their sibling json, or None."""
    best = None
    for path in glob.glob(BRIEF_GLOB):
        if not has_brief_json(path):
            continue
        try:
            st = os.stat(path)
        except OSError:
            continue
        if best is None or st.st_mtime_ns > best[1]:
            best = (path, st.st_mtime_ns, st.st_size)
    return best


def post(url, key, path, body):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url + path,
        data=data,
        method="POST",
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json; charset=utf-8",
                 "User-Agent": "DashPadPublisher/0.1"},
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        return r.status, r.read().decode("utf-8", "replace")


class Publisher:
    def __init__(self, url, key, chains_path, template_path):
        self.url, self.key = url, key
        self.chains_path, self.template_path = chains_path, template_path
        self.sent_chains_mtime = None
        self.sent_template_hash = None
        self.last_push = 0.0
        self.failures = 0
        self.sent_brief_hash = None
        self.brief_seen = None
        self.next_brief_scan = 0.0
        self.brief_failures = 0

    def build(self, force=False):
        """Return the body to send now (None if nothing is due)."""
        body = {"heartbeat": int(time.time() * 1000)}
        cm = mtime(self.chains_path)
        if cm is not None and (force or cm != self.sent_chains_mtime):
            docs, stamp = read_chains(self.chains_path)
            body.update(docs=docs, stamp=stamp)
            body["_mtime"] = cm
        tpl = read_template(self.template_path)
        if tpl is not None:
            h = hashlib.sha256(tpl.encode("utf-8")).hexdigest()
            if force or h != self.sent_template_hash:
                body.update(template=tpl)
                body["_tpl_hash"] = h
        return body

    def push(self, body):
        meta = {k: body.pop(k) for k in ("_mtime", "_tpl_hash") if k in body}
        status, text = post(self.url, self.key, "/api/progress", body)
        if status != 200:
            raise RuntimeError(f"HTTP {status}: {text[:200]}")
        if "_mtime" in meta:
            self.sent_chains_mtime = meta["_mtime"]
        if "_tpl_hash" in meta:
            self.sent_template_hash = meta["_tpl_hash"]
        self.last_push = time.time()
        what = ", ".join(k for k in ("docs", "template") if k in body) or "heartbeat"
        n = len(body.get("docs") or {})
        log.info("sent %s%s", what, f" ({n} chains)" if "docs" in body else "")

    def step(self, force=False):
        now = time.time()
        if not force and now - self.last_push < MIN_PUSH_S:
            return
        body = self.build(force)
        has_data = "docs" in body or "template" in body
        if not has_data and now - self.last_push < HEARTBEAT_S:
            return
        try:
            self.push(body)
            self.failures = 0
        except (urllib.error.URLError, OSError, RuntimeError, ValueError) as e:
            self.failures += 1
            # back off up to 5 min; mtimes stay "unsent", so the data goes out on the next success
            self.last_push = now - MIN_PUSH_S + min(300, 10 * 2 ** min(self.failures, 5))
            log.warning("push failed (%d): %s", self.failures, e)

    def push_brief(self, cand):
        path, mtime_ns, size = cand
        with open(path, "rb") as f:
            data = f.read()
        st = os.stat(path)
        if (st.st_mtime_ns, st.st_size) != (mtime_ns, size):
            return
        h = hashlib.sha256(data).hexdigest()
        if h == self.sent_brief_hash:
            return
        body = {"html": data.decode("utf-8", "replace"), "generatedAt": mtime_ns // 1_000_000}
        status, text = post(self.url, self.key, "/api/brief", body)
        if status != 200:
            raise RuntimeError(f"HTTP {status}: {text[:200]}")
        self.sent_brief_hash = h
        log.info("sent brief %s (%d bytes)%s", path, len(data), " ignored" if "ignored" in text else "")

    def brief_step(self, force=False):
        now = time.time()
        if not force and now < self.next_brief_scan:
            return
        self.next_brief_scan = now + BRIEF_SCAN_S
        cand = find_brief()
        settled = cand is not None and (force or cand == self.brief_seen)
        self.brief_seen = cand
        if not settled:
            return
        try:
            self.push_brief(cand)
            self.brief_failures = 0
        except (urllib.error.URLError, http.client.HTTPException, OSError, RuntimeError, ValueError) as e:
            self.brief_failures += 1
            self.next_brief_scan = now + min(1800, BRIEF_SCAN_S * 2 ** min(self.brief_failures, 5))
            log.warning("brief push failed (%d): %s", self.brief_failures, e)


def single_instance():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", LOCK_PORT))
        s.listen(1)
        return s
    except OSError:
        return None


def cmd_run(args):
    lock = single_instance()
    if lock is None:
        log.debug("already running: another copy holds the lock")
        return 0  # the scheduled task re-launches every 5 min
    url, key = load_config(args)
    watched = args.mirror[0] if args.mirror else os.path.dirname(args.chains)
    log.info("start: %s, watching %s", url, watched)
    mirror = Mirror(*args.mirror) if args.mirror else None  # reads the state only once the lock is held
    p = Publisher(url, key, args.chains, args.template)
    ok_at = time.time() if poll_mirror(mirror) else 0.0
    warn_missing_chains(args)
    live = mirror_live(mirror, ok_at, True)
    if live:
        p.step(force=True)
    p.brief_step()
    mirror_due = time.time() + MIN_PUSH_S
    while True:
        time.sleep(POLL_S)
        if time.time() >= mirror_due:
            ok_at = time.time() if poll_mirror(mirror) else ok_at
            mirror_due = time.time() + MIN_PUSH_S
        live = mirror_live(mirror, ok_at, live)
        if live:
            p.step()
        p.brief_step()


def cmd_once(args):
    url, key = load_config(args)
    lock = single_instance() if args.mirror else None  # held until return: `run` cannot start meanwhile
    mirror = Mirror(*args.mirror) if args.mirror and lock else None
    if args.mirror and lock is None:
        log.info("run is active: pushing its chains.js without replaying the transcripts")
    live = poll_mirror(mirror)
    if mirror and not mirror.dirty:
        mirror.flush()
    warn_missing_chains(args)
    p = Publisher(url, key, args.chains, args.template)
    if not live:
        p.brief_step(force=True)
        return f"transcripts folder not found: {mirror.projects_dir}" if mirror.root_missing else \
            "transcript mirror not read cleanly: nothing pushed"
    p.push(p.build(force=True))
    p.brief_step(force=True)


def print_mirror_status(mirror):
    """Continue from the saved replay state (a full first scan when there is none) without writing anything."""
    print(f"transcripts: {mirror.projects_dir} {'(found)' if os.path.isdir(mirror.projects_dir) else '(missing)'}")
    resumed = not mirror.first
    mirror.state_path = mirror.chains_path = None
    mirror.poll()
    since = "saved state + new lines" if resumed else f"first scan, last {MIRROR_HORIZON_DAYS} days"
    print(f"mirror: {len(mirror.docs)} chains ({count_open(mirror.docs)} open), {since}")


def cmd_status(args):
    if args.mirror:
        print_mirror_status(Mirror(*args.mirror))
    else:
        try:
            docs, stamp = read_chains(args.chains)
        except OSError:
            sys.exit(missing_chains_message(args))
        print(f"chains.js: {len(docs)} chains ({count_open(docs)} open), stamp {stamp}")
    tpl = read_template(args.template)
    print(f"template: {'%d bytes' % len(tpl) if tpl else 'missing'}")
    print(f"config: {args.config} {'(found)' if os.path.isfile(args.config) else '(missing)'}")
    matches = glob.glob(BRIEF_GLOB)
    no_json = sum(1 for m in matches if not has_brief_json(m))
    print(f"brief: {BRIEF_GLOB}: {len(matches)} files ({no_json} without standup_brief.json)")
    cand = find_brief()
    if cand is None:
        print("brief chosen: none")
    else:
        when = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(cand[1] / 1e9))
        print(f"brief chosen: {cand[0]}, {when}, {cand[2]} bytes")


def pythonw():
    exe = sys.executable
    cand = os.path.join(os.path.dirname(exe), "pythonw.exe")
    return cand if os.path.isfile(cand) else exe


def cmd_install(args):
    script = os.path.abspath(__file__)
    tr = f'"{pythonw()}" "{script}" run --quiet'
    if os.path.normcase(args.config) != os.path.normcase(CONFIG):
        tr += f' --config "{args.config}"'
    cmd = ["schtasks", "/Create", "/TN", TASK, "/TR", tr, "/SC", "MINUTE", "/MO", "5", "/F"]
    print(" ".join(cmd))
    subprocess.run(cmd, check=True)
    subprocess.run(["schtasks", "/Run", "/TN", TASK], check=False)


def cmd_uninstall(args):
    subprocess.run(["schtasks", "/End", "/TN", TASK], check=False)
    subprocess.run(["schtasks", "/Delete", "/TN", TASK, "/F"], check=False)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["run", "once", "status", "install", "uninstall"])
    ap.add_argument("--config", default=CONFIG, help="publisher.json (default: %(default)s)")
    ap.add_argument("--url")
    ap.add_argument("--key")
    ap.add_argument("--quiet", action="store_true", help="log to file only")
    args = ap.parse_args()
    args.config = os.path.abspath(args.config)
    state_dir = os.path.dirname(args.config)
    setup_logging(args.quiet, state_dir)
    args.cfg = read_config(args.config)
    args.chains, args.template, args.mirror = sources(args.cfg, state_dir)
    return {"run": cmd_run, "once": cmd_once, "status": cmd_status,
            "install": cmd_install, "uninstall": cmd_uninstall}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
