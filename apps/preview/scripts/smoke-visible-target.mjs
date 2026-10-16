import { PNG } from 'pngjs';

const COLOR_MATCHERS = {
  blue: (red, green, blue) => blue > red + 24 && blue > 85 && (blue > green + 8 || green > red + 18),
  green: (red, green, blue) => green > red + 28 && green > blue + 18 && green > 90,
  red: (red, green, blue) => red > green + 24 && red > blue + 18 && red > 90,
  yellow: (red, green, blue) => red > blue + 40 && green > blue + 20 && red > 105,
};

export function visibleTargetCandidates(bytes, color) {
  const png = PNG.sync.read(bytes);
  const { width, height, data } = png;
  const minX = Math.floor(width * 0.28);
  const maxX = Math.ceil(width * 0.9);
  const minY = Math.floor(height * 0.18);
  const maxY = Math.ceil(height * 0.93);
  const matches = new Uint8Array(width * height);
  const matcher = COLOR_MATCHERS[color];
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const pixel = (y * width + x) * 4;
      if (matcher(data[pixel], data[pixel + 1], data[pixel + 2])) matches[y * width + x] = 1;
    }
  }

  const visited = new Uint8Array(matches.length);
  const components = [];
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const start = y * width + x;
      if (matches[start] === 0 || visited[start] !== 0) continue;
      const pixels = [start];
      visited[start] = 1;
      let sumX = 0;
      let sumY = 0;
      let left = x;
      let right = x;
      let top = y;
      let bottom = y;
      for (let index = 0; index < pixels.length; index++) {
        const current = pixels[index];
        const currentX = current % width;
        const currentY = Math.floor(current / width);
        sumX += currentX;
        sumY += currentY;
        left = Math.min(left, currentX);
        right = Math.max(right, currentX);
        top = Math.min(top, currentY);
        bottom = Math.max(bottom, currentY);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nextX = currentX + dx;
            const nextY = currentY + dy;
            const next = nextY * width + nextX;
            if (nextX < minX || nextX >= maxX || nextY < minY || nextY >= maxY
              || matches[next] === 0 || visited[next] !== 0) continue;
            visited[next] = 1;
            pixels.push(next);
          }
        }
      }
      const boxWidth = right - left + 1;
      const boxHeight = bottom - top + 1;
      if (pixels.length < 18 || boxWidth < 4 || boxHeight < 4 || boxWidth > 120 || boxHeight > 120) continue;
      const centerX = sumX / pixels.length;
      const centerY = sumY / pixels.length;
      const representative = pixels.reduce((best, candidate) => {
        const candidateX = candidate % width;
        const candidateY = Math.floor(candidate / width);
        const bestX = best % width;
        const bestY = Math.floor(best / width);
        return Math.hypot(candidateX - centerX, candidateY - centerY)
          < Math.hypot(bestX - centerX, bestY - centerY) ? candidate : best;
      }, pixels[0]);
      components.push({
        x: representative % width,
        y: Math.floor(representative / width),
        pixels: pixels.length,
        width: boxWidth,
        height: boxHeight,
      });
    }
  }
  return components.sort((left, right) => right.pixels - left.pixels).slice(0, 24);
}

export async function aimAtVisibleTarget(
  page,
  color,
  complete,
  {
    delay = 260,
    preferRectangular = false,
    preferLower = false,
    minY = Number.NEGATIVE_INFINITY,
    maxY = Number.POSITIVE_INFINITY,
  } = {},
) {
  const colors = Array.isArray(color) ? color : [color];
  const colorLabel = colors.join('+');
  const attempted = [];
  for (let attempt = 0; attempt < 18; attempt++) {
    const screenshot = await page.screenshot();
    const candidates = colors
      .flatMap((candidateColor) => visibleTargetCandidates(screenshot, candidateColor))
      .filter((candidate) => candidate.y >= minY && candidate.y <= maxY)
      .sort((left, right) => {
        const leftPreferred = left.pixels >= 40 && left.pixels <= 1_000 ? 0 : 1;
        const rightPreferred = right.pixels >= 40 && right.pixels <= 1_000 ? 0 : 1;
        if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
        if (preferLower && leftPreferred === 0 && left.y !== right.y) return right.y - left.y;
        if (preferRectangular && leftPreferred === 0) {
          const leftShape = Math.min(left.width, left.height) >= 12 && Math.max(left.width, left.height) >= 20
            ? Math.max(left.width / left.height, left.height / left.width) : 0;
          const rightShape = Math.min(right.width, right.height) >= 12 && Math.max(right.width, right.height) >= 20
            ? Math.max(right.width / right.height, right.height / right.width) : 0;
          if (leftShape !== rightShape) return rightShape - leftShape;
        }
        const leftScore = left.pixels / (1 + Math.hypot(left.x - 480, left.y - 270) * 0.02);
        const rightScore = right.pixels / (1 + Math.hypot(right.x - 480, right.y - 270) * 0.02);
        return rightScore - leftScore;
      });
    const candidate = candidates.find(({ x, y }) => (
      attempted.every((previous) => Math.hypot(previous.x - x, previous.y - y) > 18)
    ));
    if (candidate === undefined) {
      await page.waitForTimeout(delay);
      continue;
    }
    attempted.push(candidate);
    console.log(`[visible-target] ${colorLabel} attempt ${attempt + 1}: ${candidate.x},${candidate.y} (${candidate.width}x${candidate.height}, ${candidate.pixels}px)`);
    await page.mouse.click(candidate.x, candidate.y);
    const deadline = Date.now() + delay;
    while (Date.now() < deadline) {
      await page.waitForTimeout(Math.min(50, deadline - Date.now()));
      if (await complete()) return candidate;
    }
  }
  return undefined;
}
