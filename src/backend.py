"""Backend database.
"""
from functools import lru_cache
import json
import os
import sqlite3
from typing import Any, Dict, List, Optional, Sequence, Union
import uuid

from networkx.readwrite import json_graph

import exceptions
from models import (
    BaseRunArea,
    CurrentUser,
    LoggedRun,
    SegmentCollection,
    RunArea,
    SubRunArea,
)


class RunningDatabase(object):
    """Stores runs created in the app."""

    tables = {
        "users": {
            "schema": [
                ("username", "text", "NOT NULL"),
                ("hashed_password", "text", "NOT NULL"),
            ],
        },
        "run_areas": {
            "schema": [
                ("username", "text", "NOT NULL"),
                ("area_name", "text", "NOT NULL"),
                ("polygon", "text", "NOT NULL"),
                ("graph", "text", "NULL"),
                ("geometry", "text", "NULL"),
                ("active", "integer", "NOT NULL"),
            ],
            "index": ["username", "name"],
        },
        "sub_run_areas": {
            "schema": [
                ("username", "text", "NOT NULL"),
                ("area_name", "text", "NOT NULL"),
                ("sub_area_name", "text", "NOT NULL"),
                ("polygon", "text", "NOT NULL"),
            ],
            "index": ["username", "area_name"],
        },
        "logged_runs": {
            "schema": [
                ("id", "uuid", "NOT NULL"),
                ("username", "text", "NOT NULL"),
                ("area_name", "text", "NOT NULL"),
                ("date", "date", "NOT NULL"),
                ("distance_miles", "float", "NOT NULL"),
                ("duration_minutes", "float", "NULL"),
                ("comments", "text", "NULL"),
                ("linestring", "text", "NULL"),
            ],
            "index": ["id"],
        },
        "segment_traversals": {
            "schema": [
                ("run_id", "uuid", "NOT NULL"),
                ("segment_id", "text", "NOT NULL"),
                ("traversals", "int", "NOT NULL"),
            ],
            "index": ["run_id"],
        },
        "ignored_segments": {
            "schema": [
                ("username", "text", "NOT NULL"),
                ("area_name", "text", "NOT NULL"),
                ("segment_id", "text", "NOT NULL"),
            ],
            "index": ["username", "area_name"],
        },
    }

    def __init__(
        self,
        name: str = "running",
        clean: bool = False,
    ):
        self.name = name
        if clean:
            self.clean()
        if not self.exists():
            self.create()

    @property
    def db(self):
        """Connect to the database."""
        return sqlite3.connect(f"{self.name}.db")

    def execute(
        self,
        query: str,
        query_params: Optional[Union[Sequence[tuple], tuple]] = None,
        expect_data: bool = False,
        many: bool = False,
        one: bool = False,
    ):
        """Execute a query."""
        conn = self.db
        if query_params is None:
            query_params = ()
        try:
            cursor = conn.cursor()
            executor = cursor.executemany if many else cursor.execute
            executor(query, query_params)
            if expect_data:
                fetcher = cursor.fetchone if one else cursor.fetchall
                return fetcher()
        finally:
            cursor.close()
            conn.commit()
            conn.close()

    def create(self):
        """Create database and tables."""
        for table_name, table_info in self.tables.items():
            formatted_schema = ",".join(
                [
                    f"{column} {dtype} {nullable}"
                    for column, dtype, nullable in table_info["schema"]
                ]
            )
            create_query = f"CREATE TABLE {table_name} ({formatted_schema})"
            try:
                self.execute(create_query)
            except sqlite3.OperationalError:
                pass

            if "index" not in table_info:
                continue

            index_cols = ", ".join(table_info["index"])
            index_query = (
                f"CREATE INDEX {table_name}_run_id ON {table_name}({index_cols});"
            )
            try:
                self.execute(index_query)
            except sqlite3.OperationalError:
                pass

    def clean(self, check=False):
        """Clean a database ready to start again."""
        if check and input("Are you sure? (yes to continue)") != "yes":
            print("Clean operation not confirmed, tables still exist.")
            return

        for table_name in self.tables:
            self.execute(f"DROP TABLE IF EXISTS {table_name}")
        os.remove(f"{self.name}.db")

    def exists(self) -> bool:
        """Whether the tables exist yet."""
        expected = set(self.tables.keys())
        query = 'SELECT name from sqlite_master where type= "table"'
        tables = self.execute(query, expect_data=True)
        for name, *_ in tables:
            if name in expected:
                expected.remove(name)
            else:
                print(f"Found unexpected table {name}")
        if expected:
            return False
        return True

    @staticmethod
    def get_duration_minutes(duration: str) -> float:
        """Convert string duration into duration in minutes."""
        hours = int(duration[:2])
        minutes = int(duration[3:5])
        seconds = int(duration[6:8])
        ms = int(duration[9:])
        return hours * 60 + minutes + seconds / 60 + ms / 6000

    def get_user(self, username: str) -> Optional[CurrentUser]:
        """Return user details if they exist."""
        query = "SELECT * FROM users WHERE username = ?"
        try:
            result = self.execute(
                query, query_params=(username,), expect_data=True, one=True
            )
            username, hashed_password = result
            run_area = self.get_active_area_for_user(username)
            active_area_name = None if run_area is None else run_area.area_name
            polygon = None if run_area is None else run_area.polygon
            return CurrentUser(
                username=username,
                hashed_password=hashed_password,
                active_area_name=active_area_name,
                polygon=polygon,
            )
        except TypeError:
            return None

    def insert_user(self, username: str, hashed_password: str) -> None:
        """Insert a user into the database."""
        existing_user = self.get_user(username)
        if existing_user is not None:
            raise exceptions.UsernameExistsError(username)

        query = "INSERT INTO users VALUES (?, ?)"
        self.execute(query, query_params=(username, hashed_password))

    def set_active_area_for_user(
        self, username: str, area_name: str
    ) -> Optional[RunArea]:
        """Set the active area for a user.

        At most one area can be active.
        """
        query = """
            UPDATE run_areas
            SET active = CASE WHEN area_name = ? THEN 1 ELSE 0 END
            WHERE username = ?
        """
        self.execute(
            query,
            query_params=(
                area_name,
                username,
            ),
            expect_data=False,
        )
        return self.get_active_area_for_user(username)

    def get_active_area_for_user(self, username: str) -> Optional[RunArea]:
        """Get the single active area for this user if one exists.

        At most one area can be active.
        """
        query = """
            SELECT
                username,
                area_name,
                polygon,
                active
            FROM run_areas
            WHERE username = ?
                AND active = 1
        """
        result = self.execute(
            query, query_params=(username,), expect_data=True, one=True
        )
        try:
            username, area_name, polygon, active = result
            return RunArea(
                username=username,
                area_name=area_name,
                polygon=polygon,
                active=bool(active),
            )
        except TypeError:
            return None

    def get_areas_for_user(
        self, username: str, artifacts_exist: bool = False
    ) -> List[RunArea]:
        """Return areas created by this user if they exist.

        Use `artifacts_exist` to control whether we get all run areas,
        regardless of their graph and geometry having been saved yet (default),
        or just those for which both artifacts exist.
        """
        artifacts_clause = ""
        if artifacts_exist:
            artifacts_clause = "AND graph IS NOT NULL AND geometry IS NOT NULL"

        query = f"""
            SELECT
                username,
                area_name,
                polygon,
                active
            FROM run_areas
            WHERE username = ?
            {artifacts_clause}
        """
        results = self.execute(
            query,
            query_params=(username,),
            expect_data=True,
        )
        return [
            RunArea(
                username=username,
                area_name=name,
                polygon=polygon,
                active=active,
            )
            for username, name, polygon, active in results
        ]

    def insert_run_area(self, run_area: RunArea) -> None:
        """Insert a run area into the database."""
        existing_areas = self.get_areas_for_user(run_area.username)
        if any(run_area.area_name == area.area_name for area in existing_areas):
            raise exceptions.RunAreaExistsError(run_area)

        query = """
            INSERT INTO run_areas (username, area_name, polygon, active)
            VALUES (?, ?, ?, ?)
        """
        query_params = (
            run_area.username,
            run_area.area_name,
            run_area.polygon,
            int(run_area.active),
        )
        self.execute(query, query_params=query_params)

    def insert_run_area_geometry(
        self, username: str, area_name: str, geometry: Dict
    ) -> None:
        """Insert a run area's geometry into the database."""
        query = """
            UPDATE run_areas
            SET geometry = ?
            WHERE username = ?
                AND area_name = ?
        """
        # json.dumps?
        query_params = (json.dumps(geometry), username, area_name)
        self.execute(query, query_params=query_params)

    def insert_run_area_graph(self, username: str, area_name: str, graph: Dict) -> None:
        """Insert a run area's graph into the database."""
        query = """
            UPDATE run_areas
            SET graph = ?
            WHERE username = ?
                AND area_name = ?
        """
        # json.dumps?
        query_params = (json.dumps(graph), username, area_name)
        self.execute(query, query_params=query_params)

    @lru_cache(maxsize=1)
    def get_run_area_graph(self, username: str, area_name: str) -> Optional[Dict]:
        """Get a run area's graph."""
        query = """
            SELECT graph
            FROM run_areas
            WHERE username = ?
                AND area_name = ?
        """
        query_params = (username, area_name)
        try:
            raw_graph, *_ = self.execute(
                query, query_params=query_params, expect_data=True, one=True
            )
            graph_data = json.loads(raw_graph)
            return json_graph.node_link_graph(graph_data)
        except TypeError:
            return None

    def get_run_area_geometry(self, username: str, area_name: str) -> Optional[Dict]:
        """Get a run area's geometry."""
        query = """
            SELECT geometry
            FROM run_areas
            WHERE username = ?
                AND area_name = ?
        """
        query_params = (username, area_name)
        try:
            geometry, *_ = self.execute(
                query, query_params=query_params, expect_data=True, one=True
            )
            return json.loads(geometry)
        except TypeError:
            return None

    def store_run(self, run_area: RunArea, run: LoggedRun) -> dict:
        """Store a run.

        Returns
        -------
        dict
            Including status of whether insertion of new segments was successful.
            Failure is due to an existing run on the date if `allow_multiple` is False.
        """
        if not run.allow_multiple and self.exists_run_on_date(run_area, run.date):
            reason = f"Run already exists for {run.date}, and `allow_multiple`=False: "
            reason += "new segments will not be added."
            return {"status_code": 400, "reason": reason}

        run_id = str(uuid.uuid4())

        logged_run_query = "INSERT INTO logged_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        try:
            duration_minutes = self.get_duration_minutes(run.duration)
        except TypeError:
            duration_minutes = None
        run_query_params = (
            run_id,
            run_area.username,
            run_area.area_name,
            run.date,
            run.distance_miles,
            duration_minutes,
            run.comments,
            run.linestring,
        )
        self.execute(logged_run_query, query_params=run_query_params)

        traversal_query_params = [
            (run_id, segment_id, count)
            for segment_id, count in run.segment_traversals.items()
        ]
        segment_traversals_query = "INSERT INTO segment_traversals VALUES (?, ?, ?)"
        self.execute(
            segment_traversals_query, query_params=traversal_query_params, many=True
        )

        return {"status_code": 200}

    def ignored_segment_ids(self, run_area: BaseRunArea) -> List[str]:
        """Get segment ids that should be ignored when plotting/calculating stats."""
        query = """
            SELECT segment_id
            FROM ignored_segments
            WHERE username = ?
                AND area_name = ?
        """
        query_params = (run_area.username, run_area.area_name)
        results = self.execute(query, query_params=query_params, expect_data=True)
        return [segment_id for segment_id, *_ in results]

    def remove_from_ignored_segments(self, segment_collection: SegmentCollection):
        """No longer ignore specified segments."""
        if not segment_collection.segment_ids:
            return

        placeholders = ", ".join(["?" for _ in segment_collection.segment_ids])
        delete_query = f"""
            DELETE FROM ignored_segments
            WHERE username = ?
                AND area_name = ?
                AND segment_id IN ({placeholders})
        """
        query_params = [segment_collection.username, segment_collection.area_name]
        query_params += segment_collection.segment_ids
        self.execute(delete_query, query_params=tuple(query_params))

    def add_to_ignored_segments(self, segment_collection: SegmentCollection):
        """Add specified segments to ignore set."""
        if not segment_collection.segment_ids:
            return

        query_params = [
            (segment_collection.username, segment_collection.area_name, segment_id)
            for segment_id in segment_collection.segment_ids
        ]
        insert_query = "INSERT INTO ignored_segments VALUES (?, ?, ?)"
        self.execute(insert_query, query_params=query_params, many=True)

    def update_ignored_segments(self, segment_collection: SegmentCollection):
        """Update the table of segments which should be ignored."""
        run_area = BaseRunArea(
            username=segment_collection.username, area_name=segment_collection.area_name
        )
        currently_ignored_segment_ids = set(self.ignored_segment_ids(run_area))

        new_ignored_segment_ids = [
            segment_id
            for segment_id in segment_collection.segment_ids
            if segment_id not in currently_ignored_segment_ids
        ]
        self.add_to_ignored_segments(
            SegmentCollection(
                username=segment_collection.username,
                area_name=segment_collection.area_name,
                segment_ids=new_ignored_segment_ids,
            )
        )

        segment_ids_to_no_longer_ignore = [
            segment_id
            for segment_id in segment_collection.segment_ids
            if segment_id in currently_ignored_segment_ids
        ]
        self.remove_from_ignored_segments(
            SegmentCollection(
                username=segment_collection.username,
                area_name=segment_collection.area_name,
                segment_ids=segment_ids_to_no_longer_ignore,
            )
        )

    def make_date_clause(
        self, start_date: Optional[str] = None, end_date: Optional[str] = None
    ) -> Dict[str, Any]:
        """Create clause to filter runs between start and end dates."""
        if start_date is None and end_date is None:
            return {"clause": "WHERE 1 = 1", "query_params": []}
        elif start_date is None:
            return {"clause": "WHERE date <= ?", "query_params": [end_date]}
        elif end_date is None:
            return {"clause": "WHERE date >= ?", "query_params": [start_date]}
        else:
            return {
                "clause": "WHERE date BETWEEN ? AND ?",
                "query_params": [start_date, end_date],
            }

    def number_runs_in_date_range(
        self,
        run_area: RunArea,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> int:
        """Get number of runs in time range."""
        date_clause = self.make_date_clause(start_date=start_date, end_date=end_date)
        query = f"""
            SELECT COUNT(DISTINCT id)
            FROM logged_runs
            {date_clause['clause']}
                AND username = ?
                AND area_name = ?
        """
        query_params = date_clause["query_params"] + [
            run_area.username,
            run_area.area_name,
        ]
        return self.execute(query, query_params=tuple(query_params), expect_data=True)[
            0
        ][0]

    def total_number_of_runs(self, run_area: RunArea) -> int:
        """Total number of stored runs."""
        return self.number_runs_in_date_range(run_area)

    def runs_in_date_range(
        self,
        run_area: RunArea,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> List[Dict[str, str]]:
        """Get all runs in time range."""
        date_clause = self.make_date_clause(start_date=start_date, end_date=end_date)
        query = f"""
            SELECT
                 lr.date,
                 st.segment_id,
                 st.traversals
            FROM segment_traversals st
            INNER JOIN (
                SELECT
                    id,
                    date
                FROM logged_runs
                {date_clause['clause']}
                    AND username = ?
                    AND area_name = ?
            ) lr
                ON st.run_id == lr.id
            ORDER BY lr.date ASC
        """
        query_params = date_clause["query_params"] + [
            run_area.username,
            run_area.area_name,
        ]
        results = self.execute(
            query, query_params=tuple(query_params), expect_data=True
        )
        return [
            {"date": date, "segment_id": segment_id, "traversals": traversals}
            for date, segment_id, traversals in results
        ]

    def all_runs(self, run_area: RunArea) -> List[Dict[str, str]]:
        """Get all stored runs."""
        return self.runs_in_date_range(run_area)

    def first_seen(
        self,
        run_area: RunArea,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> List[Dict[str, str]]:
        """Find the first date in the date range on which a segment was coverd."""
        date_clause = self.make_date_clause(start_date=start_date, end_date=end_date)
        query = f"""
            SELECT
                 MIN(lr.date),
                 st.segment_id
            FROM segment_traversals st
            INNER JOIN (
                SELECT
                    id,
                    date
                FROM logged_runs
                {date_clause['clause']}
                    AND username = ?
                    AND area_name = ?
            ) lr
                ON st.run_id == lr.id
            GROUP BY st.segment_id
            ORDER BY MIN(lr.date)
        """
        query_params = date_clause["query_params"] + [
            run_area.username,
            run_area.area_name,
        ]
        results = self.execute(
            query, query_params=tuple(query_params), expect_data=True
        )
        return [
            {"date": date, "segment_id": segment_id} for date, segment_id in results
        ]

    def run_on_date(self, run_area: RunArea, date: str) -> List[Dict[str, str]]:
        """Get run on a specific date."""
        return self.runs_in_date_range(run_area, start_date=date, end_date=date)

    def delete_runs_on_date(self, run_area: RunArea, date: str):
        """Delete runs on specified date."""
        run_id_query = """
            SELECT id
            FROM logged_runs
            WHERE username = ?
                AND area_name = ?
                AND date = ?
        """
        query_params = (run_area.username, run_area.area_name, date)
        results = self.execute(run_id_query, query_params=query_params)
        run_ids = tuple([id for id, *_ in results])

        placeholders = ", ".join(["?" for _ in run_ids])
        logged_run_query = f"DELETE FROM logged_runs WHERE id IN ({placeholders})"
        self.execute(logged_run_query, query_params=run_ids)

        traversals_query = (
            f"DELETE FROM segment_traversals WHERE run_id IN ({placeholders})"
        )
        self.execute(traversals_query, query_params=run_ids)

    def delete_run_by_id(self, id: str):
        """Delete run with specific id."""
        logged_run_query = "DELETE FROM logged_runs WHERE id = ?"
        self.execute(logged_run_query, query_params=(id,))

        traversals_query = "DELETE FROM segment_traversals WHERE run_id = ?"
        self.execute(traversals_query, query_params=(id,))

    def exists_run_on_date(self, run_area: RunArea, date: str) -> bool:
        """Indicates if a run for a given date is already stored."""
        return bool(self.run_on_date(run_area, date))

    def number_of_traversals_in_date_range(
        self,
        run_area: RunArea,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> List[Dict[str, Union[str, int]]]:
        """Count the number of times each segment has been run in date range."""
        date_clause = self.make_date_clause(start_date=start_date, end_date=end_date)
        query = f"""
            SELECT
                 st.segment_id,
                 SUM(st.traversals) AS num_traversals
            FROM segment_traversals st
            INNER JOIN (
                SELECT id
                FROM logged_runs
                {date_clause['clause']}
                    AND username = ?
                    AND area_name = ?
            ) lr
                ON st.run_id == lr.id
            GROUP BY st.segment_id
        """
        query_params = date_clause["query_params"] + [
            run_area.username,
            run_area.area_name,
        ]
        results = self.execute(
            query, query_params=tuple(query_params), expect_data=True
        )
        return [
            {"segment_id": segment_id, "num_traversals": num_traversals}
            for segment_id, num_traversals in results
        ]

    def total_number_of_traversals(
        self, run_area: RunArea
    ) -> List[Dict[str, Union[str, int]]]:
        """Count the number of times each segment has been run in total."""
        return self.number_of_traversals_in_date_range(run_area)

    def uploaded_runs_in_date_range(
        self,
        run_area: RunArea,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> List[Dict[str, Union[str, int]]]:
        """Retrieve all run geometries in date range."""
        date_clause = self.make_date_clause(start_date=start_date, end_date=end_date)
        query = f"""
            SELECT
                date,
                linestring
            FROM logged_runs
            {date_clause['clause']}
                AND username = ?
                AND area_name = ?
                AND linestring IS NOT NULL
            ORDER BY date ASC
        """
        query_params = date_clause["query_params"] + [
            run_area.username,
            run_area.area_name,
        ]
        results = self.execute(
            query, query_params=tuple(query_params), expect_data=True
        )
        return [
            {"date": date, "linestring": linestring} for date, linestring in results
        ]

    def get_sub_run_area(self, sub_run_area: SubRunArea):
        """Get all information about a sub run area."""
        query = """
            SELECT
                username,
                area_name,
                sub_area_name,
                polygon
            FROM sub_run_areas
            WHERE username = ?
                AND area_name = ?
                AND sub_area_name = ?
        """
        query_params = (
            sub_run_area.username,
            sub_run_area.area_name,
            sub_run_area.sub_area_name,
        )
        result = self.execute(
            query, query_params=query_params, expect_data=True, one=True
        )
        if result is None:
            return
        # should crucially also have the polygon now
        username, area_name, sub_area_name, polygon = result
        sub_run_area = SubRunArea(
            username=username,
            area_name=area_name,
            sub_area_name=sub_area_name,
            polygon=polygon,
        )
        return sub_run_area

    def get_sub_run_areas(self, run_area: BaseRunArea) -> List[SubRunArea]:
        """Get all sub run areas in a run area."""
        query = """
            SELECT
                username,
                area_name,
                sub_area_name,
                polygon
            FROM sub_run_areas
            WHERE username = ?
                AND area_name = ?
        """
        query_params = (run_area.username, run_area.area_name)
        results = self.execute(query, query_params=query_params, expect_data=True)
        sub_run_areas = [
            SubRunArea(
                username=username,
                area_name=area_name,
                sub_area_name=sub_area_name,
                polygon=polygon,
            )
            for username, area_name, sub_area_name, polygon in results
        ]
        return sub_run_areas

    def insert_sub_run_area(self, sub_run_area: SubRunArea) -> None:
        """Insert a sub run area into the database."""
        if sub_run_area.polygon is None:
            raise exceptions.MissingPolygonError(sub_run_area)

        existing_sub_run_area = self.get_sub_run_area(sub_run_area)
        if existing_sub_run_area is not None:
            raise exceptions.SubRunAreaExistsError(sub_run_area)

        query = "INSERT INTO sub_run_areas VALUES (?, ?, ?, ?)"
        query_params = (
            sub_run_area.username,
            sub_run_area.area_name,
            sub_run_area.sub_area_name,
            sub_run_area.polygon,
        )
        self.execute(query, query_params=query_params)

    def remove_sub_run_area(self, sub_run_area: SubRunArea) -> None:
        """Remove a sub run area from the database."""
        query = """
            DELETE FROM sub_run_areas
            WHERE username = ?
                AND area_name = ?
                AND sub_area_name = ?
        """
        query_params = (
            sub_run_area.username,
            sub_run_area.area_name,
            sub_run_area.sub_area_name,
        )
        self.execute(query, query_params=query_params)

    def remove_run_area(self, run_area: RunArea) -> None:
        """Remove a run area from the database.

        This requires data being removed from several tables.
        """
        run_area_query_params = (run_area.username, run_area.area_name)

        # set a new active area if this area is active and more exist for this user
        query = """
            SELECT active
            FROM run_areas
            WHERE username = ?
                AND area_name = ?
        """
        active = self.execute(
            query, query_params=run_area_query_params, expect_data=True, one=True
        )

        query = """
            SELECT area_name
            FROM run_areas
            WHERE username = ?
                AND area_name != ?
        """
        results = self.execute(
            query, query_params=run_area_query_params, expect_data=True, one=True
        )
        run_area_names = [area_name for area_name, *_ in results]

        if active and run_area_names:
            self.set_active_area_for_user(run_area.username, run_area_names[0])

        # we need to get the relevant run ids to delete segment traversals
        query = """
            SELECT id
            FROM ignored_segments
            WHERE username = ?
                AND area_name = ?
        """
        results = self.execute(
            query, query_params=run_area_query_params, expect_data=True
        )
        run_ids = {run_id for run_id, *_ in results}

        if run_ids:
            placeholders = ", ".join(["?" for _ in run_ids])
            query = f"DELETE FROM segment_traversals WHERE run_id IN ({placeholders})"
            self.execute(query, query_params=tuple(run_ids))

        # remaining tables are easier
        for table in ("run_areas", "sub_run_areas", "ignored_segments", "logged_runs"):
            query = f"DELETE FROM {table} WHERE username = ? AND area_name = ?"
            self.execute(query, query_params=run_area_query_params)
