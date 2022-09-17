"""Utilities for working with GPS files.

Current support is for .tcx files as used by MapMyRun.
"""
from defusedxml import ElementTree


class XMLParsingError(Exception):
    """Error when parsing an XML file."""

    def __init__(self, message: str, raw_xml: str):
        self.message = message
        self.raw_xml = raw_xml


def parse_tcx_file(
    raw_xml: str,
    prefix: str = "{http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2}",
) -> str:
    """Parse an uploaded .tcx file."""
    try:
        parsed_xml = ElementTree.fromstring(raw_xml)
    except:
        raise XMLParsingError("Could not parse XML file", raw_xml)

    points = []
    for position_tag in parsed_xml.iter(f"{prefix}Trackpoint"):
        try:
            lat_tag, lng_tag = list(position_tag.find(f"{prefix}Position"))
            lat = float(lat_tag.text)
            lng = float(lng_tag.text)
            points.append((lat, lng))
        except TypeError:
            pass

    if not points:
        raise XMLParsingError("No co-ordinates found in XML file", raw_xml)

    formatted_points = ",".join([f"{lat} {lng}" for lat, lng in points])
    return f"LINESTRING({formatted_points})"
