let map,
  segmentData = {}, // properties of each segment
  animationTimeouts = [], // timeout ids for stopping animation
  geometryLayer, // map layer in which segment/run geometries are placed
  ignoredSegments = new Set(), // segments which should not be considered part of the challenge
  totalLengthKm, // total length of segments
  statsByRunTable, // table displaying stats per run
  segmentsByDate, // mapping from date to segments run on that date
  segmentPolylinesById, // mapping from segment id to polyline on map
  drawingLayer, // layer containing polygon drawn by user
  currentPolygon, // the currently drawn polygon
  currentPolygonType, // ...and its type; circle, rectangle or polygon
  currentNetworkOptions = {
    minLengthM: 0,
    includeCulDeSacs: true,
  }, // options for which segments to include
  autocompleter; // controls autocomplete search for segments

let polygonColour = "#6495ed"; // colour for drawn polygons

// style for segments that have been run either in date range chosen or ever
const defaultStyle = {
  color: "#6495ed",
  weight: 2,
  opacity: 1.0,
  smoothFactor: 1,
};

// style for segments which have never been run
const defaultMissingStyle = {
  color: "#dc3545",
  weight: 2,
  opacity: 1.0,
  smoothFactor: 1,
};

const showAndAnimateButtonIds = [
  "animate-all-btn",
  "animate-in-date-range-btn",
  "show-all-btn",
  "show-in-date-range-btn",
];

/** Cache of data used in animations to allow (un)pausing without repeat fetches. */
var animationPauseCache = {
  url: "",
  data: [],
};

/** Total length in kilometres of all segments in the challenge.
 *
 * Segments have already been ignored prior to populating `segmentData`.
 */
function calculateTotalLengthKm() {
  var metres = 0.0;
  for (const [segmentId, segment] of Object.entries(segmentData)) {
    metres += segment["properties"]["length_m"];
  }
  return metres / 1000;
}

/** Length of specified segments in kilometres. */
function lengthKmOfSegmentsById(segmentIds) {
  var metres = 0.0;
  segmentIds.forEach((segmentId) => {
    if (segmentData[segmentId] !== undefined) {
      metres += segmentData[segmentId]["properties"]["length_m"];
    }
  });
  return metres / 1000;
}

/** Sum up the length in kilometres of segments including multiple traversals. */
function lengthKmOfSegments(segmentCounts) {
  var metres = 0.0;
  for (const [segmentId, count] of Object.entries(segmentCounts)) {
    if (segmentData[segmentId] !== undefined) {
      metres += count * segmentData[segmentId]["properties"]["length_m"];
    }
  }
  return metres / 1000;
}

/** Sum up the length in kilometres of segments without counting multiple traversals. */
function lengthKmOfUniqueSegments(segmentCounts) {
  var metres = 0.0;
  for (const [segmentId, count] of Object.entries(segmentCounts)) {
    if (segmentData[segmentId] !== undefined) {
      metres += segmentData[segmentId]["properties"]["length_m"];
    }
  }
  return metres / 1000;
}

/** Count occurrences of nodes across the full set of segments. */
function createNodeCounts(data) {
  let nodeCounts = {};
  $(data.features).each(function (key, segment) {
    let startNode = segment["properties"]["start_node"],
      endNode = segment["properties"]["end_node"];
    [startNode, endNode].forEach((node) => {
      if (nodeCounts[node] === undefined) {
        nodeCounts[node] = 1;
      } else {
        nodeCounts[node] += 1;
      }
    });
  });
  return nodeCounts;
}

