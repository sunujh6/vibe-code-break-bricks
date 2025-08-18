import React, { useEffect, useRef, useState } from "react";

/**
 * React Breakout — 레벨별 아이템 4개(그중 1개 피어싱) + 커서 숨김 + 레벨3 이후 행수 고정 + 레벨별 라이프 2
 *
 * 변경 요약:
 * - **마우스 커서 숨김**(Canvas 내부)
 * - **레벨 3부터는 레벨 2와 동일한 브릭 수(행 수)**
 *   → 브릭이 너무 촘촘해지는 문제 해결. 대신 **빨간(HP≥2) 하드브릭 비율 증가**
 * - **레벨별 라이프 2개**: 각 레벨 시작 시 라이프를 2로 리셋
 * - 레벨당 아이템 벽돌 **정확히 4개** 배치(가능 시), 그중 **정확히 1개는 피어싱 공** 스폰
 * - 레벨업 시 공 속도 **+5%**(지수 증가), 최대 5레벨
 * - 하드브릭(HP≥2)은 **빨간색 + 크랙** 렌더링, 피어싱 공은 **벽돌만 관통**
 */

// ===== 설정값 =====
const W = 720;            // 캔버스 폭
const H = 480;            // 캔버스 높이
const PADDLE_W = 110;
const PADDLE_H = 16;
const BALL_R = 8;
const INIT_SPEED = 340;   // px/s (기준 속도)
const LIVES_INIT = 2;     // 레벨마다 2회 시도
const MAX_LEVEL = 5;
const MAX_ITEMS_PER_LEVEL = 4;  // 레벨마다 아이템 4개

// 브릭 레이아웃
const MARGIN_X = 32;
const MARGIN_TOP = 56;
const GAP_X = 8;
const GAP_Y = 10;

// 아이템 타입
const ITEM_NONE = 0;
const ITEM_MULTIBALL = 1; // 공 1개 추가 (피어싱 여부는 brick 속성으로 지정)

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (min, max) => Math.random() * (max - min) + min;
const deg2rad = (d) => (Math.PI / 180) * d;
const speedForLevel = (lvl) => INIT_SPEED * Math.pow(1.05, Math.max(0, lvl - 1)); // 레벨당 +5%

// --- 원-사각형 충돌 ---
function circleRectCollide(cx, cy, r, rx, ry, rw, rh) {
  const closestX = clamp(cx, rx, rx + rw);
  const closestY = clamp(cy, ry, ry + rh);
  const dx = cx - closestX;
  const dy = cy - closestY;
  return dx * dx + dy * dy <= r * r;
}

// --- Self Tests ---
function runSelfTests() {
  try {
    // 충돌 기본/접촉
    console.assert(circleRectCollide(12, 12, 5, 10, 10, 10, 10) === true, "circleRectCollide overlapping");
    console.assert(circleRectCollide(0, 0, 4, 20, 20, 10, 10) === false, "circleRectCollide far");
    console.assert(circleRectCollide(10, 10, 5, 15, 6, 10, 8) === true, "edge touching = collision");

    // 속도 스케일
    const s1 = speedForLevel(1); const s2 = speedForLevel(2); const s5 = speedForLevel(5);
    console.assert(Math.abs(s2 - s1 * 1.05) < 1e-6, "lvl2 = lvl1*1.05");
    console.assert(Math.abs(s5 - s1 * Math.pow(1.05, 4)) < 1e-6, "lvl5 = lvl1*1.05^4");

    console.log("[Breakout] Self-tests passed");
  } catch (e) {
    console.warn("[Breakout] Self-tests failed:", e);
  }
}

