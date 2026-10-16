export type Example = 'paint' | 'departures' | 'telemetry';

const ink = '#173a31';
const cream = '#fffbee';
const lime = '#daee9c';

function label(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  size = 20,
  color = ink,
) {
  ctx.fillStyle = color;
  ctx.font = `600 ${size}px "Segoe UI", sans-serif`;
  ctx.fillText(value, x, y);
}

export function paintBlank(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = cream;
  ctx.fillRect(0, 0, 800, 500);
}

export function paintWelcome(ctx: CanvasRenderingContext2D) {
  paintBlank(ctx);
  ctx.strokeStyle = '#e8e7d5';
  ctx.lineWidth = 1;
  for (let x = 25; x < 800; x += 30) {
    for (let y = 25; y < 500; y += 30) {
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  label(ctx, 'MAKE YOUR MARK', 46, 60, 19);
  ctx.fillStyle = lime;
  ctx.beginPath();
  ctx.roundRect(42, 94, 444, 278, 22);
  ctx.fill();
  label(ctx, 'Hello,', 71, 202, 78);
  label(ctx, 'world!', 71, 294, 78);
  // A friendly hand-drawn sun leaves room for the visitor's own marks.
  ctx.strokeStyle = '#ff6840';
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  for (let n = 0; n < 10; n++) {
    const a = (n * Math.PI) / 5;
    ctx.beginPath();
    ctx.moveTo(626 + Math.cos(a) * 76, 215 + Math.sin(a) * 76);
    ctx.lineTo(626 + Math.cos(a) * 95, 215 + Math.sin(a) * 95);
    ctx.stroke();
  }
  ctx.fillStyle = '#ffcc62';
  ctx.beginPath();
  ctx.arc(626, 215, 57, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = ink;
  for (const x of [607, 644]) {
    ctx.beginPath();
    ctx.arc(x, 208, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = ink;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(626, 220, 22, 0.2, Math.PI - 0.2);
  ctx.stroke();
  ctx.strokeStyle = '#ff6840';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(515, 355);
  ctx.bezierCurveTo(560, 322, 621, 387, 724, 345);
  ctx.stroke();
  label(ctx, 'YOUR CANVAS. YOUR CORNER OF THE WORLD.', 46, 445, 19, '#7e8a66');
}

export function paintDepartures(ctx: CanvasRenderingContext2D, time: number) {
  ctx.fillStyle = ink;
  ctx.fillRect(0, 0, 800, 500);
  label(ctx, 'NORTH STATION', 40, 55, 21, lime);
  label(ctx, 'Departures', 40, 118, 48, cream);
  const seconds = Math.floor(time);
  label(
    ctx,
    `12:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`,
    588,
    64,
    28,
    lime,
  );
  ctx.fillStyle = '#38564a';
  ctx.fillRect(40, 147, 720, 2);
  label(ctx, 'DESTINATION', 42, 186, 15, '#99b0a0');
  label(ctx, 'PLATFORM', 411, 186, 15, '#99b0a0');
  label(ctx, 'LEAVES IN', 626, 186, 15, '#99b0a0');
  const destinations = ['Harbor Gardens', 'Old Town', 'Sunset Beach'];
  destinations.forEach((name, i) => {
    const y = 245 + i * 81;
    label(ctx, name, 42, y, 28, cream);
    label(ctx, `0${i + 2}`, 446, y, 28, cream);
    label(ctx, `${42 + i * 43 - (seconds % 40)}s`, 651, y, 28, i === 0 ? lime : cream);
    ctx.fillStyle = '#38564a';
    ctx.fillRect(40, y + 27, 720, 1);
  });
  label(ctx, 'LIVE UPDATES', 42, 468, 15, lime);
  label(ctx, 'NEXT STOP: SOMEWHERE NEW', 440, 468, 15, '#99b0a0');
}

export function paintTelemetry(ctx: CanvasRenderingContext2D, time: number) {
  ctx.fillStyle = '#14283a';
  ctx.fillRect(0, 0, 800, 500);
  const speed = Math.round(58 + 25 * Math.sin(time * 0.8));
  label(ctx, 'ROVER / FIELD TELEMETRY', 38, 49, 20, '#b8dce1');
  label(ctx, 'SIGNAL ONLINE', 613, 49, 15, '#bced9b');
  const cx = 205;
  const cy = 273;
  const radius = 122;
  ctx.lineWidth = 21;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#2d4654';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, Math.PI * 0.8, Math.PI * 2.2);
  ctx.stroke();
  ctx.strokeStyle = '#c8ee9a';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, Math.PI * 0.8, Math.PI * (0.8 + (1.4 * speed) / 100));
  ctx.stroke();
  ctx.textAlign = 'center';
  label(ctx, String(speed), cx, cy + 9, 80, '#f5fbe9');
  label(ctx, 'KM / H', cx, cy + 44, 16, '#91b0ba');
  ctx.textAlign = 'left';
  label(ctx, 'POWER OUTPUT', 408, 130, 18, '#91b0ba');
  label(ctx, `${(3.4 + Math.sin(time) * 0.8).toFixed(1)} kW`, 408, 183, 42, '#f5fbe9');
  ctx.strokeStyle = '#2d4654';
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(405, 217 + i * 40);
    ctx.lineTo(753, 217 + i * 40);
    ctx.stroke();
  }
  ctx.strokeStyle = '#77d3dd';
  ctx.lineWidth = 4;
  ctx.beginPath();
  for (let i = 0; i <= 100; i++) {
    const x = 405 + i * 3.48;
    const y = 277 - Math.sin(i * 0.14 - time * 1.6) * 33 - Math.sin(i * 0.36 + time) * 12;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = '#263e4c';
  ctx.beginPath();
  ctx.roundRect(38, 406, 724, 60, 10);
  ctx.fill();
  label(ctx, 'BATTERY  86%', 60, 444, 20, '#c8ee9a');
  label(ctx, 'MOTOR  42°C', 321, 444, 20, '#b8dce1');
  label(ctx, 'RANGE  128 km', 565, 444, 20, '#b8dce1');
}
