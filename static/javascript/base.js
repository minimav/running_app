const months = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
var wkt; // used to read WKT linestrings

/** Update the div overlay showing current month/year for animation.
 *
 * Date has format "YYYY-MM-DD".
 */
function updateDateDiv(dateStr, numDays) {
  // make visible...
  let dateBox = document.getElementById("animation-date");
  dateBox.style.opacity = "1";
  // move slider
  document.getElementById("animation-date-slider").value = numDays;
  document.getElementById("animation-date-slider-current-date").innerHTML =
    dateStr;
}

/** Given a date, get YYYY-MM-DD string representation. */
function formatDateStr(date) {
  return date.toISOString().split("T")[0];
}

/** Add onchange events to update slider value tags */
function setSliderOnChangeEvents(sliders) {
  sliders.forEach((ids) => {
    const slider = document.getElementById(ids.sliderId),
      valueTag = document.getElementById(ids.valueId);
    slider.onchange = function () {
      valueTag.innerHTML = this.value;
    };
  });
}

/** Get the last element of an array. */
function last(arr) {
  return arr[arr.length - 1];
}

/** General purpose modal for nicer alternative to alert-ing. */
const populateAndShowModal = ({ title, content }) => {
  $("#default-modal").modal();
  $("#default-modal .modal-title").html(title);
  $("#default-modal .modal-body").html(content);
};

/** Create reader object for WKT geometries. */
function makeWktReader() {
  return new Wkt.Wkt();
}

/** Controls a search input with autocomplete functionality. */
class AutoComplete {
  constructor(
    id,
    options,
    searchCallback,
    minSearchLength,
    maxResults,
    placeholder
  ) {
    this.searchWrapper = document.getElementById(id);
    this.options = options;
    this.minSearchLength = minSearchLength;
    this.maxResults = maxResults;
    this.searchCallback = searchCallback;
    this.inputBox = this.searchWrapper.querySelector("input");
    this.possibleOptionsBox = this.searchWrapper.querySelector(".autocom-box");
    this.searchButton = this.searchWrapper.querySelector(".btn-primary");
    this.clearButton = this.searchWrapper.querySelector(".btn-danger");
    this.clearButton.onclick = () => {
      this.inputBox.value = "";
      this.inputBox.placeholder = placeholder;
      this.searchWrapper.classList.remove("active");
    };
  }

  //** Behaviour if a suggestion is selected from the suggestions dropdown. */
  select(element) {
    this.inputBox.value = element.textContent;
    this.searchButton.onclick = () => {
      this.searchCallback(this.inputBox.value);
    };
    this.searchWrapper.classList.remove("active");
  }

  //** Initialise the autocomplete search box. */
  setup() {
    let autocompleter = this;
    this.inputBox.onkeyup = (e) => {
      let userData = e.target.value;
      if (userData && userData.length >= this.minSearchLength) {
        let possibleOptions = this.options.filter((data) => {
          return data
            .toLocaleLowerCase()
            .startsWith(userData.toLocaleLowerCase());
        });
        let optionsList = possibleOptions
          .slice(0, this.maxResults)
          .map((data) => {
            return "<li>" + data + "</li>";
          })
          .join("");
        if (possibleOptions.length) {
          this.searchWrapper.classList.add("active");
          this.possibleOptionsBox.innerHTML = optionsList;
          let possibleOptionTags =
            this.possibleOptionsBox.querySelectorAll("li");
          possibleOptionTags.forEach((tag) => {
            tag.onclick = () => {
              autocompleter.select(tag);
            };
          });
        }
      } else {
        this.searchWrapper.classList.remove("active");
      }
    };
  }
}

const populateLoggedInUser = (username) => {
  document.getElementById(
    "current-user"
  ).innerHTML = `Logged in as ${username}`;
};