export default function Breakout() {
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const lastRef = useRef(0);
  const speedRef = useRef(speedForLevel(1));

  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(LIVES_INIT);
  const [level, setLevel] = useState(1);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [message, setMessage] = useState("클릭 또는 Space로 시작");
  const [gameOverOpen, setGameOverOpen] = useState(false);
  const [winOpen, setWinOpen] = useState(false);

  // 가변 게임 객체
  const paddle = useRef({ x: W / 2, y: H - 48, w: PADDLE_W, h: PADDLE_H, dir: 0 });
  const balls = useRef([]);  // {x,y,vx,vy,r,stuck,main,piercing}
  const bricks = useRef([]); // {x,y,w,h,hp,maxHp,cracked,item,piercingItem}

  // DPI 스케일
  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    c.width = W * dpr; c.height = H * dpr; c.style.width = W + "px"; c.style.height = H + "px";
    const ctx = c.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, []);

  // 레벨 그리드 생성: 아이템 4개(1 피어싱) 지정 + 레벨3부터 행수 고정(L2와 동일)
  const computeBrickGrid = (lvl) => {
    const cols = 10;
    const rowsAt2 = clamp(4 + 2 * 2 - 1, 5, 12); // 레벨2 행 수 = 7
    const rows = lvl >= 3 ? rowsAt2 : clamp(4 + lvl * 2 - 1, 5, 12);

    const cellW = Math.floor((W - MARGIN_X * 2 - GAP_X * (cols - 1)) / cols);
    const cellH = 22;
    const bw = Math.floor(cellW * 0.8);
    const bh = Math.floor(cellH * 0.8);
    const offX = Math.floor((cellW - bw) / 2);
    const offY = Math.floor((cellH - bh) / 2);

    // 하드브릭/HP3 비율 — 3레벨부터 공격적으로 증가
    const pHard = lvl < 3 ? clamp(0.25 + 0.08 * (lvl - 1), 0.25, 0.45)
                          : clamp(0.55 + 0.06 * (lvl - 3), 0.55, 0.8);
    const pHp3  = lvl >= 4 ? clamp(0.18 + 0.08 * (lvl - 4), 0.18, 0.35) : 0; // L4+에서 HP3 등장

    // 1) 기본 브릭 채우기
    const arr = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cellX = MARGIN_X + c * (cellW + GAP_X);
        const cellY = MARGIN_TOP + r * (cellH + GAP_Y);
        let maxHp = 1;
        if (Math.random() < pHard) maxHp = 2;
        if (Math.random() < pHp3) maxHp = 3;
        arr.push({ x: cellX + offX, y: cellY + offY, w: bw, h: bh, hp: maxHp, maxHp, cracked: false, item: ITEM_NONE, piercingItem: false });
      }
    }

    // 2) 레벨별 아이템 4개 배치(가능 시), 그중 1개는 피어싱 전용
    const numItems = Math.min(MAX_ITEMS_PER_LEVEL, arr.length);
    const idxs = new Set();
    while (idxs.size < numItems) idxs.add(Math.floor(Math.random() * arr.length));
    const itemIdxList = Array.from(idxs);
    itemIdxList.forEach(i => { arr[i].item = ITEM_MULTIBALL; });
    if (itemIdxList.length > 0) {
      const pierceIdx = itemIdxList[Math.floor(Math.random() * itemIdxList.length)];
      arr[pierceIdx].piercingItem = true; // 정확히 1개만 피어싱
    }
    return arr;
  };

  // 볼 생성
  const spawnBall = (x, y, speed = speedRef.current, piercing = false) => {
    const a = deg2rad(rand(30, 150));
    balls.current.push({ x, y, vx: Math.cos(a) * speed, vy: -Math.abs(Math.sin(a) * speed), r: BALL_R, stuck: false, main: false, piercing });
  };

  // 리셋/시작
  const resetBallAndPaddle = () => {
    paddle.current.x = W / 2; paddle.current.y = H - 48; paddle.current.dir = 0;
    balls.current = [];
    const x = paddle.current.x, y = paddle.current.y - 22;
    const a = deg2rad(rand(30, 150));
    const vx = speedRef.current * Math.cos(a);
    let vy = -Math.abs(speedRef.current * Math.sin(a));
    if (vy > -120) vy = -120; // 너무 수평 방지
    balls.current.push({ x, y, vx, vy, r: BALL_R, stuck: true, main: true, piercing: false });
  };

  const newGame = () => {
    setScore(0); setLives(LIVES_INIT); setLevel(1);
    speedRef.current = speedForLevel(1);
    bricks.current = computeBrickGrid(1);
    resetBallAndPaddle();
    setMessage("클릭 또는 Space로 시작");
    setRunning(false); setPaused(false); setGameOverOpen(false); setWinOpen(false);
  };

  useEffect(() => { newGame(); runSelfTests(); /* eslint-disable-next-line */ }, []);

  // 입력 처리
  useEffect(() => {
    const onKey = (e) => {
      if (e.type === "keydown") {
        if (e.code === "ArrowLeft" || e.code === "KeyA") paddle.current.dir = -1;
        if (e.code === "ArrowRight" || e.code === "KeyD") paddle.current.dir = 1;

        if (e.code === "Space") {
          if (gameOverOpen || winOpen) { newGame(); return; } // 팝업 중엔 새 게임
          const main = balls.current[0];
          if (!running) { setRunning(true); setMessage(""); if (main) main.stuck = false; return; }
          if (paused) { setPaused(false); return; }
          if (main && main.stuck) { main.stuck = false; return; }
          setPaused((p) => !p);
        }
        if (e.code === "Enter" && (gameOverOpen || winOpen)) newGame();
      } else {
        if ((e.code === "ArrowLeft" || e.code === "KeyA") && paddle.current.dir === -1) paddle.current.dir = 0;
        if ((e.code === "ArrowRight" || e.code === "KeyD") && paddle.current.dir === 1) paddle.current.dir = 0;
      }
    };

    const onMouseMove = (e) => {
      const rect = canvasRef.current?.getBoundingClientRect(); if (!rect) return;
      const x = clamp(e.clientX - rect.left, 0, W);
      paddle.current.x = clamp(x, PADDLE_W / 2, W - PADDLE_W / 2);
      const main = balls.current[0]; if (main && main.stuck) { main.x = paddle.current.x; main.y = paddle.current.y - 22; }
    };

    const onTouchMove = (e) => {
      const t = e.touches[0]; if (!t) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      const x = clamp(t.clientX - rect.left, 0, W);
      paddle.current.x = clamp(x, PADDLE_W / 2, W - PADDLE_W / 2);
      const main = balls.current[0]; if (main && main.stuck) { main.x = paddle.current.x; main.y = paddle.current.y - 22; }
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("touchmove", onTouchMove);
    };
  }, [running, paused, gameOverOpen, winOpen]);

  // 크랙 렌더링
  const drawCrack = (ctx, b) => {
    ctx.save();
    ctx.strokeStyle = "rgba(15,23,42,0.85)"; ctx.lineWidth = 1;
    const cx = b.x + b.w / 2; const cy = b.y + b.h / 2;
    ctx.beginPath(); ctx.moveTo(b.x + 2, cy); ctx.lineTo(b.x + b.w - 2, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(b.x + 2, b.y + 2); ctx.lineTo(b.x + b.w - 2, b.y + b.h - 2); ctx.stroke();
    if (b.maxHp >= 3) { ctx.beginPath(); ctx.moveTo(cx, b.y + 2); ctx.lineTo(cx, b.y + b.h - 2); ctx.stroke(); }
    ctx.restore();
  };

  // 아이템 아이콘 (피어싱은 초록 테두리)
  const drawItemIcon = (ctx, b) => {
    if (b.item !== ITEM_MULTIBALL) return;
    ctx.save();
    ctx.translate(b.x + b.w / 2, b.y + b.h / 2);
    ctx.beginPath(); ctx.arc(0, 0, Math.min(b.w, b.h) * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = "#f8fafc"; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = b.piercingItem ? "#22c55e" : "#0f172a"; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-3, 0); ctx.lineTo(3, 0); ctx.moveTo(0, -3); ctx.lineTo(0, 3); ctx.stroke();
    ctx.restore();
  };

  // 게임 루프
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d"); if (!ctx) return;

    const drawBricks = () => {
      for (const b of bricks.current) {
        if (b.hp <= 0) continue;
        // 빨강: 하드브릭(HP>=2), 하늘: 일반
        ctx.fillStyle = b.maxHp >= 2 ? "#ef4444" : "#38bdf8";
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.strokeStyle = "rgba(15,23,42,0.35)"; ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
        if (b.maxHp > 1 && b.hp < b.maxHp) drawCrack(ctx, b);
        drawItemIcon(ctx, b);
      }
    };

    const drawPaddle = () => {
      ctx.fillStyle = "#eab308";
      const { x, y, w, h } = paddle.current; ctx.fillRect(x - w / 2, y - h / 2, w, h);
    };

    const drawBalls = () => {
      for (const ball of balls.current) {
        ctx.beginPath(); ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
        ctx.fillStyle = ball.piercing ? "#34d399" : (ball.main ? "#f8fafc" : "#c7d2fe");
        ctx.fill(); ctx.closePath();
      }
    };

    const drawHUD = () => {
      ctx.fillStyle = "#94a3b8";
      ctx.font = "bold 14px ui-sans-serif, -apple-system, Segoe UI";
      ctx.fillText(`Score: ${score}`, 12, 18);
      ctx.fillText(`Lives: ${lives}`, 110, 18);
      ctx.fillText(`Level: ${level}/${MAX_LEVEL}`, 190, 18);
      if (!running || paused) {
        ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = "#e2e8f0"; ctx.font = "bold 22px ui-sans-serif"; ctx.textAlign = "center";
        ctx.fillText(paused ? "일시정지" : message, W / 2, H / 2 - 8);
        ctx.font = "normal 13px ui-sans-serif";
        ctx.fillText("Space: 시작/일시정지/발사  •  ←/→ 또는 마우스/터치로 이동", W / 2, H / 2 + 18);
        ctx.textAlign = "start";
      }
    };

    const step = (t) => {
      const now = t / 1000; const last = lastRef.current || now; const dt = clamp(now - last, 0, 0.03); lastRef.current = now;

      if (running && !paused) {
        // 패들 이동
        const px = paddle.current.x + paddle.current.dir * 520 * dt;
        paddle.current.x = clamp(px, PADDLE_W / 2, W - PADDLE_W / 2);
        const main = balls.current[0];
        if (main && main.stuck) { main.x = paddle.current.x; main.y = paddle.current.y - 22; }
        else {
          // 볼 이동/벽 반사/패들 반사
          for (const ball of balls.current) {
            ball.x += ball.vx * dt; ball.y += ball.vy * dt;
            if (ball.x < BALL_R) { ball.x = BALL_R; ball.vx *= -1; }
            if (ball.x > W - BALL_R) { ball.x = W - BALL_R; ball.vx *= -1; }
            if (ball.y < BALL_R) { ball.y = BALL_R; ball.vy *= -1; }

            const { x: px2, y: py2, w, h } = paddle.current;
            if (circleRectCollide(ball.x, ball.y, BALL_R, px2 - w / 2, py2 - h / 2, w, h) && ball.vy > 0) {
              const rel = clamp((ball.x - px2) / (w / 2), -1, 1);
              const speed = Math.hypot(ball.vx, ball.vy);
              let angleDeg = -65 + 130 * ((rel + 1) / 2); angleDeg = clamp(angleDeg * 1.1, -78, 78);
              const a = deg2rad(angleDeg);
              ball.vx = Math.cos(a) * speed; ball.vy = -Math.abs(Math.sin(a) * speed);
              const minVy = speed * 0.35; if (Math.abs(ball.vy) < minVy) ball.vy = -minVy;
              ball.y = py2 - h / 2 - BALL_R - 0.1;
            }
          }

          // 브릭 충돌
          for (const ball of balls.current) {
            for (const b of bricks.current) {
              if (b.hp <= 0) continue;
              if (circleRectCollide(ball.x, ball.y, BALL_R, b.x, b.y, b.w, b.h)) {
                // 반사 (피어싱이면 벽돌 관통, 반사 생략)
                if (!ball.piercing) {
                  const prevX = ball.x - ball.vx * dt; const prevY = ball.y - ball.vy * dt;
                  const hitXBefore = prevX < b.x || prevX > b.x + b.w;
                  const hitYBefore = prevY < b.y || prevY > b.y + b.h;
                  if (hitXBefore && !hitYBefore) ball.vx *= -1; else ball.vy *= -1;
                }

                // 데미지 & 크랙
                b.hp -= 1; if (b.maxHp > 1 && b.hp < b.maxHp) b.cracked = true;
                setScore((s) => s + (b.hp <= 0 ? 50 : 20));

                // 파괴 시 아이템 처리 (레벨당 4개로 이미 지정됨)
                if (b.hp <= 0 && b.item === ITEM_MULTIBALL) {
                  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
                  spawnBall(cx, cy, speedRef.current * 0.95, !!b.piercingItem);
                }

                if (!ball.piercing) break; // 비피어싱은 한 번에 한 벽돌만
              }
            }
          }

          // 바닥 추락한 볼 제거
          for (let i = balls.current.length - 1; i >= 0; i--) {
            if (balls.current[i].y > H + BALL_R) balls.current.splice(i, 1);
          }

          // 모든 볼 소멸 → 라이프 감소
          if (balls.current.length === 0) {
            setLives((L) => {
              const left = L - 1;
              if (left <= 0) { setRunning(false); setPaused(false); setGameOverOpen(true); return 0; }
              resetBallAndPaddle(); const m2 = balls.current[0]; if (m2) m2.stuck = true; return left;
            });
          }

          // 레벨 클리어
          if (bricks.current.every((b) => b.hp <= 0)) {
            setLevel((lv) => {
              const nxt = lv + 1;
              if (nxt > MAX_LEVEL) { setRunning(false); setPaused(false); setWinOpen(true); return lv; }
              speedRef.current = speedForLevel(nxt);
              bricks.current = computeBrickGrid(nxt);
              setLives(LIVES_INIT); // ★ 각 레벨 시작 시 라이프 2로 리셋
              resetBallAndPaddle(); const m2 = balls.current[0]; if (m2) m2.stuck = true;
              setMessage(`Level ${nxt}! Space로 시작`); setRunning(false); setPaused(false);
              return nxt;
            });
          }
        }
      }

      // 렌더
      ctx.clearRect(0, 0, W, H);
      const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#0f172a"); g.addColorStop(1, "#111827");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      drawBricks(); drawPaddle(); drawBalls(); drawHUD();

      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [running, paused, score, lives, level]);

  const onCanvasClick = () => {
    if (gameOverOpen || winOpen) return;
    const main = balls.current[0];
    if (!running) { setRunning(true); setMessage(""); if (main) main.stuck = false; return; }
    if (paused) { setPaused(false); return; }
    if (main && main.stuck) { main.stuck = false; return; }
  };

  return (
    <div className="min-h-[100dvh] bg-neutral-900 text-neutral-100 py-6">
      <div className="max-w-5xl mx-auto px-4 grid gap-4">
        <header className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-2xl md:text-3xl font-bold">React 벽돌깨기 — 레벨3 행수 고정 · 라이프2/레벨</h1>
          <div className="flex items-center gap-2">
            <button onClick={() => { setPaused((p) => !p); setRunning(true); setMessage(""); const m = balls.current[0]; if (m) m.stuck = false; }} className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700">{paused || !running ? "시작/계속" : "일시정지"}</button>
            <button onClick={newGame} className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700">새 게임</button>
          </div>
        </header>

        <div className="rounded-2xl shadow-inner ring-1 ring-neutral-700 overflow-hidden w-fit mx-auto">
          {/* 커서 숨김: cursor-none */}
          <canvas ref={canvasRef} width={W} height={H} onClick={onCanvasClick} className="block bg-neutral-950 cursor-none select-none"/>
        </div>

        <div className="text-xs text-neutral-400 text-center">
          조작: ←/→ 또는 A/D, 마우스/터치 이동 · Space: 시작/일시정지/발사 · 승리/오버 시 Space/Enter = 새 게임
        </div>
      </div>

      {/* 게임 오버 팝업 */}
      {gameOverOpen && (
        <div className="fixed inset-0 bg-black/60 grid place-items-center z-50">
          <div className="bg-neutral-900 text-neutral-100 rounded-2xl p-5 ring-1 ring-neutral-700 max-w-sm w-[92%] shadow-xl">
            <div className="text-lg font-bold mb-2">게임 오버</div>
            <div className="text-sm text-neutral-300 mb-4">점수: <span className="font-semibold text-neutral-100">{score}</span> · 레벨: <span className="font-semibold text-neutral-100">{level}/{MAX_LEVEL}</span></div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setGameOverOpen(false)} className="px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700">닫기</button>
              <button onClick={newGame} className="px-3 py-2 rounded-lg bg-emerald-600 text-emerald-950 hover:brightness-110">다시 시작 (Enter/Space)</button>
            </div>
          </div>
        </div>
      )}

      {/* 승리 팝업 */}
      {winOpen && (
        <div className="fixed inset-0 bg-black/60 grid place-items-center z-50">
          <div className="bg-neutral-900 text-neutral-100 rounded-2xl p-5 ring-1 ring-neutral-700 max-w-sm w-[92%] shadow-xl">
            <div className="text-lg font-bold mb-2">축하합니다! 게임 클리어 🎉</div>
            <div className="text-sm text-neutral-300 mb-4">최종 점수: <span className="font-semibold text-neutral-100">{score}</span></div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setWinOpen(false)} className="px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700">닫기</button>
              <button onClick={newGame} className="px-3 py-2 rounded-lg bg-emerald-600 text-emerald-950 hover:brightness-110">새 게임 (Enter/Space)</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

