"""Retrieval and pre-processing of OSM data.
"""
import json
from typing import Any, Dict, List, Optional, Set, Union

import geopandas as gpd
import networkx as nx
import osmnx as ox
import shapely


def simplify_graph(graph, tolerance_m: float = 10.0, project_crs: int = 27700):
    """Merge nearby nodes while maintaining graph topology.

    We need to convert to a projected CRS with metre units in order for
    the merge buffer `tolerance_m` to make sense. We convert back to
    lat-lngs after the simplification has been completed.
    """
    projected_graph = ox.projection.project_graph(graph, to_crs=project_crs)
    simplified_projected_graph = ox.simplification.consolidate_intersections(
        projected_graph,
        tolerance=tolerance_m,
        rebuild_graph=True,
        dead_ends=True,
        reconnect_edges=True,
    )
    return ox.projection.project_graph(simplified_projected_graph, to_crs=4326)


def clean_osm_ids(osm_id: Union[str, int, List[int], List[str]]) -> str:
    """Clean up OSM ids from OSMnx.

    Describe here (list if ways joined as no junction).
    Still have multiple occurences for junction to junction parts.
    """
    if isinstance(osm_id, str):
        return osm_id
    if isinstance(osm_id, int):
        return str(osm_id)
    else:
        return "_".join([str(id) for id in osm_id])


def assign_segment_ids(df: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Assign correct segment ids given original OSM way ids from OSMnx."""
    df["segment_id"] = df.segment_id.apply(clean_osm_ids)
    # add suffix to distinguish junction to junction pieces
    df["segment_id"] = (
        df.segment_id + "_" + df.groupby("segment_id").cumcount().astype(str)
    )
    return df


def remove_motorways(df: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Remove motorway segments."""
    motorways = df.ref.str.contains("M").fillna(False)
    return df[~motorways].drop("ref", axis=1)


def filter_to_within_shape_file_polygon(
    segment_gdf: gpd.GeoDataFrame, shape_file_path: str
) -> gpd.GeoDataFrame:
    """Subset the data to within the polygon in the shape file."""
    shape_file_gdf = gpd.read_file(shape_file_path).to_crs(4326)
    return gpd.overlap(segment_gdf, shape_file_gdf, how="intersection")


def filter_highway_tags(
    df: gpd.GeoDataFrame, highway_tags_to_filter: Optional[Set[str]] = None
) -> gpd.GeoDataFrame:
    """Remove segments with any of the given highway tags."""
    if highway_tags_to_filter is None:
        highway_tags_to_filter = set()
    tag_mask = df.highway.apply(
        lambda x: any(tag in x for tag in highway_tags_to_filter)
    )
    return df[~tag_mask]


def make_sure_geometries_agree_with_start_end_nodes(graph, geometry) -> Dict[str, Any]:
    """Geojson segment coordinates should go from start node -> end node."""
    features = []
    for feature in geometry["features"]:
        start_node = feature["properties"]["start_node"]
        end_node = feature["properties"]["end_node"]

        # assign proper segment id if possible
        try:
            graph[start_node][end_node][0]["segment_id"] = feature["properties"][
                "segment_id"
            ]
        except KeyError:
            pass

        node_props = graph.nodes[start_node]
        start_node_lng_lat = [node_props["x"], node_props["y"]]

        equals_start_of_geom = (
            feature["geometry"]["coordinates"][0] == start_node_lng_lat
        )
        equals_end_of_geom = (
            feature["geometry"]["coordinates"][-1] == start_node_lng_lat
        )

        if not (equals_start_of_geom or equals_end_of_geom):
            continue

        if equals_end_of_geom:
            # need to reverse the geometry
            feature["geometry"]["coordinates"] = feature["geometry"]["coordinates"][
                ::-1
            ]

        features.append(feature)

    geometry["features"] = features
    return {
        "graph": graph,
        "geometry": geometry,
    }


def preprocess_running_network(
    polygon: shapely.geometry.Polygon,
    network_type: str = "drive",
    undirected: bool = True,
    highway_tags_to_filter: Optional[Set[str]] = None,
    simplify_kwargs: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Grab OSM network in box, format and store as GeoJSON for app."""
    graph = ox.graph_from_polygon(
        polygon=polygon,
        clean_periphery=False,
        network_type=network_type,
    )

    # generally we want an undirected graph - we can still route on it
    # but avoid having to visualise different segments with the same
    # geometry
    if undirected:
        graph = ox.utils_graph.get_undirected(graph)

    if simplify_kwargs is not None:
        graph = simplify_graph(graph, **simplify_kwargs)

    segment_gdf = ox.utils_graph.graph_to_gdfs(graph, nodes=False, edges=True)
    segment_gdf = filter_highway_tags(
        segment_gdf,
        highway_tags_to_filter=highway_tags_to_filter,
    )

    columns = ["osmid", "length", "geometry"]
    if "ref" in segment_gdf.columns:
        columns.append("ref")

    segment_gdf = (
        segment_gdf[columns]
        .reset_index()
        .drop("key", axis=1)
        .rename(
            columns={
                "osmid": "segment_id",
                "length": "length_m",
                "u": "start_node",
                "v": "end_node",
            }
        )
    )
    segment_gdf = assign_segment_ids(segment_gdf)
    if "ref" in segment_gdf.columns:
        segment_gdf = remove_motorways(segment_gdf)

    # to_json returns a string...
    geometry = json.loads(segment_gdf.to_json())
    refined_data = make_sure_geometries_agree_with_start_end_nodes(graph, geometry)

    # save the graph minus the geometry
    graph_data = nx.readwrite.json_graph.node_link_data(refined_data["graph"])
    links = []
    for link in graph_data["links"]:
        links.append({k: v for k, v in link.items() if k != "geometry"})
    graph_data["links"] = links

    return {"graph": graph_data, "geometry": refined_data["geometry"]}
