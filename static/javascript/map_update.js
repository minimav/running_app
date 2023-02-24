let map,
  spatialIndex, // used to quickly determine which segments are in the current map view
  segmentData = {}, // properties of each segment
  segmentLayer = {}, // map layer in which segment polylines are placed
  spatialIndexKeysOfSegmentsInCurrentView = new Set(), // keys in spatial index of segments in the current map view
  segmentIds = new Set(), // ids of segments in the current route or to change their status in the network
  nodesToSpatialIndex = {}, // mapping from node pairs to key within spatial index
  segmentIdToSpatialIndexKey = {}, // mapping from segment ids to keys within spatial index
  ignoredSegments = new Set(), // segments not to be used for creating run routes
  autocompleter; // controls autocomplete search for segments

/** Store the current run. */
document.getElementById("submit").onclick = function () {
  if (segmentIds.size == 0) {
    populateAndShowModal({
      title: "Empty selection",
      content: "No segments currently selected.",
    });
  }

  const updateMap = fetch("/update_ignored_segments", {
    method: "POST",
    body: JSON.stringify({ segment_ids: Array.from(segmentIds) }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
  updateMap
    .then((response) => response.json())
    .then(() => {
      console.debug(segmentIds.size + " segments had their map status updated");
      segmentIds.forEach((segmentId) => {
        if (ignoredSegments.has(segmentId)) {
          ignoredSegments.delete(segmentId);
        } else {
          ignoredSegments.add(segmentId);
        }
      });
      reset();
    });
};

/** Create key from nodes from which to look up geometry.
 *
 * We always use a fixed ordering on the nodes and store the shortest
 * edge for that node pair (in either orientation).
 */
function createNodeKey(startNode, endNode) {
  if (startNode < endNode) {
    return startNode + "_" + endNode;
  } else {
    return endNode + "_" + startNode;
  }
}

/** Load GeoJSON data and populate the spatial index. */
function loadGeometry() {
  fetch("/geometry")
    .then((response) => response.json())
    .then((data) => {
      let minLengths = {},
        segmentIds = [];
      spatialIndex = new Flatbush(data.features.length);
      data.features.forEach((initialSegment) => {
        let segment = interpolateSegment(initialSegment, 10);
        let boundingBox = getBoundingBox(segment.geometry.coordinates);
        let spatialIndexKey = spatialIndex.add(
          boundingBox.minLng,
          boundingBox.minLat,
          boundingBox.maxLng,
          boundingBox.maxLat
        );
        let segmentId = segment["properties"]["segment_id"];
        segmentData[spatialIndexKey] = segment;
        segmentIdToSpatialIndexKey[segmentId] = spatialIndexKey;
        segmentIds.push(segmentId);
        let startNode = segment["properties"]["start_node"];
        let endNode = segment["properties"]["end_node"];
        let nodeKey = createNodeKey(startNode, endNode);
        // for edges with the same pair of nodes, we only want to use the shortest one
        // within routes
        if (
          minLengths[nodeKey] === undefined ||
          segment["properties"]["length_m"] < minLengths[nodeKey]
        ) {
          nodesToSpatialIndex[nodeKey] = spatialIndexKey;
          minLengths[nodeKey] = segment["properties"]["length_m"];
        }
      });
      spatialIndex.finish();
      showSegments();
      autocompleter = new AutoComplete(
        "autocomplete-segment-ids",
        segmentIds,
        zoomToSegment,
        5,
        100,
        "Search for segment IDs"
      );
      autocompleter.setup();
    });
}

/** Zoom to specific segment via its ID. */
function zoomToSegment(segmentId) {
  const spatialIndexKey = segmentIdToSpatialIndexKey[segmentId];
  const segmentGeometry = segmentLayer[spatialIndexKey];
  if (segmentGeometry === undefined) {
    // segment is not currently on the map, so retrieve its geometry -- without plotting yet --
    // in order to get a bounding box; plotting will occur via the onzoomend event on the map
    segmentGeometry = new L.Polyline(
      segmentData[spatialIndexKey]["geometry"]["coordinates"].map((x) => {
        return [x[1], x[0]];
      })
    );
  }
  map.fitBounds(segmentGeometry.getBounds());
}

/** Remove segments from the map based on their spatial index keys. */
function removeSegments(keys) {
  keys.forEach((key) => {
    try {
      map.removeLayer(segmentLayer[key]);
      delete segmentLayer[key];
    } catch (err) {}
  });
}

/** Get style to apply to a segment based on whether it is currently selected or not in update map mode. */
function getSegmentStyle(segmentId) {
  let color;
  if (ignoredSegments.has(segmentId) && segmentIds.has(segmentId)) {
    // segment was ignored previously but we want to unignore
    color = "#198754";
  } else if (ignoredSegments.has(segmentId)) {
    // segment currently being ignored with no change in status
    color = "black";
  } else if (segmentIds.has(segmentId)) {
    // segment not currently being ignored but we want to ignore in the future
    color = "#dc3545";
  } else {
    // default segment in network style
    color = "#6495ed";
  }
  return {
    color: color,
    weight: 3,
    opacity: 1.0,
    smoothFactor: 1,
  };
}

/** Search spatial index for keys of all segments currently in view. */
function getSpatialIndexKeysOfSegmentsInView(boundingBox) {
  if (spatialIndex === undefined) return new Set();

  let maxX = boundingBox._northEast.lng;
  let maxY = boundingBox._northEast.lat;
  let minX = boundingBox._southWest.lng;
  let minY = boundingBox._southWest.lat;
  return new Set(spatialIndex.search(minX, minY, maxX, maxY));
}

/** Remove segments which were in the old map view but no longer in view. */
function removeSegmentsNoLongerInView(spatialIndexKeysOfSegmentsInNewView) {
  const spatialIndexKeysOfSegmentsToRemove = new Set();
  spatialIndexKeysOfSegmentsInCurrentView.forEach((x) => {
    if (!spatialIndexKeysOfSegmentsInNewView.has(x)) {
      spatialIndexKeysOfSegmentsToRemove.add(x);
    }
  });
  console.debug(
    spatialIndexKeysOfSegmentsToRemove.size + " segments to remove"
  );
  removeSegments(spatialIndexKeysOfSegmentsToRemove);
}

/** Retain only spatial index keys of segments in the new map view which weren't previously.
 *
 * Also include ignored segments to make sure they get plotted when we're in update-map mode.
 * When recording runs, they will be correctly ignored later on.
 */
function filterToNewSpatialIndexKeys(spatialIndexKeysOfSegmentsInNewView) {
  let spatialIndexKeysOfNewSegmentsInView = new Set();
  spatialIndexKeysOfSegmentsInNewView.forEach((key) => {
    let segmentId = segmentData[key]["properties"]["segment_id"];
    if (
      !spatialIndexKeysOfSegmentsInCurrentView.has(key) ||
      ignoredSegments.has(segmentId)
    ) {
      spatialIndexKeysOfNewSegmentsInView.add(key);
    }
  });
  console.debug(spatialIndexKeysOfNewSegmentsInView.size + " segments to show");
  return spatialIndexKeysOfNewSegmentsInView;
}

/** Make sure segments in current route are on top of all other segments. */
function sendSegmentsToBack() {
  spatialIndexKeysOfSegmentsInCurrentView.forEach((key) => {
    try {
      segmentLayer[key].bringToBack();
    } catch (err) {}
  });
}

/** Show segments on the map currently in view.
 *
 * Only genuinely new segments which were not previously in view will be added.
 * Segments not in the new view but in view previously will be removed.
 */
function showSegments() {
  // don't show any segments at low zoom levels
  if (map.getZoom() <= 13) {
    try {
      // remove everything in the spatial index
      removeSegments(new Set([...Array(spatialIndex.numItems).keys()]));
      spatialIndexKeysOfSegmentsInCurrentView = new Set();
      return;
    } catch (err) {
      // spatial index doesn't exist yet
      return;
    }
  }

  let spatialIndexKeysOfSegmentsInNewView = getSpatialIndexKeysOfSegmentsInView(
    map.getBounds()
  );
  console.debug(
    spatialIndexKeysOfSegmentsInNewView.size + " segments in new view."
  );
  removeSegmentsNoLongerInView(spatialIndexKeysOfSegmentsInNewView);
  let spatialIndexKeysOfNewSegmentsInView = filterToNewSpatialIndexKeys(
    spatialIndexKeysOfSegmentsInNewView
  );

  // add new segments to the map
  spatialIndexKeysOfNewSegmentsInView.forEach((key) => {
    let segment = segmentData[key];
    let segmentId = segment["properties"]["segment_id"];

    if (segmentLayer[key] !== undefined) {
      // only occurs if we're in update-map mode and this is an ignored segment
      return;
    }

    let segmentPolyline = new L.Polyline(
      segment["geometry"]["coordinates"].map((x) => {
        return [x[1], x[0]];
      }),
      getSegmentStyle(segmentId)
    );

    segmentPolyline.on("click", function (e) {
      if (segmentIds.has(segmentId)) {
        segmentIds.delete(segmentId);
      } else {
        segmentIds.add(segmentId);
      }
      segmentPolyline.setStyle(getSegmentStyle(segmentId));
    });

    segmentPolyline.addTo(map);
    // reference this polyline using id from spatial index for easy removal
    segmentLayer[key] = segmentPolyline;
  });
  spatialIndexKeysOfSegmentsInCurrentView = spatialIndexKeysOfSegmentsInNewView;
  sendSegmentsToBack();
}

/** Remove geometries from a route data object */
function removeGeometries(obj, geometryNames) {
  geometryNames.forEach((geometryName) => {
    try {
      map.removeLayer(obj[geometryName]);
    } catch (err) {}
  });
}

/** Reset the styling of all segments in the current selection on the map. */
function resetSegments() {
  spatialIndexKeysOfSegmentsInCurrentView.forEach((key) => {
    let segmentId = segmentData[key]["properties"]["segment_id"];
    segmentLayer[key].setStyle(getSegmentStyle(segmentId));
  });
}

/** Reset when in or moving to update map mode. */
function reset() {
  segmentIds = new Set();
  // want to show ignored segments if not already being shown
  resetSegments();
  showSegments();
}

document.addEventListener("DOMContentLoaded", function (event) {
  map = L.map("map").setView([0, 0], 1);
  setupPanes(map);
  map.on("zoomend", function () {
    showSegments();
  });
  map.on("dragend", function () {
    showSegments();
  });
  map.on("moveend", function () {
    showSegments();
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  populateWithCurrentUserInfo(map);

  // populate ignored segments set prior to loading geometry
  fetch("/currently_ignored_segments")
    .then((response) => response.json())
    .then((data) => {
      data.forEach((d) => ignoredSegments.add(d));
      loadGeometry();
      populateWithCurrentUserInfo(map);
    });
});
