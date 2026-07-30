// Генератор контура штриха в духе perfect-freehand (движок tldraw) и Procreate.
//
// Идея: вместо обводки полилинии переменной толщиной строится замкнутый контур
// пера, который заливается одной заливкой. Это даёт то, чего не даёт stroke():
//   • «шлейф» (streamline) — точки указателя догоняются с задержкой, поэтому
//     дрожание руки и ступеньки от дискретных событий не попадают в линию;
//   • толщина от нажима стилуса, а без нажима — от скорости (быстрее → тоньше);
//   • острые углы обходятся дугой, а не «шипом» от смещённых нормалей;
//   • концы — круглая шапка или сужение (taper);
//   • ровная альфа у маркера: одна заливка не даёт самоналожения.
//
// Единицы — мировые пиксели доски; контур строится в мировых координатах,
// поэтому его можно закэшировать и переиспользовать при прокрутке камеры.

const FIXED_PI = Math.PI + 0.0001;          // чуть больше π, чтобы дуга замыкалась
const RATE_OF_PRESSURE_CHANGE = 0.275;      // инерция «нажима» при симуляции по скорости

// --- вектора: пары [x, y] ---
const add  = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub  = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul  = (a, n) => [a[0] * n, a[1] * n];
const neg  = a => [-a[0], -a[1]];
const per  = a => [a[1], -a[0]];                       // перпендикуляр
const dpr  = (a, b) => a[0] * b[0] + a[1] * b[1];      // скалярное произведение
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const uni  = a => { const m = Math.hypot(a[0], a[1]); return m ? [a[0] / m, a[1] / m] : [0, 0]; };
const lrp  = (a, b, t) => add(a, mul(sub(b, a), t));
const prj  = (a, b, n) => add(a, mul(b, n));
const rot  = (a, c, r) => {                            // поворот точки a вокруг c на r
  const s = Math.sin(r), k = Math.cos(r);
  const x = a[0] - c[0], y = a[1] - c[1];
  return [x * k - y * s + c[0], x * s + y * k + c[1]];
};

// Радиус пера в точке: нажим 0.5 даёт ровно половину номинальной толщины,
// thinning растягивает диапазон вокруг неё (0 — постоянная ширина).
function strokeRadius(size, thinning, pressure, easing) {
  if (!thinning) return size / 2;
  return size * easing(Math.max(0, Math.min(1, 0.5 - thinning * (0.5 - pressure))));
}

// Лёгкое усреднение по трём соседям — снимает высокочастотное дрожание руки,
// не сдвигая линию (в отличие от «шлейфа», задержки не добавляет). Концы не
// трогаем: начало и конец штриха должны остаться там, где их поставили.
function damp(points, w) {
  const n = points.length;
  if (n < 3 || w <= 0) return points;
  const m = 1 - 2 * w;
  const out = new Array(n);
  out[0] = points[0];
  for (let i = 1; i < n - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1];
    out[i] = {
      x: a.x * w + b.x * m + c.x * w,
      y: a.y * w + b.y * m + c.y * w,
      pressure: b.pressure
    };
  }
  out[n - 1] = points[n - 1];
  return out;
}

// Прореживание и «шлейф»: каждая следующая точка не берётся как есть, а
// подтягивается к предыдущей на (1 - streamline). Возвращает точки с
// направлением (вектор назад), длиной шага и пройденной длиной.
export function getStrokePoints(rawPoints, { size = 8, streamline = 0.5, jitter = 0.15, last = false } = {}) {
  const out = [];
  if (!rawPoints.length) return out;
  const points = damp(rawPoints, jitter);
  const n = points.length;

  const firstPressure = Number.isFinite(points[0].pressure) ? points[0].pressure : 0.25;
  let prev = {
    point: [points[0].x, points[0].y],
    pressure: firstPressure,
    vector: [1, 1],
    distance: 0,
    runningLength: 0
  };
  out.push(prev);
  if (n === 1) return out;

  const t = 1 - streamline;
  const max = n - 1;
  let running = 0;
  let reachedMin = false;

  for (let i = 1; i < n; i++) {
    const raw = [points[i].x, points[i].y];
    // Последнюю точку завершённого штриха не сглаживаем — линия приходит точно
    // туда, где оторвали перо.
    const point = (last && i === max) ? raw : lrp(prev.point, raw, t);
    if (point[0] === prev.point[0] && point[1] === prev.point[1]) continue;

    const d = dist(point, prev.point);
    running += d;

    // Пока штрих короче толщины пера, промежуточные точки не нужны —
    // иначе короткий тычок распухает в кляксу.
    if (i < max && !reachedMin) {
      if (running < size) continue;
      reachedMin = true;
    }

    prev = {
      point,
      pressure: Number.isFinite(points[i].pressure) ? points[i].pressure : 0.5,
      vector: uni(sub(prev.point, point)),
      distance: d,
      runningLength: running
    };
    out.push(prev);
  }

  out[0].vector = out[1] ? out[1].vector : [0, 0];
  return out;
}

