"""Exceptions."""
from models import RunArea, SubRunArea


class UsernameExistsError(ValueError):
    """Username cannot be registered twice."""

    def __init__(self, username: str):
        self.username = username
        self.message = f"username={username} already exists"
        super().__init__(self.message)


class RunAreaExistsError(ValueError):
    """Run area cannot be registered twice."""

    def __init__(self, run_area: "RunArea"):
        self.run_area = run_area
        self.message = (
            f"area_name={run_area.area_name} for "
            f"username={run_area.username} already exists."
        )
        super().__init__(self.message)


class SubRunAreaExistsError(ValueError):
    """Sub run area cannot be registered twice."""

    def __init__(self, sub_run_area: "SubRunArea"):
        self.sub_run_area = sub_run_area
        self.message = (
            f"sub_area_name={sub_run_area.sub_area_name} in "
            f"run_area={sub_run_area.area_name} for"
            f"username={sub_run_area.username} already exists."
        )
        super().__init__(self.message)


class MissingPolygonError(ValueError):
    """Sub run area requires a polygon geometry in WKT format."""

    def __init__(self, sub_run_area: "SubRunArea"):
        self.sub_run_area = sub_run_area
        self.message = (
            f"sub_area_name={sub_run_area.sub_area_name} in "
            f"run_area={sub_run_area.area_name} for"
            f"username={sub_run_area.username} cannot be inserted as it "
            "does not have a polygon in WKT format."
        )
        super().__init__(self.message)
