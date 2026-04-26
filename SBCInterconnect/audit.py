"""
audit.py
========
BioReactorAgent — Append-Only Persistent Audit Store
=====================================================
Implements FR-26, FR-27, FR-28.

Maintains a SQLite database at the path configured in config.toml [data].db_path.

Two tables:
  snapshots  — one row per reactor per tick (ReactorSnapshot shape)
  audit_log  — one row per agent/rule action (AgentLogEvent shape)

All writes use aiosqlite (non-blocking async I/O).  A snapshot or audit entry
write MUST complete before the corresponding OPC-UA write is attempted — callers
are responsible for awaiting these coroutines before calling opc_writer.

FR-28: No DELETE is exposed through any application-accessible method.
       The only way to remove data is direct filesystem access to audit.db,
       which is outside the application's security boundary.

Usage:
    from audit import AuditStore
    store = AuditStore(db_path, run_id)
    await store.init()
    await store.write_snapshot(reactor_id, day, snapshot_dict)
    await store.write_audit(reactor_id, day, action_type, parameter="pH",
                            pre_value=7.1, new_value=7.0, unit="",
                            reasoning="pH drifted low", severity="warning",
                            executed_by="rule_engine")
"""

import asyncio
import json
import logging
import os
import time
from typing import Any, Optional

import aiosqlite

logger = logging.getLogger("audit")


# ─── Schema ──────────────────────────────────────────────────────────────────

_DDL_SNAPSHOTS = """
CREATE TABLE IF NOT EXISTS snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT    NOT NULL,
    reactor_id  TEXT    NOT NULL,
    day         REAL    NOT NULL,
    VCD         REAL,
    viability   REAL,
    glucose     REAL,
    lactate     REAL,
    glutamine   REAL,
    ammonia     REAL,
    pH          REAL,
    DO          REAL,
    temperature REAL,
    agitation   REAL,
    osmolality  REAL,
    pCO2        REAL,
    mAb_titer   REAL,
    status      TEXT,
    anomalies   TEXT,   -- JSON array
    feed_events TEXT,   -- JSON array
    strategy    TEXT,
    timestamp   TEXT
);
"""

_DDL_AUDIT_LOG = """
CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT    NOT NULL,
    reactor_id  TEXT    NOT NULL,
    day         REAL    NOT NULL,
    action_type TEXT    NOT NULL,
    parameter   TEXT,
    pre_value   REAL,
    new_value   REAL,
    unit        TEXT,
    reasoning   TEXT,
    severity    TEXT,
    executed_by TEXT    DEFAULT 'BioReactorAgent v1.0',
    timestamp   REAL    NOT NULL   -- Unix epoch (time.time())
);
"""

# Prevent DELETE via trigger — FR-28 enforcement at the DB level
_DDL_NO_DELETE_SNAPSHOTS = """
CREATE TRIGGER IF NOT EXISTS prevent_delete_snapshots
BEFORE DELETE ON snapshots
BEGIN
    SELECT RAISE(ABORT, 'snapshots rows are append-only and cannot be deleted');
END;
"""

_DDL_NO_DELETE_AUDIT = """
CREATE TRIGGER IF NOT EXISTS prevent_delete_audit_log
BEFORE DELETE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log rows are append-only and cannot be deleted');
END;
"""

_DDL_NO_UPDATE_SNAPSHOTS = """
CREATE TRIGGER IF NOT EXISTS prevent_update_snapshots
BEFORE UPDATE ON snapshots
BEGIN
    SELECT RAISE(ABORT, 'snapshots rows are append-only and cannot be updated');
END;
"""

_DDL_NO_UPDATE_AUDIT = """
CREATE TRIGGER IF NOT EXISTS prevent_update_audit_log
BEFORE UPDATE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log rows are append-only and cannot be updated');
END;
"""