/** Retrieve geometry and store in memory, ignoring segments correctly. */
function loadGeometry(minLengthM, includeCulDeSacs) {
  // reset in case we're reloading
  segmentData = {};
  fetch("/geometry")
    .then((response) => response.json())
    .then((data) => {
      let nodeCounts = createNodeCounts(data);
      let segmentIds = [];
      $(data.features).each(function (key, segment) {
        let segmentId = segment["properties"]["segment_id"],
          startNode = segment["properties"]["start_node"],
          endNode = segment["properties"]["end_node"];
        let isCulDeSac = nodeCounts[startNode] == 1 || nodeCounts[endNode] == 1;
        if (
          !ignoredSegments.has(segmentId) &&
          segment["properties"]["length_m"] >= minLengthM &&
          !(isCulDeSac && !includeCulDeSacs)
        ) {
          segmentData[segmentId] = segment;
          segmentIds.push(segmentId);
        }
      });
      console.log(
        Object.keys(segmentData).length + " segments have geometry loaded"
      );
      // calculate this once since we can only change the map on the other page
      totalLengthKm = calculateTotalLengthKm();
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

/** Get colour for a value along a gradient between two colours.
 *  From https://stackoverflow.com/a/27709336
 */
function getGradientColour(startColour, endColour, percent) {
  // strip the leading #
  startColour = startColour.replace(/^\s*#|\s*$/g, "");
  endColour = endColour.replace(/^\s*#|\s*$/g, "");

  // get colors
  var startRed = parseInt(startColour.substr(0, 2), 16),
    startGreen = parseInt(startColour.substr(2, 2), 16),
    startBlue = parseInt(startColour.substr(4, 2), 16);

  var endRed = parseInt(endColour.substr(0, 2), 16),
    endGreen = parseInt(endColour.substr(2, 2), 16),
    endBlue = parseInt(endColour.substr(4, 2), 16);

  // calculate new colour
  var diffRed = endRed - startRed;
  var diffGreen = endGreen - startGreen;
  var diffBlue = endBlue - startBlue;

  diffRed = (diffRed * percent + startRed).toString(16).split(".")[0];
  diffGreen = (diffGreen * percent + startGreen).toString(16).split(".")[0];
  diffBlue = (diffBlue * percent + startBlue).toString(16).split(".")[0];

  // ensure 2 digits by color
  if (diffRed.length == 1) diffRed = "0" + diffRed;
  if (diffGreen.length == 1) diffGreen = "0" + diffGreen;
  if (diffBlue.length == 1) diffBlue = "0" + diffBlue;
  return `#${diffRed}${diffGreen}${diffBlue}`;
}

/** Style for a polyline based on the number of times that segment has been traversed. */
function getStyleForNumTraversals(numTraversals, maxTraversals) {
  return {
    color: getGradientColour(
      "#FFFFFF",
      "#007bff",
      Math.min(1.0, numTraversals / maxTraversals)
    ),
    weight: 2,
    opacity: 1.0,
    smoothFactor: 1,
  };
}

/** Style for background of a polyline. */
function getStyleForBackgroundLine() {
  return {
    color: "black",
    weight: 3,
    opacity: 1.0,
    smoothFactor: 1,
  };
}

/** Refesh the statistics table in the lower right pane. */
function refreshStatsByRunTable() {
  return $("#stats-by-run-table").DataTable({
    lengthMenu: [
      [5, 10],
      [5, 10],
    ],
    pageLength: 5,
    pagingType: "full",
    columnDefs: [{ width: "35%", targets: 0 }],
  });
}

/** Re-enable buttons if geometry option supports animation. */
function resetAnimationButtons() {
  let geometryOption = document.querySelector(
    "[name=geometry-options]:checked"
  ).id;
  if (geometryOption === "runs" || geometryOption === "run_linestrings") {
    showAndAnimateButtonIds.forEach((id) => {
      document.getElementById(id).disabled = false;
    });
  }
  const animationControlButtonIds = [
    "play-animate-all-btn",
    "pause-animate-all-btn",
    "play-animate-in-date-range-btn",
    "pause-animate-in-date-range-btn",
  ];
  animationControlButtonIds.forEach((id) => {
    document.getElementById(id).style.display = "none";
  });
}

/** Remove currently displayed segments and associated stats. */
function removeSegments(removePolygon) {
  animationTimeouts.forEach((id) => {
    clearTimeout(id);
  });
  animationTimeouts = [];
  resetAnimationButtons();

  document.getElementById("animation-date").style.opacity = "0";
  segmentPolylinesById = {};
  showOverallStats();
  if (removePolygon || removePolygon === undefined) {
    removeDrawnPolygon();
  }

  try {
    map.removeLayer(geometryLayer);
    geometryLayer = undefined;
  } catch (err) {}

  statsByRunTable.destroy();
  document.getElementById("stats-by-run-rows").innerHTML = "";
  statsByRunTable = refreshStatsByRunTable();

  // refresh the geometry if options have changed
  let includeCulDeSacs = true,
    minLengthM = parseInt(
      document.getElementById("min-segment-length-m-slider").value
    );
  if (currentNetworkOptions.minLengthM !== minLengthM) {
    loadGeometry(minLengthM, includeCulDeSacs);
    currentNetworkOptions = {
      minLengthM: minLengthM,
      includeCulDeSacs: includeCulDeSacs,
    };
  }
}

/** Zoom to specific segment via its ID. */
function zoomToSegment(segmentId) {
  let segment = segmentData[segmentId];
  if (segment !== undefined) {
    segmentGeometry = new L.Polyline(
      segment["geometry"]["coordinates"].map((x) => {
        return [x[1], x[0]];
      })
    );
    map.fitBounds(segmentGeometry.getBounds());
  }
}

/** Display segments on the map. */
function showSegments(data, remove) {
  if (remove) {
    removeSegments(false);
  }
  var newSegments = [],
    segmentCounts = {};
  data.forEach((d) => {
    if (segmentCounts[d.segment_id] !== undefined) {
      segmentCounts[d.segment_id] += 1;
      return;
    } else {
      segmentCounts[d.segment_id] = 1;
    }
    let segment = segmentData[d.segment_id];
    try {
      let segmentPolyline = new L.Polyline(
        segment["geometry"]["coordinates"].map((x) => {
          return [x[1], x[0]];
        }),
        defaultStyle
      );
      segmentPolyline.bindTooltip("Segment Id: " + d.segment_id);
      segmentPolyline.on("click", function (e) {
        zoomToSegment(d.segment_id);
      });
      segmentPolylinesById[d.segment_id] = segmentPolyline;
      newSegments.push(segmentPolyline);
    } catch (err) {}
  });
  if (geometryLayer === undefined) {
    geometryLayer = L.layerGroup(newSegments);
  } else {
    newSegments.forEach((s) => s.addTo(geometryLayer));
  }
  geometryLayer.addTo(map);
  return {
    repeats: lengthKmOfSegments(segmentCounts),
    unique: lengthKmOfUniqueSegments(segmentCounts),
  };
}

/** Display segments on the map with their traversal counts. */
function showSegmentsWithTraversals(data, remove) {
  if (remove) {
    removeSegments(false);
  }
  var newSegments = [],
    segmentCounts = {};

  // distribution of segments run will be very right skewed, hence to get a good
  // colour distribution we simply use a lower cap than the true maximum number
  // of traversals (rather than make the gradient logarithmic, which would be a
  // more principled way of doing this)
  var maxTraversals = Math.max(...data.map((d) => d.num_traversals));
  let traversalCap = 10;
  maxTraversals = Math.min(traversalCap, maxTraversals);

  data.forEach((d) => {
    let segment = segmentData[d.segment_id];
    try {
      let coords = segment["geometry"]["coordinates"].map((x) => {
        return [x[1], x[0]];
      });
      let segmentPolyline = new L.Polyline(
        coords,
        getStyleForNumTraversals(d.num_traversals, maxTraversals)
      );
      let backgroundSegmentPolyline = new L.Polyline(
        coords,
        getStyleForBackgroundLine()
      );
      segmentPolyline.bindTooltip(
        "Segment Id: " + d.segment_id + ", " + d.num_traversals + " traversals"
      );
      segmentPolyline.on("click", function (e) {
        zoomToSegment(d.segment_id);
      });
      segmentCounts[d.segment_id] = d.num_traversals;
      segmentPolylinesById[d.segment_id] = segmentPolyline;

      // push background first so it is plotted underneath
      newSegments.unshift(backgroundSegmentPolyline);
      newSegments.push(segmentPolyline);
    } catch (err) {}
  });
  if (geometryLayer === undefined) {
    geometryLayer = L.layerGroup(newSegments);
  } else {
    newSegments.forEach((s) => s.addTo(geometryLayer));
  }
  geometryLayer.addTo(map);
  return {
    repeats: lengthKmOfSegments(segmentCounts),
    unique: lengthKmOfUniqueSegments(segmentCounts),
  };
}

/** Parse date range inputs and whether to show the number of traversals or not. */
function parseArgs(validateDates) {
  let startDateRaw = document.getElementById("start-date").value;
  let endDateRaw = document.getElementById("end-date").value;

  let startDate = new Date(startDateRaw);
  let endDate = new Date(endDateRaw);

  // only validate dates if the data to be shown is date-filtered
  if (validateDates) {
    if (!validateDatetime(startDate)) {
      populateAndShowModal({
        title: "Date error",
        content: "Start date is invalid.",
      });
      return;
    } else if (!validateDatetime(endDate)) {
      populateAndShowModal({
        title: "Date error",
        content: "End date is invalid.",
      });
      return;
    } else if (startDate > endDate) {
      populateAndShowModal({
        title: "Date error",
        content: `End date ${endDateRaw} is prior to start date ${startDateRaw}.`,
      });
      return;
    }
  }

  let geometryOption = document.querySelector(
    "[name=geometry-options]:checked"
  ).id;

  var animationEndpoint = null;
  if (geometryOption === "runs") {
    animationEndpoint = "runs_for_animation";
  } else if (geometryOption === "run_linestrings") {
    animationEndpoint = "run_linestrings";
  }

  return {
    startDate: startDateRaw,
    endDate: endDateRaw,
    geometryOption: geometryOption,
    geometryEndpoint: geometryOption === "missing" ? "runs" : geometryOption,
    animationEndpoint: animationEndpoint,
  };
}

/** Create HTML for the upper right pane showing overall statistics. */
function showOverallStats(lengthData) {
  const totalLengthKm =
    lengthData !== undefined ? lengthData["totalLengthKm"].toFixed(1) : "- ";
  const withRepeatsKm =
    lengthData !== undefined ? lengthData["repeats"].toFixed(1) : "- ";
  const uniqueLengthKm =
    lengthData !== undefined ? lengthData["unique"].toFixed(1) : "- ";
  const percProgress =
    lengthData !== undefined
      ? ((100 * lengthData["unique"]) / lengthData["totalLengthKm"]).toFixed(2)
      : "- ";
  const statsBox = `
    <div><span class="stat-label">Total length: </span>${totalLengthKm}km</div>
    <div><span class="stat-label">Length (with repeats): </span>${withRepeatsKm}km</div>
    <div><span class="stat-label">Unique length: </span>${uniqueLengthKm}km</div>
    <div><span class="stat-label">Progress shown: </span>${percProgress}%</div>
  `;
  document.getElementById("overall-stats-box-data").innerHTML = statsBox;
}

/** Group segments by date to facilitate calculating stats by date. */
function formatRunsByDate(segments) {
  if (segments.length === 0) return [];

  let currentDate,
    currentSegments = [],
    segmentsByDate = [];
  segments.forEach((s) => {
    if (currentDate === undefined) {
      currentDate = s.date;
      currentSegments.push(s);
    } else if (currentDate !== s.date) {
      segmentsByDate.push({
        date: currentDate,
        segments: currentSegments,
      });
      currentDate = s.date;
      currentSegments = [s];
    } else {
      currentSegments.push(s);
    }
  });
  segmentsByDate.push({
    date: currentDate,
    segments: currentSegments,
  });
  return segmentsByDate;
}

/** Get the data for segments run on a particular date. */
function getSegmentsOnDate(date) {
  if (segmentsByDate === undefined) {
    // case where we are animating
    return [];
  }
  for (i = 0; i < segmentsByDate.length; i++) {
    if (segmentsByDate[i]["date"] == date) {
      return segmentsByDate[i]["segments"];
    }
  }
  return [];
}

/** Highlight the run on the date whose stats row has just had a mouseover event. */
function highlightDate(cell) {
  const date = cell.innerHTML;
  const runOnDate = getSegmentsOnDate(date);
  runOnDate.forEach((traversal) => {
    let segmentPolyline = segmentPolylinesById[traversal.segment_id];
    segmentPolyline.bringToFront();
    segmentPolyline.setStyle({
      color: "orange",
    });
  });
}

/** Remove the highlight on the run on the date whose row has just had a mouseout event. */
function removeHighlightDate(cell) {
  const date = cell.innerHTML;
  const runOnDate = getSegmentsOnDate(date);
  runOnDate.forEach((traversal) => {
    let segmentPolyline = segmentPolylinesById[traversal.segment_id];
    segmentPolyline.setStyle(defaultStyle);
  });
}

//** Add highlight to the row in the stats table where the cursor is. */
function highlightRow(row) {
  row.style["background-color"] = "orange";
}

/** Remove the highlight from a row in the stats table. */
function removeHighlightRow(row) {
  row.style["background-color"] = "";
}

/** Populate the table containing stats per run in the lower right pane. */
function buildStatsByRunTable(statsByRun) {
  statsByRunTable.destroy();
  let tableBody = $("#stats-by-run-rows");
  statsByRun.forEach((s) => {
    var newRow =
      "<td onmouseover='highlightDate(this);' onmouseout='removeHighlightDate(this);'>" +
      s.date +
      "</td>";
    newRow += "<td>" + s.runLengthKm.toFixed(1) + "</td>";
    newRow += "<td>" + s.firstSeenLengthKm.toFixed(1) + "</td>";
    newRow += "<td>" + s.percNew.toFixed(1) + "%</td>";
    tableBody.append(
      "<tr onmouseover='highlightRow(this);' onmouseout='removeHighlightRow(this);'>" +
        newRow +
        "</tr>"
    );
  });
  statsByRunTable = refreshStatsByRunTable();
}

/** Calculate statistics for each run.
 *
 * `segmentsByDate` should be an array where each element correponds to a single date.
 */
function showStatsByRun(segmentsByDate, args) {
  let statsByRun = [];
  var endpoint = "/first_seen";
  if (args !== null) {
    endpoint += "?end_date=" + args.endDate;
  }
  fetch(endpoint)
    .then((response) => response.json())
    .then((firstSeen) => {
      segmentsByDate.forEach((runOnDate) => {
        let firstSeenOnDate =
          runOnDate.date in firstSeen ? firstSeen[runOnDate.date] : [];
        let allSegmentsOnDate = runOnDate.segments.map((t) => t.segment_id);
        let firstSeenLengthKm = lengthKmOfSegmentsById(firstSeenOnDate);
        let runLengthKm = lengthKmOfSegmentsById(allSegmentsOnDate);
        statsByRun.push({
          date: runOnDate.date,
          firstSeenLengthKm: firstSeenLengthKm,
          runLengthKm: runLengthKm,
          percNew: (100 * firstSeenLengthKm) / runLengthKm,
        });
      });
      buildStatsByRunTable(statsByRun);
    });
}

//** Check intersection of the current circle polygon with the start and end of a segment. */
function circleIntersection(startLat, startLng, endLat, endLng) {
  return (
    currentPolygon._containsPoint(
      map.latLngToLayerPoint(L.latLng(startLat, startLng))
    ) ||
    currentPolygon._containsPoint(
      map.latLngToLayerPoint(L.latLng(endLat, endLng))
    )
  );
}

/** Check intersection of the current rectangle polygon with the start and end of a segment. */
function rectangleIntersection(startLat, startLng, endLat, endLng) {
  function latCheck(lat) {
    return (
      currentPolygon._bounds._southWest.lat <= lat &&
      lat <= currentPolygon._bounds._northEast.lat
    );
  }
  function lngCheck(lng) {
    return (
      currentPolygon._bounds._southWest.lng <= lng &&
      lng <= currentPolygon._bounds._northEast.lng
    );
  }
  return (
    (latCheck(startLat) && lngCheck(startLng)) ||
    (latCheck(endLat) && lngCheck(endLng))
  );
}

/** Get data required to calculate intersection of polygon with lines.
 *
 * We return both the function that will perform the intersection and any arguments
 * required other than the start and end lat-lngs of the line with which we want to
 * intersect.
 */
function getPolygonArgs() {
  const args = [];
  var intersectionFunction;
  if (currentPolygonType == "circle") {
    intersectionFunction = circleIntersection;
  } else if (currentPolygonType == "rectangle") {
    intersectionFunction = rectangleIntersection;
  } else {
    intersectionFunction = Intersects.polygonLine;
    let points = [];
    let latLngs;
    if (currentPolygon._latlngs !== undefined) {
      latLngs = currentPolygon._latlngs[0];
    } else {
      const layerKey = Object.keys(currentPolygon._layers).pop();
      latLngs = currentPolygon._layers[layerKey]._latlngs[0];
    }
    latLngs.forEach((l) => {
      points.push(l.lat);
      points.push(l.lng);
    });
    args.push(points);
  }
  return {
    args: args,
    intersectionFunction: intersectionFunction,
  };
}

/** Filter run data to only those segments that intersect the currently drawn polygon (if there is one). */
function filterSegmentsToPolygon(inputSegments) {
  // first filter to segments which are included in the network according to current options
  let segments = inputSegments.filter(
    (r) => segmentData[r.segment_id] !== undefined
  );
  let uniqueSegmentIds = new Set();
  segments.forEach((s) => uniqueSegmentIds.add(s.segment_id));
  if (currentPolygon === undefined) {
    // no drawn polygon, use all segments
    return {
      segments: segments,
      totalLengthKm: totalLengthKm,
      missingSegmentIds: Object.keys(segmentData).filter(
        (segmentId) => !uniqueSegmentIds.has(segmentId)
      ),
      numSegmentsInIntersection: Object.keys(segmentData).length,
    };
  } else {
    let polygonData = getPolygonArgs();
    var intersectionLengthMetres = 0.0,
      numSegmentsInIntersection = 0;
    let intersectionSegmentIds = new Set(),
      missingSegmentIds = [];

    for (const [segmentId, segment] of Object.entries(segmentData)) {
      let coords = segment["geometry"]["coordinates"];
      let finalPoint = last(coords);
      let intersection = polygonData.intersectionFunction(
        ...polygonData.args,
        coords[0][1],
        coords[0][0],
        finalPoint[1],
        finalPoint[0],
        0.00000001 // tolerance in coordinate units
      );
      if (intersection) {
        numSegmentsInIntersection += 1;
        if (uniqueSegmentIds.has(segmentId)) {
          intersectionSegmentIds.add(segmentId);
        } else {
          missingSegmentIds.push(segmentId);
        }
        intersectionLengthMetres += segment["properties"]["length_m"];
      }
    }
    let filteredSegments = segments.filter((s) =>
      intersectionSegmentIds.has(s.segment_id)
    );
    return {
      segments: filteredSegments,
      totalLengthKm: intersectionLengthMetres / 1000,
      missingSegmentIds: missingSegmentIds,
      numSegmentsInIntersection: numSegmentsInIntersection,
    };
  }
}

/** Filter run linestrings to those which intersect the currently drawn polygon (if there is one). */
function filterLinestringsToPolygon(runLinestrings) {
  if (currentPolygon === undefined) {
    // no drawn polygon, use everything
    return runLinestrings;
  } else {
    let polygonData = getPolygonArgs(),
      intersectingRuns = [];

    runLinestrings.forEach((r) => {
      let coords = wkt.read(r.linestring).components;

      // intersecting the linestring is expensive, so subsample the route to
      // optimise at the risk of some false negatives/positives
      let sampleSize = 50;
      let retainEveryN = Math.ceil(coords.length / sampleSize);
      let coordsSampled = sampleEveryN(coords, retainEveryN);

      for (let i = 0; i < coordsSampled.length - 1; i++) {
        // wkt parsing leads to x = lat, y = lng
        let intersection = polygonData.intersectionFunction(
          ...polygonData.args,
          coords[i].x,
          coords[i].y,
          coords[i + 1].x,
          coords[i + 1].y,
          0.00000001 // tolerance in coordinate units
        );
        if (intersection) {
          intersectingRuns.push(r);
          break;
        }
      }
    });
    return intersectingRuns;
  }
}

function getRunsToShow(args, url) {
  fetch(url)
    .then((response) => response.json())
    .then((segments) => {
      let segmentsToShow = filterSegmentsToPolygon(segments);
      console.log(
        "Filtered " +
          segments.length +
          " rows of run data to " +
          segmentsToShow.segments.length +
          " in the network and polygon (if drawn)."
      );

      if (args.geometryEndpoint === "traversals") {
        lengthData = showSegmentsWithTraversals(segmentsToShow.segments, true);
      } else {
        lengthData = showSegments(segmentsToShow.segments, true);
        segmentsByDate = formatRunsByDate(segmentsToShow.segments);
        showStatsByRun(segmentsByDate, args);
      }
      lengthData.totalLengthKm = segmentsToShow.totalLengthKm;
      showOverallStats(lengthData);
    });
}

/** Display segments on the map. */
function showRunLinestrings(data, remove) {
  if (remove) {
    removeSegments(false);
  }
  var runs = [];
  data.forEach((d) => {
    try {
      let runPolyline = new L.Polyline(
        wkt.read(d.linestring).components.map((p) => {
          // x=latitude, y=longitude
          return [p.x, p.y];
        }),
        defaultStyle
      );

      // define mouse events
      runPolyline.bindTooltip("Date: " + d.date);
      runPolyline.on("mouseover", (e) => {
        let layer = e.target;
        layer.bringToFront();
        layer.setStyle({
          color: "orange",
        });
      });
      runPolyline.on("mouseout", (e) => {
        let layer = e.target;
        layer.setStyle(defaultStyle);
      });

      runs.push(runPolyline);
    } catch (err) {}
  });
  if (geometryLayer === undefined) {
    geometryLayer = L.layerGroup(runs);
  } else {
    runs.forEach((s) => s.addTo(geometryLayer));
  }
  geometryLayer.addTo(map);
}

function getRunLinestringsToShow(url) {
  fetch(url)
    .then((response) => response.json())
    .then((runs) => {
      let runsToShow = filterLinestringsToPolygon(runs);
      console.log(
        "Filtered " +
          runs.length +
          " rows of run data to " +
          runsToShow.length +
          " in the network and polygon (if drawn)."
      );
      showRunLinestrings(runsToShow, true);
    });
}

/** Based on geometry being shown, hide some stats boxes.
 *
 * Boxes that will be hidden are ones that a particular geometry type will not
 * populate e.g. for raw linestrings currently no stats are shown, so all stats
 * boxes are hidden.
 */
function hideIrrelevantStatsBoxes(geometryOption) {
  let overallStats = document.getElementById("overall-stats-box-data");
  let statsPerRun = document.getElementById("run-stats-box-data");
  let segmentIdSearch = document.getElementById("autocomplete-segment-ids");
  if (geometryOption === "runs") {
    overallStats.style.display = "";
    statsPerRun.style.display = "";
    segmentIdSearch.style.display = "";
  } else if (
    (geometryOption === "traversals") |
    (geometryOption === "missing")
  ) {
    overallStats.style.display = "";
    statsPerRun.style.display = "none";
    segmentIdSearch.style.display = "";
  } else {
    overallStats.style.display = "none";
    statsPerRun.style.display = "none";
    segmentIdSearch.style.display = "none";
  }
}

/** Show runs completed during the date range determined by the date inputs. */
function showGeometry(dateFilter) {
  const args = parseArgs(dateFilter === "date-range");
  if (args === undefined) {
    return;
  }

  const url =
    dateFilter === "all"
      ? args.geometryEndpoint
      : `${args.geometryEndpoint}?start_date=${args.startDate}&end_date=${args.endDate}`;

  hideIrrelevantStatsBoxes(args.geometryOption);

  if (args.geometryOption === "run_linestrings") {
    getRunLinestringsToShow(url);
  } else if (args.geometryOption === "missing") {
    showMissing(url);
  } else {
    getRunsToShow(args, url);
  }
}

/** Show all segments which have not been run (in polygon if drawn, otherwise everwhere).
 *
 * The number of segments shown here is potentially limited by the slider in the UI.
 */
function showMissingSegments(segmentIds) {
  removeSegments(false);
  let newSegments = [];
  segmentIds.forEach((segmentId) => {
    let segment = segmentData[segmentId];
    try {
      let segmentPolyline = new L.Polyline(
        segment["geometry"]["coordinates"].map((x) => {
          return [x[1], x[0]];
        }),
        defaultMissingStyle
      );
      segmentPolyline.bindTooltip("Segment Id: " + segmentId);
      segmentPolylinesById[segmentId] = segmentPolyline;
      newSegments.push(segmentPolyline);
    } catch (err) {}
  });
  if (geometryLayer === undefined) {
    geometryLayer = L.layerGroup(newSegments);
  } else {
    newSegments.forEach((s) => s.addTo(geometryLayer));
  }
  geometryLayer.addTo(map);
}

/** Display stats on how many roads have not currently been run. */
function showMissingStats(stats) {
  let statsBox = `
    <div><span class="stat-label">Total length: </span>${stats[
      "totalLengthKm"
    ].toFixed(1)}km</div>
    <div><span class="stat-label">Total missing length: </span>${stats[
      "totalMissingLengthKm"
    ].toFixed(1)}km</div>
    <div><span class="stat-label">% missing: </span>${(
      (100 * stats["totalMissingLengthKm"]) /
      stats["totalLengthKm"]
    ).toFixed(2)}%</div>
    <div><span class="stat-label"># missing segments: </span><br>${
      stats["numMissing"]
    } (of ${stats["totalNumSegments"]})</div>
  `;
  document.getElementById("overall-stats-box-data").innerHTML = statsBox;
}

/** Show all roads that have not been run (in a polygon if drawn, otherwise everywhere). */
function showMissing(url) {
  fetch(url)
    .then((response) => response.json())
    .then((segments) => {
      const filteredSegments = filterSegmentsToPolygon(segments);
      let missingSegmentIds = filteredSegments.missingSegmentIds;
      const numMissingSegments = missingSegmentIds.length;
      const totalMissingLengthKm = lengthKmOfSegmentsById(missingSegmentIds);
      const maxMissingToShow = parseInt(
        document.getElementById("max-missing-to-show-slider").value
      );
      if (missingSegmentIds.length > maxMissingToShow) {
        missingSegmentIds = missingSegmentIds.slice(0, maxMissingToShow);
      }
      showMissingSegments(missingSegmentIds);
      showMissingStats({
        totalLengthKm: filteredSegments.totalLengthKm,
        totalMissingLengthKm: totalMissingLengthKm,
        numMissing: numMissingSegments,
        totalNumSegments: filteredSegments.numSegmentsInIntersection,
      });
    });
}

/** Animate specified geometry option at speed determined by slider. */
function animateData(dateFilter, paused) {
  const args = parseArgs(dateFilter === "date-range");
  if (args === undefined) {
    return;
  }

  // only remove segments if not unpausing an animation
  var pauseDate;
  if (!paused) {
    removeSegments(false);
  } else {
    pauseDate = document.getElementById(
      "animation-date-slider-current-date"
    ).innerHTML;
  }

  const playControlIds = [
    "play-animate-in-date-range-btn",
    "play-animate-all-btn",
  ];
  playControlIds.forEach((id) => {
    document.getElementById(id).style.display = "none";
  });

  showAndAnimateButtonIds.forEach((id) => {
    document.getElementById(id).disabled = true;
  });

  var url;
  if (dateFilter === "all") {
    document.getElementById("pause-animate-all-btn").style.display =
      "inline-block";
    url = args.animationEndpoint;
  } else {
    document.getElementById("pause-animate-in-date-range-btn").style.display =
      "inline-block";
    url = `${args.animationEndpoint}?start_date=${args.startDate}&end_date=${args.endDate}`;
  }

  args.geometryOption === "runs"
    ? animateSegments(url, pauseDate)
    : animateLinestrings(url, pauseDate);
}

/** Get data to enable animation over time using OSM segments. */
async function getAnimateSegmentsData(url) {
  return fetch(url)
    .then((response) => response.json())
    .then((segmentsToAnimateByDate) => {
      let filteredRunsByDate = [];
      segmentsToAnimateByDate.forEach((s) => {
        let polygonFilteredSegments = filterSegmentsToPolygon(s.segments);
        if (polygonFilteredSegments.segments.length > 0) {
          filteredRunsByDate.push({
            ...s,
            ...polygonFilteredSegments,
          });
        }
      });
      animationPauseCache = {
        url,
        data: filteredRunsByDate,
      };
      if (filteredRunsByDate.length === 0) {
        resetAnimationButtons();
      }
      return filteredRunsByDate;
    });
}

/** Count the number of traversals per segment for a collection of runs*/
function getSegmentCounts(runs) {
  const segmentCounts = {};
  runs
    .map((r) => r.segments)
    .forEach((s) => {
      if (segmentCounts[s.segment_id] === undefined) {
        segmentCounts[s.segment_id] = 1;
      } else {
        segmentCounts[s.segment_id] += 1;
      }
    });
  return segmentCounts;
}

/** Animate all segments in time order at speed determined by slider. */
async function animateSegments(url, pauseDate) {
  const paused = pauseDate !== undefined;
  var runsByDate = await (paused || animationPauseCache.url === url
    ? animationPauseCache.data
    : getAnimateSegmentsData(url));

  const startDate = new Date(runsByDate[0].date);
  const endDate = new Date(last(runsByDate).date);
  const animationStartDate = paused ? new Date(pauseDate) : startDate;

  // if unpausing, retain only runs after the paused date
  if (paused) {
    runsByDate = runsByDate.filter(
      (r) => new Date(r.date) >= animationStartDate
    );
  }

  const daysPerSecond = parseInt(
    document.getElementById("animation-speed").value
  );
  let currentDelayMs = 0;

  // define run timeouts
  runsByDate.forEach((r) => {
    let diffDays = (new Date(r.date) - animationStartDate) / msInDay;
    currentDelayMs = 1000 * (diffDays / daysPerSecond);
    const timeoutId = setTimeout(() => {
      showSegments(r.segments, false);
    }, currentDelayMs);
    animationTimeouts.push(timeoutId);
  });

  // define date update timeouts
  createAnimationDateTimeouts(
    startDate,
    endDate,
    paused ? animationStartDate : null,
    daysPerSecond
  );

  // clean up timeout ids in case we animate again
  const timeout = setTimeout(() => {
    resetAnimationButtons();
    animationTimeouts = [];
  }, currentDelayMs);

  // still need to push this so that it gets cancelled when pausing
  animationTimeouts.push(timeout);

  if (!paused) {
    const segmentCounts = getSegmentCounts(runsByDate);
    showOverallStats({
      unique: lengthKmOfUniqueSegments(segmentCounts),
      repeats: lengthKmOfSegments(segmentCounts),
      totalLengthKm: totalLengthKm,
    });
    showStatsByRun(runsByDate, null);
  }
}

// Milliseconds in a day
const msInDay = 1000 * 60 * 60 * 24;

/** Get run linestrings to allow animation over time. */
async function getAnimateLinestringsData(url) {
  return fetch(url)
    .then((response) => response.json())
    .then((runLinestrings) => {
      runLinestrings = filterLinestringsToPolygon(runLinestrings);
      if (runLinestrings.length === 0) {
        resetAnimationButtons();
      }
      animationPauseCache = {
        url,
        data: runLinestrings,
      };
      return runLinestrings;
    });
}

/** Animate all segments in time order at speed determined by slider. */
async function animateLinestrings(url, pauseDate) {
  const paused = pauseDate !== undefined;
  var runLinestrings = await (paused || animationPauseCache.url === url
    ? animationPauseCache.data
    : getAnimateLinestringsData(url));

  const startDate = new Date(runLinestrings[0].date);
  const endDate = new Date(last(runLinestrings).date);
  const animationStartDate = paused ? new Date(pauseDate) : startDate;

  // if unpausing, retain only runs after the paused date
  if (paused) {
    runLinestrings = runLinestrings.filter(
      (r) => new Date(r.date) >= animationStartDate
    );
  }

  // define run linestring timeouts
  const daysPerSecond = parseInt(
    document.getElementById("animation-speed").value
  );
  let currentDelayMs = 0;
  for (let i = 0; i < runLinestrings.length; i++) {
    let run = runLinestrings[i];
    let runDate = new Date(run.date);
    let diffDays = (runDate - animationStartDate) / msInDay;
    currentDelayMs = 1000 * (diffDays / daysPerSecond);

    const timeoutId = setTimeout(() => {
      showRunLinestrings([run], false);
    }, currentDelayMs);
    animationTimeouts.push(timeoutId);
  }

  // define date update timeouts
  createAnimationDateTimeouts(
    startDate,
    endDate,
    paused ? animationStartDate : null,
    daysPerSecond
  );

  // clean up timeout ids in case we animate again
  const timeout = setTimeout(() => {
    resetAnimationButtons();
    animationTimeouts = [];
  }, currentDelayMs);

  // still need to push this so that it gets cancelled when pausing
  animationTimeouts.push(timeout);
}

/** Toggle whether the stats overlay is collapsed or not */
function collapseStatsOverlay() {
  let classList = document.getElementById("stats-box-data").classList;
  let toggle = document.getElementById("toggle-stats-collapse");
  if (classList.contains("collapse")) {
    toggle.innerHTML = '<i class="fa fa-compress"></i>';
  } else {
    toggle.innerHTML = '<i class="fa fa-expand"></i>';
  }
  classList.toggle("collapse");
}

/** Remove the currently drawn polygon from the map. */
function removeDrawnPolygon() {
  if (currentPolygon !== undefined) {
    animationPauseCache = { url: "", data: [] };
    drawingLayer.removeLayer(currentPolygon);
    currentPolygon = undefined;
    currentPolygonType = undefined;
  }
}

/** Load geometry for the first time, correctly ignoring segments. */
function initialiseGeometry() {
  // populate ignored segments set prior to loading geometry
  fetch("/currently_ignored_segments")
    .then((response) => response.json())
    .then((data) => {
      data.forEach((d) => ignoredSegments.add(d));
      loadGeometry(
        currentNetworkOptions.minLengthM,
        currentNetworkOptions.includeCulDeSacs
      );
      populateWithCurrentUserInfo(map);
    });
}

/** Automatically 'draw' the polygon for a specific sub area. */
function showSubArea(subAreaName) {
  const payload = {
    method: "POST",
    body: JSON.stringify({ name: subAreaName }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  };

  fetch("/sub_run_area", payload)
    .then((response) => response.json())
    .then((data) => {
      if (data.polygon === undefined) {
        populateAndShowModal({
          title: "Polygon missing",
          content: `Could not find saved polygon for area named ${subAreaName}`,
        });
        return;
      }

      removeDrawnPolygon();
      const parsedAreaWkt = wkt.read(data.polygon);
      let subAreaPolygon = L.polygon(
        parsedAreaWkt.components[0].map((p) => {
          return L.latLng([p["x"], p["y"]]);
        }),
        { color: polygonColour }
      );
      currentPolygonType = "polygon";
      currentPolygon = subAreaPolygon;
      currentPolygon.addTo(drawingLayer);
    });
}

const removeSubRunArea = (username, areaName, subAreaName) => {
  const payload = {
    method: "POST",
    body: JSON.stringify({
      username,
      area_name: areaName,
      sub_area_name: subAreaName,
    }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  };
  fetch("/remove_sub_run_area", payload).then((response) => {
    if (response.ok) populateSubRunAreas();
  });
};

const populateSubRunAreas = () => {
  fetch("/sub_run_areas")
    .then((response) => response.json())
    .then((data) => {
      const dropdownDiv = document.getElementById("area-dropdown-ctn");
      const dropdownNav = document.getElementById("area-dropdown");

      if (data.length === 0) {
        dropdownNav.disabled = true;
        dropdownNav.classList.remove("dropdown-toggle");
        return;
      }

      dropdownNav.classList.add("dropdown-toggle");
      dropdownNav.disabled = false;
      dropdownDiv.innerHTML = "";
      data.forEach((subArea) => {
        const showOnClick = `showSubArea('${subArea.sub_area_name}')`;
        const removeOnClick = `removeSubRunArea('${subArea.username}', '${subArea.area_name}', '${subArea.sub_area_name}')`;
        dropdownDiv.insertAdjacentHTML(
          "beforeend",
          `<div class="dropdown-item area-dropdown-name">
            <a class="btn" onclick="${showOnClick}">
              ${subArea.sub_area_name}
            </a>
            <a class="btn" onclick="${removeOnClick}">
              <i class="fa fa-trash-o"></i>
            </a>
          </div>`
        );
      });
    });
};

const saveSubRunAreaModalContent = `
  <div class="form-group">
  <label for="sub-run-area-name form-inline">Name:</label>
    <span>&nbsp;&nbsp;</span>
    <input type="text" class="form-control form-control-plaintext" id="sub-run-area-name">
  </div>

  <div class="form-check form-check-inline">
    <input class="form-check-input" type="checkbox" id="intersect-run-area" checked>
    <label class="form-check-label" for="intersect-run-area">Save intersection with run area</label>
  </div>

  <button type="submit" class="btn btn-primary" onclick="saveSubRunArea()">Save</button>
`;

const saveSubRunArea = () => {
  const subRunAreaName = document.getElementById("sub-run-area-name").value;
  if (subRunAreaName.length === 0) {
    populateAndShowModal({
      title: "Missing name",
      content: "Sub area must have a name in order to be saved.",
    });
    return;
  }

  const useIntersection = document.getElementById("intersect-run-area").checked;
  if (useIntersection) {
    // if a circle, approximate it with a polygon
    const currentPolygonForIntersection =
      currentPolygonType === "circle"
        ? L.PM.Utils.circleToPolygon(currentPolygon, 60)
        : currentPolygon;

    const intersection = L.geoJson(
      turf.intersect(
        currentPolygonForIntersection.toGeoJSON(),
        L.polygon(runAreaBoundary._latlngs).toGeoJSON()
      )
    );

    drawingLayer.removeLayer(currentPolygon);
    currentPolygon = intersection;
    currentPolygonType = "polygon";
    currentPolygon.addTo(drawingLayer);
  }

  let geometry;
  if (currentPolygon.getLatLngs !== undefined) {
    geometry = currentPolygon.getLatLngs()[0];
  } else if (currentPolygonType === "circle") {
    geometry = L.PM.Utils.circleToPolygon(currentPolygon, 60).getLatLngs()[0];
  } else {
    const layerKey = Object.keys(currentPolygon._layers).pop();
    if (currentPolygon._layers[layerKey]._latlngs.length > 1) {
      populateAndShowModal({
        title: "Bad intersection",
        content:
          "Intersection with run area has multiple connected components, which is not supported.",
      });
      return;
    }
    geometry = currentPolygon._layers[layerKey]._latlngs[0];
  }

  const payload = {
    method: "POST",
    body: JSON.stringify({
      sub_area_name: subRunAreaName,
      geometry: geometry,
    }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  };

  $("#default-modal").modal("hide");

  fetch("/insert_sub_run_area", payload)
    .then((response) => {
      if (response.ok) {
        populateSubRunAreas();
      } else {
        return Promise.reject();
      }
    })
    .catch((err) => {
      populateAndShowModal({
        title: "Duplicate",
        content: `Sub area with name ${subRunAreaName} already exists.`,
      });
    });
};

document.addEventListener("DOMContentLoaded", function (event) {
  map = L.map("map").setView([0, 0], 1);
  setupPanes(map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    opacity: 0.5,
  }).addTo(map);

  // set end date as today's date
  document.getElementById("end-date").value = moment().format("YYYY-MM-DD");

  drawingLayer = new L.FeatureGroup();
  map.addLayer(drawingLayer);

  // set up options for the drawing menu to be displayed in the top left of the map
  let shapeOptions = {
    color: polygonColour,
    clickable: false,
  };
  var drawingControlOptions = {
    position: "topleft",
    draw: {
      polygon: {
        allowIntersection: false,
        drawError: {
          color: "#ff0000",
          message: "<strong>No intersections are allowed",
        },
        shapeOptions: shapeOptions,
      },
      circle: { shapeOptions: shapeOptions },
      rectangle: { shapeOptions: shapeOptions },
      marker: false,
      circlemarker: false,
      polyline: false,
    },
    edit: {
      featureGroup: drawingLayer,
      remove: true,
    },
  };
  var drawControl = new L.Control.Draw(drawingControlOptions);
  map.addControl(drawControl);

  // drawing events
  map.on(L.Draw.Event.DRAWSTART, function (e) {
    removeDrawnPolygon();
  });
  map.on(L.Draw.Event.DELETESTOP, function (e) {
    currentPolygon = undefined;
    currentPolygonType = undefined;
  });
  map.on(L.Draw.Event.CREATED, function (e) {
    currentPolygonType = e.layerType;
    currentPolygon = e.layer;
    currentPolygon.on("click", () => {
      populateAndShowModal({
        title: "Save polygon as sub run area",
        content: saveSubRunAreaModalContent,
      });
    });
    currentPolygon.addTo(drawingLayer);
  });

  let sliders = [
    { sliderId: "animation-speed", valueId: "days-per-second" },
    { sliderId: "max-missing-to-show-slider", valueId: "max-missing-to-show" },
    {
      sliderId: "min-segment-length-m-slider",
      valueId: "min-segment-length-m",
    },
  ];
  setSliderOnChangeEvents(sliders);

  showOverallStats();

  initialiseGeometry();
  statsByRunTable = refreshStatsByRunTable();

  wkt = makeWktReader();

  populateSubRunAreas();
});

let animationButtonIds = ["animate-all-btn", "animate-in-date-range-btn"];

/** Enable animation buttons for geometry options that allow it. */
function enableAnimation() {
  showAndAnimateButtonIds.forEach((id) => {
    document.getElementById(id).disabled = false;
  });
}

/** Disable animation buttons for geometry options that do not allow it. */
function disableAnimation() {
  showAndAnimateButtonIds
    .filter((id) => id.includes("animate"))
    .forEach((id) => {
      document.getElementById(id).disabled = true;
    });
}

/** Create timeouts for current date displayed during animation. */
function createAnimationDateTimeouts(
  startDate,
  endDate,
  pauseDate,
  daysPerSecond
) {
  let slider = document.getElementById("animation-date-slider");
  if (pauseDate === null) {
    // define slider start and end times if not unpausing
    slider.min = 0;
    slider.max = Math.ceil((endDate - startDate) / msInDay);
    document.getElementById("animation-date-slider-min").innerHTML =
      formatDateStr(startDate);
    document.getElementById("animation-date-slider-max").innerHTML =
      formatDateStr(endDate);
  }

  // use this as reference point for timeouts, either the start date or
  // the date we paused a previous animation
  const animationStartDate = pauseDate === null ? startDate : pauseDate;

  var date = pauseDate === null ? new Date(startDate) : new Date(pauseDate);
  while (date < endDate) {
    date = addDays(date, 1);
    const dateStr = formatDateStr(date);
    const sliderDiffDays = (date - startDate) / msInDay;
    const timeoutDiffDays = (date - animationStartDate) / msInDay;
    const timeoutId = setTimeout(() => {
      updateDateDiv(dateStr, sliderDiffDays);
    }, 1000 * (timeoutDiffDays / daysPerSecond));
    animationTimeouts.push(timeoutId);
  }
}

/** Upon pausing an animation, hide pause button and show play button. */
function pauseAnimation(dateFilter) {
  animationTimeouts.forEach(clearTimeout);
  animationTimeouts = [];

  const idDateTerm = dateFilter === "all" ? "all" : "in-date-range";
  const pauseButton = document.getElementById(
    `pause-animate-${idDateTerm}-btn`
  );
  const playButton = document.getElementById(`play-animate-${idDateTerm}-btn`);

  // only switch button hide/show if we're currently animating and therefore
  // pausing is a valid action
  if (pauseButton.style.display !== "none") {
    pauseButton.style.display = "none";
    playButton.style.display = "inline-block";
  }
}
