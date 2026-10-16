// Independent Float64 Hermite derivative + composite Simpson integration.
// Does not call curve3, PreparedPath.sample or the product's chord table.
export function arcOracle(definition, scale = [1, 1, 1], subdivisions = 65536) {
  const points = Array.from({ length: definition.points.length / 3 }, (_, i) =>
    Array.from(definition.points.slice(i * 3, i * 3 + 3)),
  );
  const closed = definition.closed,
    segments = closed ? points.length : points.length - 1;
  const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
  const curves = Array.from({ length: segments }, (_, index) => {
    const b = points[index],
      c = points[(index + 1) % points.length];
    const a = closed
      ? points[(index + points.length - 1) % points.length]
      : (points[index - 1] ?? b.map((v, i) => 2 * v - c[i]));
    const d = closed
      ? points[(index + 2) % points.length]
      : (points[index + 2] ?? c.map((v, i) => 2 * v - b[i]));
    let dt0 = 1,
      dt1 = 1,
      dt2 = 1;
    if (definition.parameterization !== 0) {
      const power = definition.parameterization === 1 ? 0.5 : 1;
      dt1 = dist(b, c) ** power || 1;
      dt0 = dist(a, b) ** power || dt1;
      dt2 = dist(c, d) ** power || dt1;
    }
    const m1 = b.map((v, j) =>
      definition.parameterization === 0
        ? (c[j] - a[j]) / 2
        : dt1 * ((v - a[j]) / dt0 - (c[j] - a[j]) / (dt0 + dt1) + (c[j] - v) / dt1),
    );
    const m2 = b.map((v, j) =>
      definition.parameterization === 0
        ? (d[j] - v) / 2
        : dt1 * ((c[j] - v) / dt1 - (d[j] - v) / (dt1 + dt2) + (d[j] - c[j]) / dt2),
    );
    return { b, c, m1, m2 };
  });
  const speed = (segment, u) => {
    const { b, c, m1, m2 } = curves[segment];
    return Math.hypot(
      ...b.map(
        (v, j) =>
          scale[j] *
          segments *
          ((6 * u * u - 6 * u) * v +
            (3 * u * u - 4 * u + 1) * m1[j] +
            (-6 * u * u + 6 * u) * c[j] +
            (3 * u * u - 2 * u) * m2[j]),
      ),
    );
  };
  const perSegment = Math.ceil(subdivisions / segments);
  subdivisions = perSegment * segments;
  const lengths = new Float64Array(subdivisions + 1);
  for (let i = 1; i <= subdivisions; i++) {
    const segment = Math.floor((i - 1) / perSegment),
      a = ((i - 1) % perSegment) / perSegment,
      b = a + 1 / perSegment;
    lengths[i] =
      lengths[i - 1] +
      (speed(segment, a) + 4 * speed(segment, (a + b) / 2) + speed(segment, b)) /
        (6 * subdivisions);
  }
  const parameterAtDistance = (distance) => {
    const target = Math.max(0, Math.min(lengths[subdivisions], distance));
    let low = 0,
      high = subdivisions;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (lengths[mid] <= target) low = mid;
      else high = mid;
    }
    return (
      (low +
        (lengths[high] > lengths[low]
          ? (target - lengths[low]) / (lengths[high] - lengths[low])
          : 0)) /
      subdivisions
    );
  };
  const point = (t) => {
    const v = Math.max(0, Math.min(1, t)) * segments,
      index = Math.min(segments - 1, Math.floor(v)),
      u = v - index;
    const { b, c, m1, m2 } = curves[index];
    return b.map(
      (value, j) =>
        scale[j] *
        ((2 * u ** 3 - 3 * u * u + 1) * value +
          (u ** 3 - 2 * u * u + u) * m1[j] +
          (-2 * u ** 3 + 3 * u * u) * c[j] +
          (u ** 3 - u * u) * m2[j]),
    );
  };
  const tangent = (t) => {
    const v = Math.max(0, Math.min(1, t)) * segments,
      index = Math.min(segments - 1, Math.floor(v)),
      u = v - index;
    const { b, c, m1, m2 } = curves[index];
    const result = b.map(
      (value, j) =>
        scale[j] *
        ((6 * u * u - 6 * u) * value +
          (3 * u * u - 4 * u + 1) * m1[j] +
          (-6 * u * u + 6 * u) * c[j] +
          (3 * u * u - 2 * u) * m2[j]),
    );
    const length = Math.hypot(...result);
    return result.map((value) => value / length);
  };
  return {
    length: lengths[subdivisions],
    point,
    tangent,
    parameterAtDistance,
    distance(t) {
      const v = Math.max(0, Math.min(1, t)) * subdivisions,
        i = Math.min(subdivisions - 1, Math.floor(v));
      return lengths[i] + (lengths[i + 1] - lengths[i]) * (v - i);
    },
  };
}