const switchRunArea = (username, areaName) => {
  const payload = {
    method: "POST",
    body: JSON.stringify({
      username,
      area_name: areaName,
      calling_url: window.location.href,
    }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  };
  fetch("/set_active_area", payload)
    .then((response) => {
      if (!response.ok) {
        return Promise.reject();
      }
      window.location.reload();
    })
    .catch((err) => {
      populateAndShowModal({
        title: "Area change error",
        content: `Could not change to ${areaName}.`,
      });
    });
};

/** Setup up map panes to allow easy layering of different plotting artefacts.
 *
 * See https://github.com/Leaflet/Leaflet/blob/v1.0.0/dist/leaflet.css#L87
 */
const panes = {};
const setupPanes = (map) => {
  const paneZIndexes = [
    { name: "network", zIndex: 601 },
    { name: "uploads", zIndex: 602 },
    { name: "boundary", zIndex: 603 },
    { name: "route", zIndex: 604 },
    { name: "upload-points", zIndex: 605 },
    { name: "points", zIndex: 606 },
  ];
  paneZIndexes.forEach(({ name, zIndex }) => {
    panes[name] = map.createPane(name);
    panes[name].style.zIndex = zIndex;
    panes[name].style.pointerEvents = "none";
  });
};

// we'll store the current run area boundary here
var runAreaBoundary;

/** Show the boundary of a run area and zoom to fit it on screen. */
const showRunAreaAndSetView = ({ map, area }) => {
  const wkt = makeWktReader();

  // we'll plot twice for emphasis
  const runAreaStyle = {
    color: "black",
    weight: 5,
    opacity: 1.0,
    pane: "boundary",
  };

  let parsedGeometry = wkt.read(area.polygon);
  let coords = parsedGeometry.components[0].map((p) => {
    return L.latLng([p["x"], p["y"]]);
  });
  runAreaBoundary = new L.Polyline(coords, runAreaStyle);
  runAreaBoundary.addTo(map);

  map.fitBounds(runAreaBoundary.getBounds());
  document.getElementsByClassName("mapbox")[0].style.opacity = 1;
};

const populateWithCurrentUserInfo = (map) => {
  fetch("/current_user_areas")
    .then((response) => response.json())
    .then((data) => {
      populateLoggedInUser(data[0].username);

      const dropdownDiv = document.getElementById("user-area-dropdown-links");
      data.forEach((area) => {
        dropdownDiv.insertAdjacentHTML(
          "beforeend",
          `<a class="dropdown-item" href="#" onclick="switchRunArea('${area.username}', '${area.area_name}')">${area.area_name}</a>`
        );

        if (area.active) {
          const dropdownNav = document.getElementById("user-areas-dropdown");
          dropdownNav.classList.add("dropdown-toggle");
          dropdownNav.innerHTML = `Current area ${area.area_name}`;
          showRunAreaAndSetView({ map, area });
        }
      });
    });
};

/** from https://stackoverflow.com/a/2117523 */
function uuidv4() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
    (
      c ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))
    ).toString(16)
  );
}

/** Check that a datetime is valid */
function validateDatetime(d) {
  return !isNaN(d.getTime());
}

/** Sample every nth element of an array. */
function sampleEveryN(arr, n) {
  let newArr = [];
  for (let i = 0; i < arr.length; i += n) {
    newArr.push(arr[i]);
  }
  return newArr;
}

/** Toggle whether the options sidebar is shown */
function toggleSidebar() {
  let sidebar = document.getElementById("controls-col");
  let sidebarContent = document.getElementById("controls-col-content");
  let sidebarButton = document.getElementById("sidebar-toggle-btn");
  if (sidebarContent.style.display === "none") {
    // expand the sidebar
    sidebar.classList.remove("controls-col-collapsed");
    sidebar.classList.add("controls-col-expanded");
    sidebarContent.style.display = "";
    sidebarButton.innerHTML = '<i class="fa fa-angle-double-left"></i>';
  } else {
    // collapse the sidebar
    sidebar.classList.remove("controls-col-expanded");
    sidebar.classList.add("controls-col-collapsed");
    sidebarContent.style.display = "none";
    sidebarButton.innerHTML = '<i class="fa fa-angle-double-right"></i>';
  }
}

/** Add specified number of days to a date.
 *
 * From https://stackoverflow.com/a/19691491
 */
function addDays(date, days) {
  var result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}
