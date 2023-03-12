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

// references to geometries created when uploading a run
let uploadedRunPolyline, uploadedStartPoint, uploadedEndPoint;

/** Whether routing should be used or not. */
function useRoutingBetweenSegments() {
  return document.getElementById("route-on-click").checked;
}

/** Whether to allow multiple runs per data. */
function allowMultipleRunsPerDate() {
  return document.getElementById("allow-multiple").checked;
}

/** Store the current run. */
document.getElementById("submit").onclick = function () {
  const date = document.getElementById("run-date").value;
  const distanceMiles =
    document.getElementById("current-distance").value / 1.609;
  const duration = document.getElementById("duration").value;
  const comments = document.getElementById("comments").value;

  const segmentTraversals = {};
  let currentSegmentId, currentDirection;
  routeData.forEach((data) => {
    (data.segmentIds ?? []).forEach(({ segmentId, direction }) => {
      const incrementCount =
        segmentId !== currentSegmentId || direction !== currentDirection;
      if (incrementCount) {
        // update the traversal count and the current segment we're on
        const currentCount = segmentTraversals[segmentId] ?? 0;
        segmentTraversals[segmentId] = currentCount + 1;
        currentSegmentId = segmentId;
        currentDirection = direction;
      }
    });
  });

  // create full run geometry, incorporating both routing and straight lines
  let linestringCoordStrings = [];
  routeData
    .flatMap((data) => data.routeFromPrevious ?? data.lineFromPrevious ?? [])
    .forEach((geometry) => {
      geometry._latlngs.forEach(({ lat, lng }) => {
        const { jitteredLat, jitteredLng } = jitter({
          lat,
          lng,
          jitterProb: 0.5,
          maxJitter: 0.000025,
        });
        linestringCoordStrings.push(`${jitteredLat} ${jitteredLng}`);
      });
    });
  const linestring = `LINESTRING(${linestringCoordStrings.join(", ")})`;

  if (distanceMiles === 0) {
    populateAndShowModal({
      title: "Submission error",
      content: "Route has no distance yet.",
    });
    return;
  } else if (duration.startsWith("00:00:00.00")) {
    populateAndShowModal({
      title: "Submission error",
      content: "Route has no duration yet.",
    });
    return;
  } else if (!validateDatetime(new Date(date))) {
    populateAndShowModal({
      title: "Submission error",
      content: "Date is invalid.",
    });
  }

  const payload = {
    date: date,
    distance_miles: distanceMiles,
    duration: duration,
    comments: comments,
    linestring: linestring,
    allow_multiple: allowMultipleRunsPerDate(),
    segment_traversals: segmentTraversals,
  };

  fetch("/store_run", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  })
    .then(async (response) => {
      const data = await response.json();
      if (!response.ok) {
        return Promise.reject(data.reason);
      }
      return data;
    })
    .then(() => {
      populateAndShowModal({
        title: "Submission success",
        content: `Run on ${date} with ${
          Object.keys(segmentTraversals).length
        } unique segments has been stored.`,
      });
      reset();
    })
    .catch((err) =>
      populateAndShowModal({
        title: "Submission error",
        content: err,
      })
    );
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