// Контур штриха: массив точек [x, y], обходящий перо слева, через конец,
// справа обратно и через стартовую шапку.
export function getStrokeOutline(rawPoints, options = {}) {
  const {
    size = 8,
    thinning = 0.5,
    smoothing = 0.5,
    streamline = 0.5,
    simulatePressure = true,
    jitter = 0.15,
    easing = t => t,
    last: isComplete = false,
    taperStart = 0,
    taperEnd = 0,
    capStart = true,
    capEnd = true,
    taperStartEase = t => t * (2 - t),
    taperEndEase = t => (t - 1) ** 3 + 1
  } = options;

  if (!rawPoints || !rawPoints.length || size <= 0) return [];

  const points = getStrokePoints(rawPoints, { size, streamline, jitter, last: isComplete });
  if (!points.length) return [];

  const totalLength = points[points.length - 1].runningLength;
  const minDistance = (size * smoothing) ** 2;

  // Сужение занимает не больше трети линии и требует точек, по которым его
  // рисовать: короткий росчерк из пары событий иначе весь ушёл бы в остриё
  // и стал бы невидимым.
  const tStart = points.length < 5 ? 0 : Math.min(taperStart, totalLength * 0.34);
  const tEnd = points.length < 5 ? 0 : Math.min(taperEnd, totalLength * 0.34);
  const leftPts = [];
  const rightPts = [];

  // Стартовый нажим — среднее по первым точкам: линии почти всегда начинаются
  // медленно, и без усреднения каждый штрих получал бы жирный «хвостик» в начале.
  let prevPressure = points.slice(0, 10).reduce((acc, curr) => {
    let pressure = curr.pressure;
    if (simulatePressure) {
      const sp = Math.min(1, curr.distance / size);    // быстро → тонко
      const rp = Math.min(1, 1 - sp);
      pressure = Math.min(1, acc + (rp - acc) * (sp * RATE_OF_PRESSURE_CHANGE));
    }
    return (acc + pressure) / 2;
  }, points[0].pressure);

  let radius = strokeRadius(size, thinning, points[points.length - 1].pressure, easing);
  let firstRadius;
  let prevVector = points[0].vector;
  let pl = points[0].point;
  let pr = pl;
  let tl = pl;
  let tr = pr;
  let isPrevPointSharpCorner = false;

  for (let i = 0; i < points.length; i++) {
    const { point, vector, distance, runningLength } = points[i];
    let pressure = points[i].pressure;

    // Хвостовой шум у конца линии только портит форму
    if (i < points.length - 1 && totalLength - runningLength < 3) continue;

    if (thinning) {
      if (simulatePressure) {
        const sp = Math.min(1, distance / size);
        const rp = Math.min(1, 1 - sp);
        pressure = Math.min(1, prevPressure + (rp - prevPressure) * (sp * RATE_OF_PRESSURE_CHANGE));
      }
      radius = strokeRadius(size, thinning, pressure, easing);
    } else {
      radius = size / 2;
    }
    if (firstRadius === undefined) firstRadius = radius;

    // Сужение у концов
    const ts = runningLength < tStart
      ? taperStartEase(runningLength / tStart)
      : 1;
    const te = totalLength - runningLength < tEnd
      ? taperEndEase((totalLength - runningLength) / tEnd)
      : 1;
    radius = Math.max(0.01, radius * Math.min(ts, te));

    const nextVector = (i < points.length - 1 ? points[i + 1] : points[i]).vector;
    const nextDpr = i < points.length - 1 ? dpr(vector, nextVector) : 1;
    const prevDpr = dpr(vector, prevVector);
    const isPointSharpCorner = prevDpr < 0 && !isPrevPointSharpCorner;
    const isNextPointSharpCorner = nextDpr < 0;

    // Резкий разворот (острее 90°): вместо пересекающихся нормалей — полукруг,
    // как будто перо провернулось на месте.
    if (isPointSharpCorner || isNextPointSharpCorner) {
      const offset = mul(per(prevVector), radius);
      for (let step = 1 / 13, t = 0; t <= 1; t += step) {
        tl = rot(sub(point, offset), point, FIXED_PI * t);
        leftPts.push(tl);
        tr = rot(add(point, offset), point, FIXED_PI * -t);
        rightPts.push(tr);
      }
      pl = tl;
      pr = tr;
      if (isNextPointSharpCorner) isPrevPointSharpCorner = true;
      continue;
    }

    isPrevPointSharpCorner = false;

    if (i === points.length - 1) {
      const offset = mul(per(vector), radius);
      leftPts.push(sub(point, offset));
      rightPts.push(add(point, offset));
      continue;
    }

    // Обычная точка: нормаль усредняется с направлением следующего сегмента,
    // поэтому на изгибах контур не «ломается».
    const offset = mul(per(lrp(nextVector, vector, nextDpr)), radius);
    tl = sub(point, offset);
    if (i <= 1 || dist2(pl, tl) > minDistance) { leftPts.push(tl); pl = tl; }
    tr = add(point, offset);
    if (i <= 1 || dist2(pr, tr) > minDistance) { rightPts.push(tr); pr = tr; }

    prevPressure = pressure;
    prevVector = vector;
  }

  const firstPoint = points[0].point;
  const lastPoint = points.length > 1
    ? points[points.length - 1].point
    : add(points[0].point, [1, 1]);
  const startCap = [];
  const endCap = [];

  // Точка (тычок пером) — круг
  if (points.length === 1) {
    if (!(tStart || tEnd) || isComplete) {
      const start = prj(firstPoint, uni(per(sub(firstPoint, lastPoint))), -(firstRadius || radius));
      const dot = [];
      for (let step = 1 / 13, t = step; t <= 1; t += step) {
        dot.push(rot(start, firstPoint, FIXED_PI * 2 * t));
      }
      return dot;
    }
  } else {
    // Шапка в начале: сужение — острый вход, иначе полукруг или срез
    if (tStart || (tEnd && points.length === 1)) {
      // сужение уже свело контур в точку
    } else if (capStart) {
      for (let step = 1 / 13, t = step; t <= 1; t += step) {
        startCap.push(rot(rightPts[0], firstPoint, FIXED_PI * t));
      }
    } else {
      const corners = sub(leftPts[0], rightPts[0]);
      const a = mul(corners, 0.5);
      const b = mul(corners, 0.51);
      startCap.push(sub(firstPoint, a), sub(firstPoint, b), add(firstPoint, b), add(firstPoint, a));
    }

    // Шапка в конце
    const direction = per(neg(points[points.length - 1].vector));
    if (tEnd || (tStart && points.length === 1)) {
      endCap.push(lastPoint);
    } else if (capEnd) {
      const start = prj(lastPoint, direction, radius);
      for (let step = 1 / 29, t = step; t < 1; t += step) {
        endCap.push(rot(start, lastPoint, FIXED_PI * 3 * t));
      }
    } else {
      endCap.push(
        add(lastPoint, mul(direction, radius)),
        add(lastPoint, mul(direction, radius * 0.99)),
        sub(lastPoint, mul(direction, radius * 0.99)),
        sub(lastPoint, mul(direction, radius))
      );
    }
  }

  return leftPts.concat(endCap, rightPts.reverse(), startCap);
}

// Контур → Path2D. Углы многоугольника скругляются квадратичными кривыми
// через середины рёбер (так же строит путь tldraw), поэтому даже редкий контур
// выглядит гладким на любом зуме.
export function inkPath(outline) {
  const path = new Path2D();
  const n = outline.length;
  if (!n) return path;

  if (n < 4) {
    path.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < n; i++) path.lineTo(outline[i][0], outline[i][1]);
    path.closePath();
    return path;
  }

  let a = outline[0];
  let b = outline[1];
  path.moveTo((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  for (let i = 1; i <= n; i++) {
    a = outline[i % n];
    b = outline[(i + 1) % n];
    path.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  path.closePath();
  return path;
}
