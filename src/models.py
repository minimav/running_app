"""Models used in the app.
"""
from datetime import datetime
from typing import Dict, List, Optional

from pydantic import BaseModel, ValidationError, validator


def date_validation(date: str):
    """Valid dates have format YYYY-MM-DD."""
    valid_example = "2021-06-01"
    message = f"dates should have format YYYY-MM-DD, e.g. '{valid_example}'. "
    if len(date) != len(valid_example):
        raise ValidationError(message + f"Length was not {len(valid_example)}")

    try:
        datetime.strptime(date, "%Y-%m-%d")
        return date
    except ValueError:
        raise ValidationError(message)


class SegmentList(BaseModel):
    """List of segment ids."""

    segment_ids: List[str]


class SegmentCollection(BaseModel):
    """Segments for which to toggle their ignore status when calculating stats.

    Such segments could be out of scope because they are/were incorrectly
    tagged in OSM, or because they are artefacts of how complex junctions or
    multi-lane roads are digitised.

    Attributes
    ----------
    username: str
        Username of the user toggling these segments.
    area_name: str
        Name of the area in which these segments exist.
    segment_id: list[str]
        Segments for which to toggle their ignore status.
    """

    username: str
    area_name: str
    segment_ids: List[str]


class ValidationMixin:
    """Common validation across models."""

    @validator("date")
    def date_must_have_correct_format(cls, v):
        """Validate format of date field."""
        return date_validation(v)

    @validator("linestring")
    def linestring_must_have_correct_format(cls, v):
        """Validate format of linestring field.

        format is 'LINESTRING(lat_1 lng_1, lat_2 lng_2, ...)'.
        """
        if v is None:
            # should only occur for migration of old v1 schema data to v2
            return True

        correct_start = v.startswith("LINESTRING(")
        correct_end = v.endswith(")")
        num_commas = len([char for char in v if char == ","])
        num_spaces = len([char for char in v if char == " "])
        # one space per lat-lng, then one between each coord
        expected_punctuation = 2 * num_commas + 1 == num_spaces
        return all([correct_start, correct_end, expected_punctuation])


class LoggedRun(BaseModel, ValidationMixin):
    """A run to log towards the challenge.

    Currently only a single run per day is supported.

    Attributes
    ----------
    date: str
        In format "YYYY-MM-DD", the day on which the run was completed.
    distance_miles: float
        Distance of the run in miles.
    duration: Optional[str]
        Duration of the run in format 'HH:MM:SS.sss'.
    comments: Optional[str]
        Comments on the run.
    linestring: Optional[str]
         Geometry representing the run, usually from GPS tracking. Format is
         WKT linestring, e.g. "LINESTRING(lat_1 lng_1, lat_2 lng_2, ...)".
    allow_multiple: bool
        If True allows multiple runs to be logged for a given date.
    segment_traversals: dict[str, int]
        Keys are segment IDs, values are the number of traversals in the run.
    """

    date: str
    distance_miles: float
    duration: Optional[str]
    comments: Optional[str]
    linestring: Optional[str]
    allow_multiple: bool
    segment_traversals: Dict[str, int]


class BaseRunArea(BaseModel):
    """Basic named run area for a user."""

    username: str
    area_name: str


class RunArea(BaseRunArea):
    """Area selected by user in which to track run stats.

    Only one area can be concurrently active per user.
    """

    polygon: str
    active: bool


class SubRunAreaName(BaseModel):
    """Name of a sub run area."""

    name: str


class SwitchingRunArea(BaseRunArea):
    """Area selected by user to switch to.

    Includes `calling_url` so that we can refresh the page that the user
    switched on.
    """

    calling_url: str


class SubRunArea(BaseRunArea):
    """Sub run area that defines a subset of a bona fide area."""

    sub_area_name: str
    polygon: Optional[str]


class SnapDataForRouting(BaseModel):
    """Data from two snapped points to enable routing between them.

    Attributes
    ----------
    from_segment_id: str
        ID of segment to start routing from.
    from_segment_distance_along_segment_metres: float
        Distance along `previous_segment_id` in metres in direction of
        geometry.
    from_segment_start_node: int
        Start node of the segment we're routing from.
    from_segment_end_node: int
        End node of the segment we're routing from.
    to_segment_id: str
        ID of segment to end routing at.
    to_segment_distance_along_segment_metres: float
        Distance along `current_segment_id` in metres in direction of geometry.
    """

    from_segment_id: str
    from_segment_distance_along_segment_metres: float
    from_segment_start_node: int
    from_segment_end_node: int
    to_segment_id: str
    to_segment_distance_along_segment_metres: float
    to_segment_start_node: int
    to_segment_end_node: int


class SegmentTraversal(BaseModel):
    """Partial traversal of a segment found during routing."""

    segment_id: str
    start_distance_metres: float
    end_distance_metres: float
    starts_at_end: bool
    ends_at_end: bool


class FullSegmentTraversal(BaseModel):
    """A segment fully traversed as part of routing on the network."""

    start_node: int
    end_node: int
    length_metres: float


class RunV1(BaseModel, ValidationMixin):
    """Initial model reflecting `run` table schema.

    Only needed for migration from earlier app version.
    """

    date: str
    segment_id: str


class UploadedRunV1(BaseModel):
    """Initial model reflecting `uploaded_run` table schema.

    Only needed for migration from earlier app version.
    """

    date: str
    linestring: str


class Token(BaseModel):
    """Authentication token."""

    access_token: str
    token_type: str


class User(BaseModel):
    """Username of a user."""

    username: Optional[str] = None


class CurrentUser(User):
    """User with hashed password for verification and current area."""

    hashed_password: str
    active_area_name: Optional[str]
    polygon: Optional[str]

    def make_run_area(self) -> RunArea:
        """Create run area object from current user information"""
        run_area = RunArea(
            username=self.username,
            area_name=self.active_area_name,
            polygon=self.polygon,
            active=True,
        )
        return run_area


class RunAreaGeometry(BaseModel):
    """User drawn/uploaded geometry with which to create new run area."""

    area_name: str
    geometry: List[Dict[str, float]]


class SubRunAreaGeometry(BaseModel):
    """User drawn/uploaded geometry with which to create new sub run area."""

    sub_area_name: str
    geometry: List[Dict[str, float]]
