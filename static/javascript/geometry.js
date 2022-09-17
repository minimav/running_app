/**
 * Calculates the haversine distance between point A, and B.
 * @param {number[]} latlngA [lat, lng] point A
 * @param {number[]} latlngB [lat, lng] point B
 * @param {boolean} isMiles If we are using miles, else km.
 */
const haversineDistanceMetres = ([lat1, lng1], [lat2, lng2]) => {
    const toRadian = angle => (Math.PI / 180) * angle;
    const distance = (a, b) => (Math.PI / 180) * (a - b);
    const RADIUS_OF_EARTH_IN_KM = 6371;

    const dLat = distance(lat2, lat1);
    const dLon = distance(lng2, lng1);

    lat1 = toRadian(lat1);
    lat2 = toRadian(lat2);

    // Haversine Formula
    const a =
        Math.pow(Math.sin(dLat / 2), 2) +
        Math.pow(Math.sin(dLon / 2), 2) * Math.cos(lat1) * Math.cos(lat2);
    const c = 2 * Math.asin(Math.sqrt(a));

    return RADIUS_OF_EARTH_IN_KM * c * 1000;
}

/**
 * Interpolate segment geometry so that points are no more than max distance apart.
 * @param {object} segment All data for the segment to interpolate
 * @param {number} metres Max distance in metres between interpolated points
 */
const interpolateSegment = (segment, metres) => {
    const coords = segment["geometry"]["coordinates"]

    const interpolatedCoords = []
    coords.forEach(([lng, lat], index) => {
        interpolatedCoords.push([lng, lat])

        // skip interpolated for final point
        if (index === coords.length - 1) { return }

        // figure out the number of intermediate points required based on distance to the
        // next point
        const [nextLng, nextLat] = coords[index + 1]
        const distanceToNextMetres = haversineDistanceMetres([lat, lng], [nextLat, nextLng])
        const numIntermediatePoints = Math.floor(distanceToNextMetres / metres)

        // either too short to require interpolation or a rogue multiline geometry
        if (numIntermediatePoints <= 0 || isNaN(numIntermediatePoints)) { return }

        // do the interpolated linearly; approximation should be good at the scale we're
        // working at
        const latDiff = (nextLat - lat) / (numIntermediatePoints + 1)
        const lngDiff = (nextLng - lng) / (numIntermediatePoints + 1)

        for (const step of Array(numIntermediatePoints).keys()) {
            interpolatedCoords.push([lng + (step + 1) * lngDiff, lat + (step + 1) * latDiff])
        }
    })
    segment["geometry"]["coordinates"] = interpolatedCoords
    return segment
}

/** Switch the order of cordinates in an array of them e.g. (lng, lat) => (lat, lng) */
const switchCoords = (coords) => coords.map(([x, y]) => [y, x])

/** Bounding box for a set of coordinates. */
function getBoundingBox(coords) {
    return {
        minLng: Math.min(...coords.map(([lng, _]) => lng)),
        maxLng: Math.max(...coords.map(([lng, _]) => lng)),
        minLat: Math.min(...coords.map(([_, lat]) => lat)),
        maxLat: Math.max(...coords.map(([_, lat]) => lat))
    }
}

/** Jitter a lat-lng randomly. */
const jitter = ({ lat, lng, jitterProb, maxJitter }) => {
    if (Math.random() < jitterProb) {
        return { jitteredLat: lat, jitteredLng: lng }
    }
    return {
        jitteredLat: lat + 2 * (Math.random() - 0.5) * maxJitter,
        jitteredLng: lng + 2 * (Math.random() - 0.5) * maxJitter
    }
}

/** Remove points that are too far away from the previous one due to GPS flickering. */
function removeFlickers(coords, thresholdMetres) {
    let cleanedCoords = [];
    coords.forEach(function (point, i) {
        var comparePoint = coords[i + 1]
        // use previous point for final point in GPS trace
        if (comparePoint === undefined) {
            comparePoint = coords[i - 1]
        }
        let distanceMetres = point.distanceTo(comparePoint)
        if (distanceMetres < thresholdMetres) {
            cleanedCoords.push(point)
        }
    })
    return cleanedCoords
}