class AuditStore:
    """
    Async append-only SQLite store.

    Parameters
    ----------
    db_path : str
        Filesystem path for the SQLite database, e.g.
        /opt/bioreactor-agent/data/audit.db
    run_id : str
        Identifies this production run across all rows, e.g. "run-001".
        Loaded from the RUN_ID environment variable in main.py.
    """

    def __init__(self, db_path: str, run_id: str) -> None:
        self.db_path = db_path
        self.run_id = run_id
        self._db: Optional[aiosqlite.Connection] = None
        self._write_lock = asyncio.Lock()

    # ── Lifecycle ──────────────────────────────────────────────────────────

    async def init(self) -> None:
        """
        Open the SQLite connection and apply DDL.
        Must be called once before any write_* method.
        Creates the database file and parent directories if they don't exist.
        """
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self._db = await aiosqlite.connect(self.db_path)

        # WAL mode for concurrent read+write without blocking
        await self._db.execute("PRAGMA journal_mode=WAL;")
        await self._db.execute("PRAGMA synchronous=NORMAL;")

        await self._db.execute(_DDL_SNAPSHOTS)
        await self._db.execute(_DDL_AUDIT_LOG)
        await self._db.execute(_DDL_NO_DELETE_SNAPSHOTS)
        await self._db.execute(_DDL_NO_DELETE_AUDIT)
        await self._db.execute(_DDL_NO_UPDATE_SNAPSHOTS)
        await self._db.execute(_DDL_NO_UPDATE_AUDIT)
        await self._db.commit()
        logger.info("AuditStore initialised — db=%s run_id=%s", self.db_path, self.run_id)

    async def close(self) -> None:
        """Flush and close the database connection."""
        if self._db:
            await self._db.close()
            self._db = None

    # ── Write: snapshot ───────────────────────────────────────────────────

    async def write_snapshot(self, reactor_id: str, day: float,
                             snapshot: dict) -> None:
        """
        Persist a ReactorSnapshot dict to the snapshots table.

        The snapshot dict is the exact shape produced by
        bioreactor_simulator._snapshot() and kalman.get_state().

        FR-27: write completes before any OPC-UA write is attempted.
        """
        if self._db is None:
            logger.error("AuditStore.write_snapshot called before init()")
            return

        async with self._write_lock:
            await self._db.execute(
                """
                INSERT INTO snapshots
                    (run_id, reactor_id, day, VCD, viability, glucose, lactate,
                     glutamine, ammonia, pH, DO, temperature, agitation,
                     osmolality, pCO2, mAb_titer, status, anomalies,
                     feed_events, strategy, timestamp)
                VALUES
                    (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    self.run_id,
                    reactor_id,
                    day,
                    snapshot.get("VCD"),
                    snapshot.get("viability"),
                    snapshot.get("glucose"),
                    snapshot.get("lactate"),
                    snapshot.get("glutamine"),
                    snapshot.get("ammonia"),
                    snapshot.get("pH"),
                    snapshot.get("DO"),
                    snapshot.get("temperature"),
                    snapshot.get("agitation"),
                    snapshot.get("osmolality"),
                    snapshot.get("pCO2"),
                    snapshot.get("mAb_titer"),
                    snapshot.get("status"),
                    json.dumps(snapshot.get("anomalies", [])),
                    json.dumps(snapshot.get("feed_events", [])),
                    snapshot.get("strategy"),
                    snapshot.get("timestamp"),
                ),
            )
            await self._db.commit()

    # ── Write: audit entry ────────────────────────────────────────────────

    async def write_audit(
        self,
        reactor_id: str,
        day: float,
        action_type: str,
        *,
        parameter: Optional[str] = None,
        pre_value: Optional[float] = None,
        new_value: Optional[float] = None,
        unit: Optional[str] = None,
        reasoning: Optional[str] = None,
        severity: Optional[str] = None,
        executed_by: str = "BioReactorAgent v1.0",
    ) -> None:
        """
        Append one row to audit_log.

        action_type examples:
          "ph_correction", "agitation_correction", "temp_correction",
          "feed_rate_correction", "flag_human", "constraint_block",
          "write_skipped_disconnected", "write_rejected", "gpt_unavailable",
          "gpt_adjust_feed", "gpt_temp_shift", "gpt_propagate_strategy",
          "gpt_flag_human", "gpt_log_decision", "connection_lost"

        FR-27: callers must await this before the corresponding OPC-UA write.
        FR-28: no delete/update triggers are in place — this is truly append-only.
        """
        if self._db is None:
            logger.error("AuditStore.write_audit called before init()")
            return

        async with self._write_lock:
            await self._db.execute(
                """
                INSERT INTO audit_log
                    (run_id, reactor_id, day, action_type, parameter,
                     pre_value, new_value, unit, reasoning, severity,
                     executed_by, timestamp)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    self.run_id,
                    reactor_id,
                    day,
                    action_type,
                    parameter,
                    pre_value,
                    new_value,
                    unit,
                    reasoning,
                    severity,
                    executed_by,
                    time.time(),
                ),
            )
            await self._db.commit()

    # ── Read helpers (used by api.py in production) ───────────────────────

    async def get_snapshots(self, reactor_id: Optional[str] = None,
                            run_id: Optional[str] = None,
                            limit: int = 500) -> list[dict]:
        """
        Return snapshot rows as dicts.  Used by api.py in production to serve
        the same JSON shapes the frontend expects (replacing the RUNS in-memory
        dict).  No API surface changes required.
        """
        if self._db is None:
            return []

        rid = run_id or self.run_id
        if reactor_id:
            cursor = await self._db.execute(
                "SELECT * FROM snapshots WHERE run_id=? AND reactor_id=? "
                "ORDER BY day DESC LIMIT ?",
                (rid, reactor_id, limit),
            )
        else:
            cursor = await self._db.execute(
                "SELECT * FROM snapshots WHERE run_id=? ORDER BY day DESC LIMIT ?",
                (rid, limit),
            )
        rows = await cursor.fetchall()
        cols = [d[0] for d in cursor.description]
        result = []
        for row in rows:
            d = dict(zip(cols, row))
            # Deserialise JSON columns
            d["anomalies"]   = json.loads(d["anomalies"] or "[]")
            d["feed_events"] = json.loads(d["feed_events"] or "[]")
            result.append(d)
        return result

    async def get_audit_log(self, reactor_id: Optional[str] = None,
                            run_id: Optional[str] = None,
                            limit: int = 500) -> list[dict]:
        """Return audit_log rows as dicts."""
        if self._db is None:
            return []

        rid = run_id or self.run_id
        if reactor_id:
            cursor = await self._db.execute(
                "SELECT * FROM audit_log WHERE run_id=? AND reactor_id=? "
                "ORDER BY timestamp DESC LIMIT ?",
                (rid, reactor_id, limit),
            )
        else:
            cursor = await self._db.execute(
                "SELECT * FROM audit_log WHERE run_id=? ORDER BY timestamp DESC LIMIT ?",
                (rid, limit),
            )
        rows = await cursor.fetchall()
        cols = [d[0] for d in cursor.description]
        return [dict(zip(cols, row)) for row in rows]