/** Get style to apply to a segment in the road network. */
function getSegmentStyle(segmentId) {
  return {
    color: "#6495ed",
    weight: 3,
    opacity: 1.0,
    smoothFactor: 1,
    pane: "network",
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
  // make sure we correctly ignore segments in the case where we switch between to record-run mode
  // prior to which we may have been displaying some ignored segments
  ignoredSegments.forEach((segmentId) => {
    let key = segmentIdToSpatialIndexKey[segmentId];
    if (segmentLayer[key] !== undefined) {
      spatialIndexKeysOfSegmentsToRemove.add(key);
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
      // deal with spatial index not being ready yet
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

    if (ignoredSegments.has(segmentId)) return;

    let segmentPolyline = new L.Polyline(
      segment["geometry"]["coordinates"].map((x) => {
        return [x[1], x[0]];
      }),
      getSegmentStyle()
    );

    segmentPolyline.addTo(map);
    // reference this polyline using id from spatial index for easy removal
    segmentLayer[key] = segmentPolyline;
  });
  spatialIndexKeysOfSegmentsInCurrentView = spatialIndexKeysOfSegmentsInNewView;
}

/** Set the current length back to zero. */
function resetRunStats() {
  document.getElementById("current-distance").value = "0.0";
  document.getElementById("current-speed").value = "-";
  document.getElementById("duration").value = "00:00:00.000";
}

const updateRunSpeed = (distanceMiles) => {
  const rawDuration = document.getElementById("duration").value;
  let durationMinutes = parseInt(rawDuration.slice(0, 2)) * 60;
  durationMinutes += parseInt(rawDuration.slice(3, 5));
  durationMinutes += parseInt(rawDuration.slice(6, 8)) / 60;
  durationMinutes += parseInt(rawDuration.slice(9)) / 6000;

  document.getElementById("current-speed").value =
    distanceMiles > 0 && durationMinutes > 0
      ? (durationMinutes / distanceMiles).toFixed(3)
      : "-";
};

/** Gets the current route distance. */
const getCurrentLengthKm = () => {
  let currentLengthKm = document.getElementById("current-distance").value;
  if (currentLengthKm == "") {
    currentLengthKm = 0.0;
  } else {
    currentLengthKm = parseFloat(currentLengthKm);
  }
  return currentLengthKm;
};

/** Update the current length due to either addition or removal of a segment from the selection. */
function updateLengthKm(lengthKm) {
  if (lengthKm === undefined || isNaN(lengthKm)) {
    console.log("Cannot update run distance due to undefined lengthKm value");
    return;
  }

  const newLengthKm = getCurrentLengthKm() + lengthKm;
  document.getElementById("current-distance").value = Math.max(
    0.0,
    newLengthKm
  ).toFixed(3);

  updateRunSpeed(newLengthKm / 1.609);
}

document.querySelector("#duration").addEventListener("change", () => {
  try {
    const distanceMiles =
      parseFloat(document.getElementById("current-distance").value) / 1.609;
    updateRunSpeed(distanceMiles);
  } catch (err) {}
});

/** Make sure that all ignored segments no longer have anything  */
function removeCurrentlySegmentCollection() {
  let keys = Array.from(ignoredSegments).map(
    (segmentId) => segmentIdToSpatialIndexKey[segmentId]
  );
  removeSegments(keys);
}

/** Remove geometries from a route data object */
function removeGeometries(obj, geometryNames) {
  geometryNames.forEach((geometryName) => {
    try {
      map.removeLayer(obj[geometryName]);
    } catch (err) {}
  });
}

// lifo quere (stack) for redoing undone clicks
let redoStack = [];

const addToRedoStack = (data) => {
  document.getElementById("redo").disabled = false;
  if (redoStack.length > 0) {
    // check that this data is compatible with the previous undo
    if (data.id !== redoStack[redoStack.length - 1].predecessorId) {
      redoStack = [];
    }
  }
  redoStack.push(data);
};

/** Remove km markers and labels. */
function removeKmMarkersAndLabels(oldDistanceKm, newDistanceKm) {
  var kmLabel = Math.floor(oldDistanceKm);
  while (kmLabel > newDistanceKm) {
    try {
      map.removeLayer(markersByKm[kmLabel].kmLabelText);
      map.removeLayer(markersByKm[kmLabel].kmMarker);
      delete markersByKm[kmLabel];
    } catch {}
    kmLabel -= 1;
  }
}

/** Undo the previous addition of segment(s) to the map. */
function undo() {
  if (routeData.length > 0) {
    const previousRouteData = routeData.pop();

    addToRedoStack(previousRouteData);

    removeGeometries(previousRouteData, [
      "clickedPoint",
      "snappedPoint",
      "snapLine",
      "lineFromPrevious",
      "routeFromPrevious",
    ]);
    const oldDistanceKm = getCurrentLengthKm();
    updateLengthKm(-previousRouteData.distanceKm ?? 0.0);
    const newDistanceKm = Math.max(
      oldDistanceKm - previousRouteData.distanceKm,
      0.0
    );
    removeKmMarkersAndLabels(oldDistanceKm, newDistanceKm);

    if (routeData.length > 0) {
      const newPreviousRouteData = routeData[routeData.length - 1];
      const props =
        routeData.length > 1
          ? { fillColor: "#dc3545", radius: 8 }
          : { radius: 8 };
      newPreviousRouteData.clickedPoint.setStyle(props);
      try {
        newPreviousRouteData.snappedPoint.setStyle(props);
      } catch (err) {
        // previous point did not have an associated snap
      }
    } else {
      document.getElementById("undo").disabled = true;
      document.getElementById("reset").disabled = true;
      document.getElementById("submit").disabled = true;
    }
  }
}

/** Reset the styling of all segments in the current selection on the map. */
function resetSegments() {
  spatialIndexKeysOfSegmentsInCurrentView.forEach((key) => {
    try {
      segmentLayer[key].setStyle(getSegmentStyle());
    } catch (err) {
      // this will fail in mode == "record-run" for ignored segments
    }
  });
}

/** Remove all geometry artefacts pertaining to an uploaded run */
const removeUploadedGeometries = () => {
  [uploadedRunPolyline, uploadedStartPoint, uploadedEndPoint].forEach(
    (geom) => {
      try {
        map.removeLayer(geom);
      } catch {}
    }
  );
};

/** Reset when in or moving to record run mode. */
function reset() {
  console.debug("Resetting segments");

  document.getElementById("undo").disabled = true;
  document.getElementById("reset").disabled = true;
  document.getElementById("submit").disabled = true;

  removeUploadedGeometries();

  segmentIds = new Set();

  routeData.forEach((data) => {
    removeGeometries(data, [
      "clickedPoint",
      "snappedPoint",
      "snapLine",
      "lineFromPrevious",
      "routeFromPrevious",
    ]);
  });
  routeData = [];
  removeKmMarkersAndLabels(getCurrentLengthKm(), 0.0);

  resetRunStats();
  // want to remove ignored segments...
  removeCurrentlySegmentCollection();
  // ...and style everything remaining in the default colour
  resetSegments();
}

/** Redo the last undone routing click. */
const redo = () => {
  const routeToRedo = redoStack.pop();

  if (redoStack.length === 0) {
    document.getElementById("redo").disabled = true;
  }

  // change routing to correct setting
  const routingCheckbox = document.getElementById("route-on-click");
  if (routeToRedo.lineFromPrevious !== undefined) {
    routingCheckbox.checked = false;
  } else if (routeToRedo.routeFromPrevious !== undefined) {
    routingCheckbox.checked = true;
  }

  // simulate mouse click, which will be deterministic - this is a bit lazy instead of adding
  // the artefacts that exist in this object back onto the map directly
  const previousLatLng = [
    routeToRedo.clickedPoint._latlng.lat,
    routeToRedo.clickedPoint._latlng.lng,
  ];
  map.fire("click", { latlng: L.latLng(previousLatLng) });
};

function findNearestSegmentAndPointOnIt({ lat, lng }, spatialIndexKeys) {
  let nearestSpatialIndexKey,
    nearestPoint,
    distanceAlongSegmentMetres,
    nearestIndex,
    minimumDistanceMetres = Infinity;

  spatialIndexKeys.forEach((key) => {
    let cumulativeDistanceMetres = 0,
      coordinates = segmentData[key]["geometry"]["coordinates"];

    coordinates.forEach(([otherLng, otherLat], index) => {
      const distanceMetres = haversineDistanceMetres(
        [lat, lng],
        [otherLat, otherLng]
      );

      if (index > 0) {
        const [previousLng, previousLat] = coordinates[index - 1];
        cumulativeDistanceMetres += haversineDistanceMetres(
          [previousLat, previousLng],
          [otherLat, otherLng]
        );
      }

      if (distanceMetres < minimumDistanceMetres) {
        nearestSpatialIndexKey = key;
        nearestPoint = { lat: otherLat, lng: otherLng };
        minimumDistanceMetres = distanceMetres;
        distanceAlongSegmentMetres = cumulativeDistanceMetres;
        nearestIndex = index;
      }
    });
  });
  return {
    spatialIndexKey: nearestSpatialIndexKey,
    point: nearestPoint,
    distanceMetres: minimumDistanceMetres,
    distanceAlongSegmentMetres: distanceAlongSegmentMetres,
    geometryIndex: nearestIndex,
  };
}

/** Use spatial index to get segments which are within a lat/lng buffer around a point. */
const getSegmentsNearbyToLatLng = (lat, lng, latBuffer, lngBuffer) => {
  const allNearbySpatialIndexKeys = spatialIndex.search(
    lng - lngBuffer,
    lat - latBuffer,
    lng + lngBuffer,
    lat + latBuffer
  );

  // remove ignored segments from consideration
  return allNearbySpatialIndexKeys.filter(
    (key) => !ignoredSegments.has(segmentData[key]["properties"]["segment_id"])
  );
};

/** Permanent tooltip with distance to go on top of a point. */
const createDistanceTooltip = (lat, lng, distanceKm) => {
  const props = {
    permanent: true,
    direction: "center",
    className: "text distance-tooltip",
  };
  return L.tooltip(props)
    .setContent(distanceKm)
    .setLatLng(new L.LatLng(lat, lng));
};

// TODO: clean up this function
// TODO: record better route overall, not just between current and previous point
let routeData = [
  /*
  {
    clickedPoint: geometry of location that user clicked
    snappedPoint: geometry of nearest snap
    snapLine: geometry joining location clicked to snapped point, might not be visible
    routeFromPrevious: geometry of routed line from previous
    lineFromPrevious: geometry of straight line from previous
    segmentIds: if routed, ordered segments from previous,
  }
  */
];
function snapToNetwork(event) {
  // extract lat/lng from user click event
  const lng = event.latlng.lng,
    lat = event.latlng.lat;

  const routing = document.getElementById("route-on-click").checked;

  const fillColor = routeData.length === 0 ? "#198754" : "#dc3545";
  const clickedPoint = new L.CircleMarker(event.latlng, {
    radius: 8,
    fillOpacity: 1.0,
    fillColor: fillColor,
    color: "blue",
    pane: "points",
  });

  // we'll add to this as we go depending on snapping results
  let newRouteData = { clickedPoint };

  // 100m buffer in a simple way not taking into account high/low latitudes
  let latBuffer = 0.001,
    lngBuffer = 0.001,
    factor = 0;
  let nearbySpatialIndexKeys = [];
  while (nearbySpatialIndexKeys.length === 0 && factor < 5) {
    nearbySpatialIndexKeys = getSegmentsNearbyToLatLng(
      lat,
      lng,
      latBuffer * Math.pow(2, factor),
      lngBuffer * Math.pow(2, factor)
    );
    factor += 1;
  }

  let snap, snappedPoint, snapLine;
  if (nearbySpatialIndexKeys.length === 0 && routing) {
    if (routing) {
      populateAndShowModal({
        title: "Snapping error",
        content:
          `No segments found within buffer around (${lat.toFixed(
            3
          )}, ${lng.toFixed(3)}). Try closer ` +
          `to the road network or unchecking 'Route between segments'.`,
      });
      return;
    } else {
      routeData.push({ clickedPoint });
    }
  } else if (nearbySpatialIndexKeys.length !== 0) {
    snap = findNearestSegmentAndPointOnIt({ lat, lng }, nearbySpatialIndexKeys);
    snappedPoint = new L.CircleMarker(
      new L.LatLng(snap.point.lat, snap.point.lng),
      {
        radius: 8,
        fillOpacity: 1.0,
        fillColor: fillColor,
        color: "blue",
        pane: "points",
      }
    );

    snapLine = new L.Polyline(
      [
        [snap.point.lat, snap.point.lng],
        [lat, lng],
      ],
      {
        color: "#fd7e14",
        weight: 3,
        opacity: 1.0,
        pane: "points",
      }
    );
  }

  newRouteData = {
    ...newRouteData,
    snappedPoint,
    snapLine,
    snapInfo: snap,
    id: uuidv4(),
  };

  // reset style of new set of intermediate clicked points and their snaps
  routeData.slice(1).forEach((data) => {
    const props = { fillColor: "blue", radius: 4 };
    data.clickedPoint.setStyle(props);
    try {
      data.snappedPoint.setStyle(props);
    } catch (err) {
      // no snap for the previous point
    }
  });

  // deal with first point case, where we can now undo and reset
  if (routeData.length === 0) {
    routing ? snappedPoint.addTo(map) : clickedPoint.addTo(map);
    routeData.push(newRouteData);
    document.getElementById("undo").disabled = false;
    document.getElementById("reset").disabled = false;
    document.getElementById("submit").disabled = false;
    return;
  }

  let previousRouteData = routeData[routeData.length - 1];

  // update predecessor id
  newRouteData = {
    ...newRouteData,
    predecessorId: previousRouteData.id,
  };

  if (routing && previousRouteData.snappedPoint !== undefined) {
    // clean up previous line if it was a straight line
    let distanceKm = 0.0;
    if (map.hasLayer(previousRouteData.lineFromPrevious)) {
      // determine where the start of our new overridden line should be
      const previousAgainRouteData = routeData[routeData.length - 2];
      const previousAgainPoint = map.hasLayer(
        previousAgainRouteData.snappedPoint
      )
        ? previousAgainRouteData.snappedPoint
        : previousAgainRouteData.clickedPoint;

      const overrideStraightLineCoords = [
        [previousAgainPoint._latlng.lat, previousAgainPoint._latlng.lng],
        [
          previousRouteData.snappedPoint._latlng.lat,
          previousRouteData.snappedPoint._latlng.lng,
        ],
      ];
      const overrideStraightLine = new L.Polyline(overrideStraightLineCoords, {
        color: "#dc3545",
        weight: 3,
        opacity: 1.0,
        pane: "route",
        dashArray: "10, 5",
        dashOffset: "0",
      });

      removeGeometries(previousRouteData, ["clickedPoint", "lineFromPrevious"]);

      const newPreviousDistanceKm =
        haversineDistanceMetres(...overrideStraightLineCoords) / 1000;
      const newPreviousRouteData = {
        ...previousRouteData,
        distanceKm: newPreviousDistanceKm,
        lineFromPrevious: overrideStraightLine,
      };

      distanceKm += newPreviousDistanceKm - previousRouteData.distanceKm;
      previousRouteData.snappedPoint.addTo(map);
      overrideStraightLine.addTo(map);

      // make sure to remove the old line's distance so that adding/removing
      // km labels will be done correctly
      const currentLengthKm = getCurrentLengthKm();
      const distanceKmPriorToStraightLine =
        currentLengthKm - previousRouteData.distanceKm;
      removeKmMarkersAndLabels(currentLengthKm, distanceKmPriorToStraightLine);
      addDistanceMarkersForStraightLine(
        newPreviousRouteData,
        distanceKmPriorToStraightLine
      );

      routeData.pop();
      routeData.push(newPreviousRouteData);
    }

    const previousSegment =
      segmentData[previousRouteData.snapInfo.spatialIndexKey]["properties"];
    const currentSegment = segmentData[snap.spatialIndexKey]["properties"];

    const payload = {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from_segment_id: previousSegment["segment_id"],
        from_segment_distance_along_segment_metres:
          previousRouteData.snapInfo.distanceAlongSegmentMetres,
        from_segment_start_node: previousSegment["start_node"],
        from_segment_end_node: previousSegment["end_node"],
        to_segment_id: currentSegment["segment_id"],
        to_segment_distance_along_segment_metres:
          snap.distanceAlongSegmentMetres,
        to_segment_start_node: currentSegment["start_node"],
        to_segment_end_node: currentSegment["end_node"],
      }),
    };
    fetch("/route", payload)
      .then((response) => response.json())
      .then((data) => {
        // we'll construct a full geometry of the route returned
        const routeCoordinates = [];

        // each segment touched will be count as a traversal, consecutive same segments
        // will be ignored unless we've changed direction on the segment
        const routeSegmentIds = [];

        data.route.forEach((routeSegment, index) => {
          const forwardsDirection =
            routeSegment.start_distance_metres <
            routeSegment.end_distance_metres;

          let spatialIndexKey, allCoords, segmentId;
          try {
            segmentId = routeSegment.segment_id;
            spatialIndexKey = segmentIdToSpatialIndexKey[segmentId];
            const segment = segmentData[spatialIndexKey];
            allCoords = switchCoords(segment["geometry"]["coordinates"]);
          } catch (err) {
            const nodeKey = createNodeKey(
              routeSegment.start_node,
              routeSegment.end_node
            );
            spatialIndexKey = nodesToSpatialIndex[nodeKey];
            allCoords = switchCoords(
              segmentData[spatialIndexKey]["geometry"]["coordinates"]
            );
            segmentId = segmentData[spatialIndexKey].properties.segment_id;
          }

          var distanceOnSegmentKm;
          if (index === 0 && data.route.length === 1) {
            // within segment case
            const slicedCoords = forwardsDirection
              ? allCoords.slice(
                  previousRouteData.snapInfo.geometryIndex,
                  snap.geometryIndex + 1
                )
              : allCoords
                  .slice(
                    snap.geometryIndex,
                    previousRouteData.snapInfo.geometryIndex + 1
                  )
                  .reverse();

            routeCoordinates.push(...slicedCoords);
            distanceOnSegmentKm =
              Math.abs(
                routeSegment.end_distance_metres -
                  routeSegment.start_distance_metres
              ) / 1000;
          } else if (index === 0) {
            // start segment case
            const slicedCoords =
              routeSegment.end_distance_metres === 0.0
                ? allCoords
                    .slice(0, previousRouteData.snapInfo.geometryIndex + 1)
                    .reverse()
                : allCoords.slice(previousRouteData.snapInfo.geometryIndex);

            routeCoordinates.push(...slicedCoords);
            distanceOnSegmentKm =
              Math.abs(
                routeSegment.end_distance_metres -
                  routeSegment.start_distance_metres
              ) / 1000;
          } else if (index === data.route.length - 1) {
            // end segment case
            const slicedCoords =
              routeSegment.start_distance_metres === 0.0
                ? allCoords.slice(0, snap.geometryIndex + 1)
                : allCoords.slice(snap.geometryIndex).reverse();

            routeCoordinates.push(...slicedCoords);
            distanceOnSegmentKm =
              Math.abs(
                routeSegment.end_distance_metres -
                  routeSegment.start_distance_metres
              ) / 1000;
          } else {
            // intermediate segment case - figure out whether we traversed this segment
            // in the opposite direction to the geometry
            const matchingDistanceMetres = haversineDistanceMetres(
              allCoords[0],
              routeCoordinates[routeCoordinates.length - 1]
            );
            matchingDistanceMetres < 5
              ? routeCoordinates.push(...allCoords)
              : routeCoordinates.push(...allCoords.reverse());

            distanceOnSegmentKm = routeSegment.length_metres / 1000;
          }
          distanceKm += distanceOnSegmentKm;
          routeSegmentIds.push({
            segmentId,
            direction: forwardsDirection,
            distanceOnSegmentKm,
          });
        });

        const routeLine = new L.Polyline(routeCoordinates, {
          color: "blue",
          weight: 3,
          opacity: 1.0,
          pane: "route",
        });

        newRouteData = {
          ...newRouteData,
          routeFromPrevious: routeLine,
          distanceKm,
          segmentIds: routeSegmentIds,
        };
        routeLine.addTo(map);
        snappedPoint.addTo(map);
        addDistanceMarkersForRouting(newRouteData);
        routeData.push(newRouteData);
        updateLengthKm(distanceKm);
      });
  } else {
    // figure out whether used snap or click at previous point
    const previousPoint = map.hasLayer(previousRouteData.snappedPoint)
      ? previousRouteData.snappedPoint
      : previousRouteData.clickedPoint;

    // not routing, so go to the location the user clicked
    const straightLine = new L.Polyline(
      [
        [previousPoint._latlng.lat, previousPoint._latlng.lng],
        [lat, lng],
      ],
      {
        color: "blue",
        weight: 3,
        opacity: 1.0,
        dashArray: "10, 5",
        dashOffset: "0",
      }
    );
    const distanceKm =
      haversineDistanceMetres(
        [previousPoint._latlng.lat, previousPoint._latlng.lng],
        [lat, lng]
      ) / 1000;

    newRouteData = {
      ...newRouteData,
      lineFromPrevious: straightLine,
      distanceKm: distanceKm,
    };
    straightLine.addTo(map);
    clickedPoint.addTo(map);
    addDistanceMarkersForStraightLine(newRouteData, getCurrentLengthKm());
    routeData.push(newRouteData);
    updateLengthKm(distanceKm);
  }
}

