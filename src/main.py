"""Main entrypoint to the app.
"""
from datetime import timedelta
from functools import lru_cache
import logging
from logging.config import dictConfig
import os
from pathlib import Path
from typing import List, Optional

from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    HTTPException,
    Request,
    Response,
    status,
    UploadFile,
)
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.security import OAuth2PasswordRequestForm
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from jose import JWTError, jwt
from networkx.algorithms import shortest_path
import pandas as pd
from shapely.geometry import Polygon
import uvicorn

import auth
from backend import RunningDatabase
import exceptions
import gps_utils
from logging_config import logging_config
import models
from osm import preprocess_running_network


UPLOAD_EXTENSIONS = {".tcx"}

dictConfig(logging_config)

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

templates = Jinja2Templates(directory="templates")
logger = logging.getLogger("main-logger")


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return FileResponse("static/images/favicon.ico")


def check_file_type(uploaded_file):
    """Check uploaded file has an acceptable file extension."""
    return Path(uploaded_file.filename).suffix in UPLOAD_EXTENSIONS


@lru_cache(maxsize=1)
def database():
    """Get the running database to be used."""
    mode = os.environ.get("RUNNING_APP_MODE", "DEV").upper()
    if mode == "PROD":
        db = RunningDatabase(name="running", clean=False)
    else:
        db = RunningDatabase(name="running_dev", clean=True)
    return db


@app.exception_handler(401)
async def custom_401_handler(*args, **kwargs):
    """Redirect unauthenticated user to the login page."""
    return RedirectResponse("/login")


