let map,
  drawingLayer, // layer containing polygon drawn by user
  currentPolygon, // the currently drawn polygon
  currentPolygonType; // ...and its type; circle, rectangle or polygon

const polygonColour = "#6495ed"; // colour for drawn polygons

// maximum size of polygon allowed in metres squared - M60 area used for guidance here
// which has area just below 2 billion metres squared (2000 kms squared)
const maxPolygonAreaKmSquared = 2000;

/** Remove the currently drawn polygon from the map. */
function removeDrawnPolygon() {
  if (currentPolygon !== undefined) {
    drawingLayer.removeLayer(currentPolygon);
    currentPolygon = undefined;
    currentPolygonType = undefined;
  }
}

const submit = () => {
  const runAreaName = document.getElementById("run-area-name").value;

  if (runAreaName.length === 0) {
    populateAndShowModal({
      title: "Missing area name",
      content: "A name for the run area must be provided.",
    });
    return;
  } else if (currentPolygon === undefined) {
    populateAndShowModal({
      title: "No polygon drawn",
      content: `A polygon must be drawn for to create area with name ${runAreaName}.`,
    });
    return;
  }

  let latLngs;
  if (currentPolygon.getLatLngs !== undefined) {
    latLngs = currentPolygon.getLatLngs()[0];
  } else {
    // deal with circle case
    latLngs = L.PM.Utils.circleToPolygon(currentPolygon, 60).getLatLngs()[0];
  }

  // geometry utils calculates in metres squared
  const polygonAreaKmSquared = L.GeometryUtil.geodesicArea(latLngs) / 1_000_00;

  if (polygonAreaKmSquared > maxPolygonAreaKmSquared) {
    populateAndShowModal({
      title: "Polygon too large",
      content: `Polygon must have area < ${maxPolygonAreaKmSquared}km${"2".sup()}, area was ${polygonAreaKmSquared.toFixed(
        3
      )}km${"2".sup()}.`,
    });
    return;
  }

  document.getElementById("run-area-name").value = "";
  removeDrawnPolygon();

  document.getElementById("create-run-area-submit").disabled = true;
  populateAndShowModal({
    title: "Retrieving data",
    content:
      "Background task running to retrieve graph and geometry for chosen polygon.",
  });

  const payload = {
    method: "POST",
    body: JSON.stringify({
      area_name: runAreaName,
      geometry: latLngs,
    }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  };
  fetch("/create_run_area", payload)
    .then((response) => {
      if (!response.ok) {
        throw Error(response.content);
      }

      var timer = setInterval(function () {
        // don't need to return large geojson dataset, just know it exists
        fetch("/current_user_areas")
          .then((response) => response.json())
          .then((data) => {
            const currentAreasWithArtifacts = new Set(
              data.map((d) => d.area_name)
            );

            if (currentAreasWithArtifacts.has(runAreaName)) {
              document.getElementById(
                "create-run-area-submit"
              ).disabled = false;
              clearInterval(timer);
              populateAndShowModal({
                title: "Data retrieved",
                content:
                  'Background task finished, visit <a href="/">Home</a> and switch area to start logging runs.',
              });
            }
          });
      }, 10000);
    })
    .catch((err) => {
      populateAndShowModal({
        title: "Error creating run area",
        content: `Error was ${err}.`,
      });
    });
};

const removeRunArea = (username, areaName) => {
  const payload = {
    method: "POST",
    body: JSON.stringify({
      username,
      area_name: areaName,
    }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  };
  fetch("/remove_run_area", payload);
};

document.addEventListener("DOMContentLoaded", function (event) {
  map = L.map("map").setView([0, 0], 1);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    opacity: 0.5,
  }).addTo(map);

  drawingLayer = new L.FeatureGroup();
  map.addLayer(drawingLayer);

  // set up options for the drawing menu to be displayed in the top left of the map
  const shapeOptions = {
    color: polygonColour,
    clickable: false,
  };
  const drawingControlOptions = {
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
  const drawControl = new L.Control.Draw(drawingControlOptions);
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
    currentPolygon.addTo(drawingLayer);
  });

  document
    .getElementById("create-run-area-submit")
    .addEventListener("click", submit);

  fetch("/current_username")
    .then((response) => response.json())
    .then(({ username }) => {
      populateLoggedInUser(username);
    });
});