/** Container to store km distance markers. */
const markersByKm = {};

/** Add distance markers every km along a routed section of a run. */
const addDistanceMarkersForRouting = (newRouteData) => {
  var km = getCurrentLengthKm();
  newRouteData.segmentIds.forEach((segmentInfo, index) => {
    const segment =
      segmentData[segmentIdToSpatialIndexKey[segmentInfo.segmentId]];
    const segmentLengthKm = segment.properties.length_m / 1000;
    const kmAfterSegment = km + segmentInfo.distanceOnSegmentKm;

    // make sure not to label 0km!
    var kmLabel = Math.max(1, Math.ceil(km));
    const lastPossibleKmLabel = Math.floor(kmAfterSegment);
    const numCoordinates = segment.geometry.coordinates.length;
    while (kmLabel <= lastPossibleKmLabel) {
      // rather than calculate distances along the segment properly, just
      // linearly interpolate the index assuming roughly constant steps between
      // each lat-lng
      var lat, lng;
      const segmentFraction = (kmLabel - km) / segmentLengthKm;

      // here we need to take into account both the direction of travel on the
      // segment relative to its geometry and the start segment, for which we
      // cannot calculate the index shift from either the start/end of the
      // segment like we can for the intermediate and end segment cases
      var index;
      if (index === 0) {
        let previousRouteData = routeData[routeData.length - 1];
        let startSnapIndex = previousRouteData.snapInfo.geometryIndex;
        index = segmentInfo.direction
          ? startSnapIndex + Math.floor(numCoordinates * segmentFraction)
          : startSnapIndex - Math.floor(numCoordinates * segmentFraction);
      } else {
        index = segmentInfo.direction
          ? Math.floor(numCoordinates * segmentFraction)
          : Math.floor(numCoordinates * (1 - segmentFraction));
      }
      [lng, lat] = segment.geometry.coordinates[index];

      const kmMarker = new L.CircleMarker(new L.LatLng(lat, lng), {
        radius: 8,
        fillOpacity: 1.0,
        fillColor: "blue",
        color: "blue",
        pane: "points",
      });
      kmMarker.addTo(map);

      let kmLabelText = createDistanceTooltip(
        lat,
        lng,
        `${kmLabel.toFixed(0)}`
      );
      kmLabelText.addTo(map);

      markersByKm[kmLabel] = { kmLabelText, kmMarker };
      kmLabel += 1;
    }
    km = kmAfterSegment;
  });
};