async def get_current_user(
    token: str = Depends(auth.oauth2_scheme), db: RunningDatabase = Depends(database)
):
    """Try to get user's details if they have valid token in header/cookie."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
    )
    try:
        payload = jwt.decode(
            token,
            auth.SECRET_KEY,
            algorithms=[auth.ALGORITHM],
        )
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
        token_data = models.User(username=username)
    except (AttributeError, JWTError):
        raise credentials_exception

    user = db.get_user(username=token_data.username)
    if user is None:
        raise credentials_exception
    return user


def get_routing_graph(
    current_user: models.CurrentUser, db: RunningDatabase, respect_ignored: bool = False
):
    """Load the graph for routing for the current user and area."""
    run_area = current_user.make_run_area()
    graph = db.get_run_area_graph(current_user.username, current_user.active_area_name)

    if respect_ignored:
        ignored_segment_ids = db.ignored_segment_ids(run_area)
        to_remove = []
        for u, v, data in graph.edges(data=True):
            if data.get("segment_id") in ignored_segment_ids:
                to_remove.append((u, v))

        graph.remove_edges_from(to_remove)

    return graph


@app.post("/login")
async def login_for_access_token(
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: RunningDatabase = Depends(database),
):
    user = auth.authenticate_user(db, form_data.username, form_data.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    access_token_expires = timedelta(minutes=auth.ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = auth.create_access_token(
        data={"sub": user.username}, expires_delta=access_token_expires
    )

    # need 303 to redirect correctly + post method on / path
    response = RedirectResponse("/", status_code=status.HTTP_303_SEE_OTHER)
    response.set_cookie(
        key="Authorization", value=f"Bearer {access_token}", httponly=True
    )
    return response


@app.get("/logout", response_class=HTMLResponse)
def logout():
    """Logout the currently logged-in user."""
    response = RedirectResponse(url="/login")
    response.delete_cookie("Authorization")
    return response


@app.get("/login", response_class=HTMLResponse)
def login(request: Request):
    """Login page."""
    return templates.TemplateResponse("auth.html", {"request": request})


@app.post("/register")
async def register_user(
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: RunningDatabase = Depends(database),
):
    """Register a user, if the username does not already exist."""
    try:
        hashed_password = auth.get_password_hash(form_data.password)
        db.insert_user(form_data.username, hashed_password)
    except exceptions.UsernameExistsError:
        pass

    # this indirectly takes us to the login page
    response = RedirectResponse("/", status_code=status.HTTP_303_SEE_OTHER)
    return response


@app.post("/set_active_area")
async def set_active_area(
    run_area: models.SwitchingRunArea,
    db: RunningDatabase = Depends(database),
):
    db.set_active_area_for_user(run_area.username, run_area.area_name)

    # reload the page where we changed area
    response = RedirectResponse(
        run_area.calling_url, status_code=status.HTTP_303_SEE_OTHER
    )
    return response


@app.post("/", response_class=HTMLResponse)
@app.get("/", response_class=HTMLResponse)
async def home(
    request: Request, current_user: models.CurrentUser = Depends(get_current_user)
):
    """App home page, where new runs can be entered."""
    if current_user.active_area_name is None:
        response = RedirectResponse("/run_area", status_code=status.HTTP_303_SEE_OTHER)
        return response
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/update", response_class=HTMLResponse)
def map_update(
    request: Request, current_user: models.CurrentUser = Depends(get_current_user)
):
    """Page for updating which roads are considered part of the map."""
    if current_user.active_area_name is None:
        response = RedirectResponse("/run_area", status_code=status.HTTP_303_SEE_OTHER)
        return response
    return templates.TemplateResponse("update.html", {"request": request})


@app.get("/current_user_areas", response_model=List[models.RunArea])
def get_current_user_areas(
    current_user: models.CurrentUser = Depends(get_current_user),
    db: RunningDatabase = Depends(database),
):
    """Get the areas associated to the current user."""
    return db.get_areas_for_user(current_user.username, artifacts_exist=True)


@app.get("/current_username")
def current_username(
    current_user: models.CurrentUser = Depends(get_current_user),
):
    """Get username of currently logged in user."""
    return {"username": current_user.username}


@app.get("/exists_run")
def exists_run(
    date: str,
    db: RunningDatabase = Depends(database),
    current_user: models.CurrentUser = Depends(get_current_user),
):
    """Check if a run is already stored for the given date."""
    run_area = current_user.make_run_area()
    return db.exists_run_on_date(run_area, date)


@app.get("/delete_run")
def delete_run(
    id: Optional[str],
    date: Optional[str],
    db: RunningDatabase = Depends(database),
    current_user: models.CurrentUser = Depends(get_current_user),
):
    """Delete runs on specified date."""
    if id is not None:
        db.delete_run_by_id(id)
    elif date is not None:
        run_area = current_user.make_run_area()
        db.delete_runs_on_date(run_area, date)
    else:
        raise ValueError("`id` or `date` must be a query argument")
    return {"success": True}


@app.post("/store_run")
def store_run(
    logged_run: models.LoggedRun,
    response: Response,
    db: RunningDatabase = Depends(database),
    current_user: models.CurrentUser = Depends(get_current_user),
):
    """Store a run."""
    run_area = current_user.make_run_area()
    outcome = db.store_run(run_area, logged_run)
    response.status_code = outcome["status_code"]
    return outcome


@app.get("/currently_ignored_segments")
def currently_ignored_segments(
    db: RunningDatabase = Depends(database),
    current_user: models.CurrentUser = Depends(get_current_user),
):
    """Segments currently being ignored for plotting/calculating statistics."""
    run_area = current_user.make_run_area()
    return db.ignored_segment_ids(run_area)


@app.post("/update_ignored_segments")
def update_ignored_segments(
    ignored_segments: models.SegmentList,
    db: RunningDatabase = Depends(database),
    current_user: models.CurrentUser = Depends(get_current_user),
):
    """Update the set of ignored segments."""
    segment_collection = models.SegmentCollection(
        username=current_user.username,
        area_name=current_user.active_area_name,
        segment_ids=ignored_segments.segment_ids,
    )
    db.update_ignored_segments(segment_collection)
    return {"success": True}


@app.get("/stats", response_class=HTMLResponse)
def stats(
    request: Request, current_user: models.CurrentUser = Depends(get_current_user)
):
    """Page to view statistics about previous runs."""
    if current_user.active_area_name is None:
        response = RedirectResponse("/run_area", status_code=status.HTTP_303_SEE_OTHER)
        return response
    return templates.TemplateResponse("stats.html", {"request": request})


@app.get("/runs")
def runs_in_date_range(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: RunningDatabase = Depends(database),
    current_user: models.CurrentUser = Depends(get_current_user),
):
    """Runs completed during specified date range.

    Examples
    --------
    1. Specify both start and end dates.
        /runs?start_date=2018-01-01&end_date=2021-12-31
    2. Only the start is specified, so get all runs after that date (inclusive).
        /runs?start_date=2018-01-01
    3. Only the end is specified, so get all runs prior to that date (inclusive).
        /runs?end_date=2021-12-31
    4. No arguments, get all runs ever.
        /runs
    """
    run_area = current_user.make_run_area()
    return db.runs_in_date_range(run_area, start_date=start_date, end_date=end_date)


def diff_in_days(start_date: str, end_date: str) -> int:
    """Difference in days between two dates.

    Expected format is YYYY-MM-DD although this will work with other formats
    as long as time zones are the same if present.
    """
    assert start_date <= end_date
    secs_diff = (pd.Timestamp(end_date) - pd.Timestamp(start_date)).total_seconds()
    return int(secs_diff / (60 * 60 * 24))


@app.get("/runs_for_animation")
def runs_for_animation(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: RunningDatabase = Depends(database),
    current_user: models.CurrentUser = Depends(get_current_user),
):
    """Runs in time order ready for animation."""
    run_area = current_user.make_run_area()
    traversals = db.runs_in_date_range(
        run_area, start_date=start_date, end_date=end_date
    )
    if not traversals:
        return []

    runs_by_date = []
    current_date = None
    current_run = []
    for traversal in traversals:
        if current_date is None:
            current_date = traversal["date"]
            current_run.append(traversal)
        elif current_date == traversal["date"]:
            current_run.append(traversal)
        else:
            runs_by_date.append(
                {
                    "date": current_date,
                    "diff_days": diff_in_days(current_date, traversal["date"]),
                    "run": current_run,
                }
            )
            current_date = traversal["date"]
            current_run = [traversal]

    runs_by_date.append(
        {
            "date": current_date,
            "diff_days": 0,  # nothing to wait for after last run
            "run": current_run,
        }
    )
    return runs_by_date


@app.get("/first_seen")
def first_seen(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: RunningDatabase = Depends(database),
    current_user: models.CurrentUser = Depends(get_current_user),
):
    """For each segment covered, find the first date on which it was traversed."""
    run_area = current_user.make_run_area()
    first_traversals = db.first_seen(run_area, start_date=start_date, end_date=end_date)
    if not first_traversals:
        return {}

    first_seen_by_date = {}
    current_date = None
    current_segments = []
    for traversal in first_traversals:
        if current_date is None:
            current_date = traversal["date"]
            current_segments.append(traversal["segment_id"])
        elif current_date == traversal["date"]:
            current_segments.append(traversal["segment_id"])
        else:
            first_seen_by_date[current_date] = current_segments
            current_date = traversal["date"]
            current_segments = [traversal["segment_id"]]

    first_seen_by_date[current_date] = current_segments
    return first_seen_by_date


@app.get("/traversals")
def traversals_in_date_range(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: RunningDatabase = Depends(database),
    current_user: models.CurrentUser = Depends(get_current_user),
):
    """Runs completed during specified date range.

    Examples
    --------
    1. Specify both start and end dates.
        /traversals?start_date=2018-01-01&end_date=2021-12-31
    2. Only the start is specified, so get all runs after that date (inclusive).
        /traversals?start_date=2018-01-01
    3. Only the end is specified, so get all runs prior to that date (inclusive).
        /traversals?end_date=2021-12-31
    4. No arguments, get total number of traversals ever.
        /traversals
    """
    run_area = current_user.make_run_area()
    return db.number_of_traversals_in_date_range(
        run_area, start_date=start_date, end_date=end_date
    )


def distance_at_end_of_segment(
    segment_length_metres: float,
    distance_along_segment_metres: float,
    proportion_threshold: float = 0.95,
) -> bool:
    """Check if a distance should be considered at the end of a segment."""
    return distance_along_segment_metres > segment_length_metres * proportion_threshold


@app.post("/route")
async def route(
    snap_data: models.SnapDataForRouting,
    db: RunningDatabase = Depends(database),
    current_user: models.CurrentUser = Depends(get_current_user),
):
    """Route between two snapped points."""
    graph = get_routing_graph(current_user, db)
    if snap_data.from_segment_id == snap_data.to_segment_id:
        segment_key = (
            snap_data.from_segment_start_node,
            snap_data.from_segment_end_node,
            0,
        )
        segment_length_metres = graph.edges[segment_key]["length"]
        segment = models.SegmentTraversal(
            segment_id=snap_data.to_segment_id,
            start_distance_metres=snap_data.from_segment_distance_along_segment_metres,
            end_distance_metres=snap_data.to_segment_distance_along_segment_metres,
            starts_at_end=distance_at_end_of_segment(
                segment_length_metres,
                snap_data.from_segment_distance_along_segment_metres,
            ),
            ends_at_end=distance_at_end_of_segment(
                segment_length_metres,
                snap_data.to_segment_distance_along_segment_metres,
            ),
        )
        return {"route": [segment.dict()]}

    from_segment_nodes = {
        snap_data.from_segment_start_node,
        snap_data.from_segment_end_node,
    }
    to_segment_nodes = {snap_data.to_segment_start_node, snap_data.to_segment_end_node}

    from_segment_length_metres = graph[snap_data.from_segment_start_node][
        snap_data.from_segment_end_node
    ][0]["length"]
    to_segment_length_metres = graph[snap_data.to_segment_start_node][
        snap_data.to_segment_end_node
    ][0]["length"]

    common_nodes = from_segment_nodes.intersection(to_segment_nodes)
    if common_nodes:
        common_node = common_nodes.pop()
        route = []

        from_segment_to_end = common_node == snap_data.from_segment_end_node
        if from_segment_to_end:
            route.append(
                models.SegmentTraversal(
                    segment_id=snap_data.from_segment_id,
                    start_distance_metres=snap_data.from_segment_distance_along_segment_metres,  # noqa: E501
                    end_distance_metres=from_segment_length_metres,
                    starts_at_end=False,
                    ends_at_end=True,
                )
            )
        else:
            route.append(
                models.SegmentTraversal(
                    segment_id=snap_data.from_segment_id,
                    start_distance_metres=snap_data.from_segment_distance_along_segment_metres,  # noqa: E501
                    end_distance_metres=0.0,
                    starts_at_end=False,
                    ends_at_end=False,
                )
            )

        to_segment_from_start = common_node == snap_data.to_segment_start_node
        if to_segment_from_start:
            route.append(
                models.SegmentTraversal(
                    segment_id=snap_data.to_segment_id,
                    start_distance_metres=0.0,
                    end_distance_metres=snap_data.to_segment_distance_along_segment_metres,  # noqa: E501
                    starts_at_end=False,
                    ends_at_end=distance_at_end_of_segment(
                        to_segment_length_metres,
                        snap_data.to_segment_distance_along_segment_metres,
                    ),
                )
            )
        else:
            route.append(
                models.SegmentTraversal(
                    segment_id=snap_data.to_segment_id,
                    start_distance_metres=to_segment_length_metres,
                    end_distance_metres=snap_data.to_segment_distance_along_segment_metres,  # noqa: E501
                    starts_at_end=True,
                    ends_at_end=False,
                )
            )
        return {"route": [segment.dict() for segment in route]}

    # want to the true shortest paths, so try all pairs of nodes
    node_pairs = [
        (
            snap_data.from_segment_start_node,
            snap_data.to_segment_start_node,
            {
                "start_distance_metres": snap_data.from_segment_distance_along_segment_metres,  # noqa: E501
                "end_distance_metres": 0.0,
                "starts_at_end": False,
                "ends_at_end": False,
            },
            {
                "start_distance_metres": 0.0,
                "end_distance_metres": snap_data.to_segment_distance_along_segment_metres,  # noqa: E501
                "starts_at_end": False,
                "ends_at_end": False,
            },
        ),
        (
            snap_data.from_segment_start_node,
            snap_data.to_segment_end_node,
            {
                "start_distance_metres": snap_data.from_segment_distance_along_segment_metres,  # noqa: E501
                "end_distance_metres": 0.0,
                "starts_at_end": False,
                "ends_at_end": False,
            },
            {
                "start_distance_metres": to_segment_length_metres,
                "end_distance_metres": snap_data.to_segment_distance_along_segment_metres,  # noqa: E501
                "starts_at_end": False,
                "ends_at_end": False,
            },
        ),
        (
            snap_data.from_segment_end_node,
            snap_data.to_segment_start_node,
            {
                "start_distance_metres": snap_data.from_segment_distance_along_segment_metres,  # noqa: E501
                "end_distance_metres": from_segment_length_metres,
                "starts_at_end": False,
                "ends_at_end": True,
            },
            {
                "start_distance_metres": 0.0,
                "end_distance_metres": snap_data.to_segment_distance_along_segment_metres,  # noqa: E501
                "starts_at_end": False,
                "ends_at_end": False,
            },
        ),
        (
            snap_data.from_segment_end_node,
            snap_data.to_segment_end_node,
            {
                "start_distance_metres": snap_data.from_segment_distance_along_segment_metres,  # noqa: E501
                "end_distance_metres": from_segment_length_metres,
                "starts_at_end": False,
                "ends_at_end": True,
            },
            {
                "start_distance_metres": to_segment_length_metres,
                "end_distance_metres": snap_data.to_segment_distance_along_segment_metres,  # noqa: E501
                "starts_at_end": False,
                "ends_at_end": False,
            },
        ),
    ]
    min_length_metres = float("inf")
    min_length_path = []
    min_path_start_segment_data = min_path_end_segment_data = None
    for source, target, start_segment_data, end_segment_data in node_pairs:
        try:
            nodes_in_route = shortest_path(
                graph,
                source=source,
                target=target,
                weight="length",
            )
            edges = list(zip(nodes_in_route, nodes_in_route[1:]))

            # incorporate ending the start segment and starting the end segment
            start_length_metres = abs(
                start_segment_data["start_distance_metres"]
                - start_segment_data["end_distance_metres"]
            )
            start_length_metres += abs(
                end_segment_data["start_distance_metres"]
                - end_segment_data["end_distance_metres"]
            )

            path_length_metres = start_length_metres + sum(
                graph.edges[(u, v, 0)]["length"] for u, v in edges
            )
            if path_length_metres < min_length_metres:
                min_length_metres = path_length_metres
                min_length_path = edges
                min_path_start_segment_data = start_segment_data
                min_path_end_segment_data = end_segment_data
        except Exception:
            pass

    # no path for any node pairing between the segments we're routing between
    if not min_length_path:
        return {"route": []}

    # start segment
    route = [
        models.SegmentTraversal(
            segment_id=snap_data.from_segment_id, **min_path_start_segment_data
        )
    ]

    # intermediate segments, which must exist since we did the 2 segment route
    # case earlier
    for start_node, end_node in min_length_path:
        route.append(
            models.FullSegmentTraversal(
                start_node=start_node,
                end_node=end_node,
                length_metres=graph.edges[(start_node, end_node, 0)]["length"],
            )
        )

    # end segment
    route.append(
        models.SegmentTraversal(
            segment_id=snap_data.to_segment_id, **min_path_end_segment_data
        )
    )
    return {"route": [segment.dict() for segment in route]}


@app.get("/run_linestrings")
def run_linestrings(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: RunningDatabase = Depends(database),
    current_user: models.CurrentUser = Depends(get_current_user),
):
    """Retrieve run linestrings stored in the database in a date range."""
    run_area = current_user.make_run_area()
    return db.run_linestrings_in_date_range(
        run_area, start_date=start_date, end_date=end_date
    )


@app.get("/run_area", response_class=HTMLResponse)
def run_area(
    request: Request, current_user: models.CurrentUser = Depends(get_current_user)
):
    """Page to create a running area."""
    return templates.TemplateResponse("run_area.html", {"request": request})


@app.get("/geometry")
async def get_run_area_geometry(
    db: RunningDatabase = Depends(database),
    current_user: models.CurrentUser = Depends(get_current_user),
):
    """Retrieve geometry of currently active area."""
    return db.get_run_area_geometry(
        current_user.username, current_user.active_area_name
    )


def retrieve_graph_and_geometry(
    db: RunningDatabase,
    username: str,
    run_area_geometry: models.RunAreaGeometry,
    has_active_area: bool = False,
):
    """Get OSM graph and geometry data for the area selected."""
    # when using osmnx we need (x, y) coordinates
    points = [
        (lat_lng["lng"], lat_lng["lat"]) for lat_lng in run_area_geometry.geometry
    ]
    polygon = Polygon(points)
    logger.info(f"Preprocessing running network area {run_area_geometry.area_name}")
    output = preprocess_running_network(polygon)
    logger.info(f"Got data for area {run_area_geometry.area_name}, saving in database")

    # confusingly we store the polygon in WKT format with (lat, lng) coordinates
    lat_lngs = [
        (lat_lng["lat"], lat_lng["lng"]) for lat_lng in run_area_geometry.geometry
    ]
    run_area_polygon = Polygon(lat_lngs)
    run_area = models.RunArea(
        username=username,
        area_name=run_area_geometry.area_name,
        polygon=run_area_polygon.wkt,
        active=False,
    )
    db.insert_run_area(run_area)
    db.insert_run_area_graph(username, run_area.area_name, output["graph"])
    db.insert_run_area_geometry(username, run_area.area_name, output["geometry"])

    if not has_active_area:
        # only switch active run if this user doesn't already have one
        db.set_active_area_for_user(username, run_area_geometry.area_name)
    return


@app.post("/create_run_area")
async def create_run_area(
    run_area_geometry: models.RunAreaGeometry,
    background_tasks: BackgroundTasks,
    response: Response,
    db: RunningDatabase = Depends(database),
    current_user: models.CurrentUser = Depends(get_current_user),
):
    """Create a new run area for the user."""
    has_active_area = current_user.active_area_name is not None
    background_tasks.add_task(
        retrieve_graph_and_geometry,
        db,
        current_user.username,
        run_area_geometry,
        has_active_area=has_active_area,
    )
    response.status_code = status.HTTP_202_ACCEPTED
    return {"message": "Retrieving graph and geometry"}


@app.post("/remove_run_area")
async def remove_run_area(
    run_area: models.RunArea,
    response: Response,
    db: RunningDatabase = Depends(database),
    current_user: models.CurrentUser = Depends(get_current_user),
):
    """Remove a run area."""
    db.remove_run_area(run_area)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.post("/sub_run_area")
async def sub_run_area(
    sub_run_area_name: models.SubRunAreaName,
    db: RunningDatabase = Depends(database),
    current_user: models.CurrentUser = Depends(get_current_user),
) -> models.SubRunArea:
    """Get all data about a sub run area."""
    sub_run_area = models.SubRunArea(
        username=current_user.username,
        area_name=current_user.active_area_name,
        sub_area_name=sub_run_area_name.name,
    )
    return db.get_sub_run_area(sub_run_area)


@app.get("/sub_run_areas")
async def sub_run_areas(
    db: RunningDatabase = Depends(database),
    current_user: models.CurrentUser = Depends(get_current_user),
) -> List[models.SubRunArea]:
    """Get all sub run areas in a run area."""
    run_area = models.BaseRunArea(
        username=current_user.username, area_name=current_user.active_area_name
    )
    return db.get_sub_run_areas(run_area)


@app.post("/insert_sub_run_area")
async def insert_sub_run_area(
    sub_run_area_geometry: models.SubRunAreaGeometry,
    response: Response,
    db: RunningDatabase = Depends(database),
    current_user: models.CurrentUser = Depends(get_current_user),
):
    """Store a sub run area."""

    # convert from a list of lat lngs to a WKT representation
    lat_lngs = [
        (lat_lng["lat"], lat_lng["lng"]) for lat_lng in sub_run_area_geometry.geometry
    ]
    sub_run_area_polygon = Polygon(lat_lngs).wkt

    sub_run_area = models.SubRunArea(
        username=current_user.username,
        area_name=current_user.active_area_name,
        sub_area_name=sub_run_area_geometry.sub_area_name,
        polygon=sub_run_area_polygon,
    )
    try:
        db.insert_sub_run_area(sub_run_area)
        response.status_code = status.HTTP_200_OK
    except exceptions.SubRunAreaExistsError:
        response.status_code = status.HTTP_409_CONFLICT


@app.post("/remove_sub_run_area")
async def remove_sub_run_area(
    sub_run_area: models.SubRunArea,
    response: Response,
    db: RunningDatabase = Depends(database),
    current_user: models.CurrentUser = Depends(get_current_user),
):
    """Remove a sub run area."""
    db.remove_sub_run_area(sub_run_area)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.post("/upload_run")
async def upload_run(
    response: Response,
    uploaded_file: UploadFile = File(...),
    db: RunningDatabase = Depends(database),
    current_user: models.CurrentUser = Depends(get_current_user),
):
    """Upload and parse a run stored in a TCX file."""
    file_type_ok = check_file_type(uploaded_file)
    if not file_type_ok:
        response.status_code = status.HTTP_415_UNSUPPORTED_MEDIA_TYPE
        return

    raw_xml = await uploaded_file.read()
    try:
        linestring = gps_utils.parse_tcx_file(raw_xml)
        response.status_code = status.HTTP_200_OK
        return {"linestring": linestring}
    except gps_utils.XMLParsingError as e:
        response.status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
        return {"failure_reason": e.message, "raw_xml": e.raw_xml}


if __name__ == "__main__":
    mode = os.environ.get("RUNNING_APP_MODE", "DEV").upper()
    # only reload on changes in DEV mode
    reload = mode == "DEV"
    uvicorn.run("main:app", host="0.0.0.0", port=1234, reload=reload)