/** Add distance markers every km along a new bit of straight line route. */
const addDistanceMarkersForStraightLine = (newRouteData, currentLengthKm) => {
  const newTotalLengthKm = currentLengthKm + newRouteData.distanceKm;

  var kmLabel = Math.max(1, Math.ceil(currentLengthKm));
  const latLngs = newRouteData.lineFromPrevious._latlngs;

  while (kmLabel < newTotalLengthKm) {
    // interpolate along the straight line
    const factor = (kmLabel - currentLengthKm) / newRouteData.distanceKm;
    const lat = latLngs[0].lat + factor * (latLngs[1].lat - latLngs[0].lat);
    const lng = latLngs[0].lng + factor * (latLngs[1].lng - latLngs[0].lng);

    const kmMarker = new L.CircleMarker(new L.LatLng(lat, lng), {
      radius: 8,
      fillOpacity: 1.0,
      fillColor: "blue",
      color: "blue",
      pane: "points",
    });
    kmMarker.addTo(map);

    let kmLabelText = createDistanceTooltip(lat, lng, `${kmLabel.toFixed(0)}`);
    kmLabelText.addTo(map);

    markersByKm[kmLabel] = { kmLabelText, kmMarker };
    kmLabel += 1;
  }
};

/* Upload a run via a .tcx file. */
const upload = () => {
  // remove old artefacts
  removeUploadedGeometries();
  const formData = new FormData();
  const file = document.getElementById("run-file").files[0];
  if (file === undefined) {
    populateAndShowModal({
      title: "No file selected",
      content: "A file must be selected before submitting.",
    });
    return;
  }
  formData.append("uploaded_file", file);

  const payload = {
    method: "POST",
    body: formData,
  };
  fetch("/upload_run", payload)
    .then((response) => {
      if (response.status === 415) {
        populateAndShowModal({
          title: "Invalid extension",
          content: `File ${file.name} has an extension for which uploads are not permitted.`,
        });
      } else if (response.status === 413) {
        populateAndShowModal({
          title: "Large file",
          content: "File was too large to upload.",
        });
      } else {
        return response.json();
      }
    })
    .then((data) => {
      const wkt = makeWktReader();
      const parsedRunWkt = wkt.read(data.linestring);
      const runLatLngs = parsedRunWkt.components.map((p) => {
        return L.latLng([p["x"], p["y"]]);
      });

      uploadedRunPolyline = new L.Polyline(runLatLngs, {
        color: "black",
        pane: "uploads",
      });
      uploadedStartPoint = new L.CircleMarker(runLatLngs[0], {
        radius: 8,
        fillOpacity: 1.0,
        fillColor: "#198754",
        color: "black",
        pane: "upload-points",
      });
      uploadedEndPoint = new L.CircleMarker(runLatLngs[runLatLngs.length - 1], {
        radius: 8,
        fillOpacity: 1.0,
        fillColor: "#dc3545",
        color: "black",
        pane: "upload-points",
      });

      uploadedRunPolyline.addTo(map);
      uploadedStartPoint.addTo(map);
      uploadedEndPoint.addTo(map);

      // TODO: snap?
    });
};

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
  map.on("click", snapToNetwork);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  // set run date as today's date for convenience
  document.getElementById("run-date").value = moment().format("YYYY-MM-DD");

  // populate ignored segments set prior to loading geometry
  fetch("/currently_ignored_segments")
    .then((response) => response.json())
    .then((data) => {
      data.forEach((d) => ignoredSegments.add(d));
      loadGeometry();
      populateWithCurrentUserInfo(map);
    });

  document
    .querySelector(".custom-file-input")
    .addEventListener("change", function (e) {
      const fileName = document.getElementById("run-file").files[0].name;
      const nextSibling = e.target.nextElementSibling;
      nextSibling.innerText = fileName;
    });
});
