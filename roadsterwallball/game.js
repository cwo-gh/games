const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// Logical dimensions (crisp High-DPI scaling)
const GAME_WIDTH = 400;
const GAME_HEIGHT = 600;
const GROUND_HEIGHT = 80;
const PLAYABLE_HEIGHT = GAME_HEIGHT - GROUND_HEIGHT;

function setupHighDPICanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = GAME_WIDTH * dpr;
    canvas.height = GAME_HEIGHT * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
setupHighDPICanvas();

// Physics constants (60 FPS normalized)
const GRAVITY = 0.28;
const THRUST_LIFT = 0.64;
const MAX_CAR_RISE = -6.0;
const MAX_CAR_FALL = 6.8;
const MAX_PITCH = -0.40;
const MIN_PITCH = 0.06;
const CAR_X = 52;

// Wallball constants
const WALL_X = GAME_WIDTH - 24;
const BALL_RADIUS = 15;
const START_SPEED = 4.4;
const SPEED_GAIN = 1.06;
const MAX_SPEED = 14.5;
const BEST_KEY = 'teslaRoadsterWallballBest_v1';

// Game state
let gameState = 'start'; // 'start' | 'playing' | 'gameover'
let hits = 0;
let bestHits = Number(localStorage.getItem(BEST_KEY)) || 0;
let isNewBest = false;
let gameOverReason = '';
let gameOverTime = 0;
let flashAlpha = 0;
let muted = false;
let wallFlash = 0;

// Single-control input state (hold to hover)
let pointerHeld = false;
let keyHeld = false;
function isThrusting() {
    return gameState === 'playing' && (pointerHeld || keyHeld);
}

// Timing
let lastTime = performance.now();
let idleTime = 0;
let thrusterFlicker = 0;
let thrustLevel = 0.5;
let lastCarHit = 0;

// Player & Ball
let roadster = createInitialRoadster();
let ball = createInitialBall();

function createInitialRoadster() {
    return {
        x: CAR_X,
        y: PLAYABLE_HEIGHT * 0.48,
        width: 74,
        height: 25,
        vx: 0,
        vy: 0,
        rotation: 0
    };
}

function createInitialBall() {
    return {
        x: CAR_X + 116,
        y: PLAYABLE_HEIGHT * 0.48 - BALL_RADIUS - 8,
        radius: BALL_RADIUS,
        vx: 0,
        vy: 0,
        speed: START_SPEED,
        angle: 0,
        spin: 0
    };
}

// World entities
let vaporParticles = [];
let touchSparks = [];
let stars = generateStars(46);
let facilityTowers = generateFacilitySilhouette();

function generateStars(count) {
    const arr = [];
    for (let i = 0; i < count; i++) {
        arr.push({
            x: Math.random() * GAME_WIDTH,
            y: Math.random() * (PLAYABLE_HEIGHT * 0.72),
            r: 0.7 + Math.random() * 1.4,
            phase: Math.random() * Math.PI * 2
        });
    }
    return arr;
}

function generateFacilitySilhouette() {
    return [
        { x: 20, w: 34, h: 68, type: 'tank' },
        { x: 84, w: 18, h: 108, type: 'tower' },
        { x: 162, w: 58, h: 42, type: 'hangar' },
        { x: 264, w: 22, h: 92, type: 'tower' },
        { x: 320, w: 40, h: 55, type: 'tank' },
        { x: 405, w: 52, h: 46, type: 'hangar' }
    ];
}

// --- Web Audio Synth ---
let audioCtx = null;
let thrustGainNode = null;

function ensureAudio() {
    if (muted) return null;
    try {
        if (!audioCtx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return null;
            audioCtx = new Ctx();

            const bufferSize = audioCtx.sampleRate * 1.5;
            const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
            const data = noiseBuffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
                data[i] = Math.random() * 2 - 1;
            }
            const noiseSource = audioCtx.createBufferSource();
            noiseSource.buffer = noiseBuffer;
            noiseSource.loop = true;

            const bandpass = audioCtx.createBiquadFilter();
            bandpass.type = 'bandpass';
            bandpass.frequency.value = 1850;
            bandpass.Q.value = 0.9;

            thrustGainNode = audioCtx.createGain();
            thrustGainNode.gain.value = 0;

            noiseSource.connect(bandpass);
            bandpass.connect(thrustGainNode);
            thrustGainNode.connect(audioCtx.destination);
            noiseSource.start();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        return audioCtx;
    } catch {
        return null;
    }
}

function updateThrusterAudio(active) {
    if (!audioCtx || !thrustGainNode) return;
    try {
        const target = (!muted && active) ? 0.06 : 0;
        thrustGainNode.gain.setTargetAtTime(target, audioCtx.currentTime, 0.03);
    } catch {
        // Ignore
    }
}

function playEventSound(type, intensity = 1) {
    const ac = ensureAudio();
    if (!ac || muted) return;
    try {
        const now = ac.currentTime;
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.connect(gain);
        gain.connect(ac.destination);

        if (type === 'hit') {
            osc.type = 'sine';
            const baseFreq = 170 + Math.min(120, intensity * 13);
            osc.frequency.setValueAtTime(baseFreq, now);
            osc.frequency.exponentialRampToValueAtTime(78, now + 0.075);
            gain.gain.setValueAtTime(0.09, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.085);
            osc.start(now);
            osc.stop(now + 0.09);
        } else if (type === 'wall') {
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(150, now);
            osc.frequency.exponentialRampToValueAtTime(62, now + 0.1);
            gain.gain.setValueAtTime(0.045, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
            osc.start(now);
            osc.stop(now + 0.12);
        } else if (type === 'crash') {
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(160, now);
            osc.frequency.exponentialRampToValueAtTime(42, now + 0.25);
            gain.gain.setValueAtTime(0.14, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
            osc.start(now);
            osc.stop(now + 0.27);
        }
    } catch {
        // Ignore
    }
}

// --- Helper Path ---

function roundedRectPath(x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

// --- Environment Drawing (McGregor SpaceX Night Test Facility) ---

function drawBackground() {
    const skyGrad = ctx.createLinearGradient(0, 0, 0, PLAYABLE_HEIGHT);
    skyGrad.addColorStop(0, '#020617');
    skyGrad.addColorStop(0.55, '#0b1329');
    skyGrad.addColorStop(1, '#172554');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, GAME_WIDTH, PLAYABLE_HEIGHT);

    const ceilGlow = ctx.createLinearGradient(0, 0, 0, 14);
    ceilGlow.addColorStop(0, 'rgba(56, 189, 248, 0.28)');
    ceilGlow.addColorStop(1, 'rgba(56, 189, 248, 0)');
    ctx.fillStyle = ceilGlow;
    ctx.fillRect(0, 0, GAME_WIDTH, 14);

    stars.forEach(s => {
        const twinkle = 0.4 + 0.55 * Math.sin(idleTime * 0.04 + s.phase);
        ctx.fillStyle = `rgba(226, 232, 240, ${twinkle.toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
    });

    const padGlow = ctx.createRadialGradient(GAME_WIDTH * 0.5, PLAYABLE_HEIGHT, 10, GAME_WIDTH * 0.5, PLAYABLE_HEIGHT, 240);
    padGlow.addColorStop(0, 'rgba(56, 189, 248, 0.16)');
    padGlow.addColorStop(0.5, 'rgba(239, 68, 68, 0.06)');
    padGlow.addColorStop(1, 'rgba(15, 23, 42, 0)');
    ctx.fillStyle = padGlow;
    ctx.fillRect(0, PLAYABLE_HEIGHT - 220, GAME_WIDTH, 220);

    const span = 500;
    facilityTowers.forEach(f => {
        const drawX = ((f.x % span) + span) % span - 60;
        const y = PLAYABLE_HEIGHT - f.h;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
        if (f.type === 'tower') {
            ctx.fillRect(drawX, y, f.w, f.h);
            ctx.strokeStyle = 'rgba(51, 65, 85, 0.55)';
            ctx.lineWidth = 1;
            for (let ty = y + 12; ty < PLAYABLE_HEIGHT; ty += 16) {
                ctx.beginPath();
                ctx.moveTo(drawX, ty);
                ctx.lineTo(drawX + f.w, ty + 12);
                ctx.stroke();
            }
            ctx.fillStyle = '#ef4444';
            ctx.beginPath();
            ctx.arc(drawX + f.w / 2, y - 3, 2, 0, Math.PI * 2);
            ctx.fill();
        } else if (f.type === 'tank') {
            roundedRectPath(drawX, y, f.w, f.h + 8, 12);
            ctx.fill();
        } else {
            ctx.fillRect(drawX, y, f.w, f.h);
        }
    });
}

// --- The Wall ---

function drawWall() {
    const wallW = GAME_WIDTH - WALL_X;

    const glow = ctx.createLinearGradient(WALL_X - 70, 0, WALL_X, 0);
    glow.addColorStop(0, 'rgba(56, 189, 248, 0)');
    glow.addColorStop(1, `rgba(56, 189, 248, ${0.10 + wallFlash * 0.22})`);
    ctx.fillStyle = glow;
    ctx.fillRect(WALL_X - 70, 0, 70, PLAYABLE_HEIGHT);

    const slab = ctx.createLinearGradient(WALL_X, 0, GAME_WIDTH, 0);
    slab.addColorStop(0, '#1e293b');
    slab.addColorStop(0.45, '#0f172a');
    slab.addColorStop(1, '#020617');
    ctx.fillStyle = slab;
    ctx.fillRect(WALL_X, 0, wallW, PLAYABLE_HEIGHT);

    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(WALL_X, 0, 2.5, PLAYABLE_HEIGHT);

    const bright = 0.55 + wallFlash * 0.45;
    ctx.fillStyle = `rgba(224, 242, 254, ${0.22 * bright})`;
    ctx.fillRect(WALL_X + 2.5, 0, 1.5, PLAYABLE_HEIGHT);

    for (let y = 34; y < PLAYABLE_HEIGHT; y += 64) {
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(WALL_X + 4, y);
        ctx.lineTo(GAME_WIDTH - 4, y);
        ctx.stroke();

        ctx.fillStyle = 'rgba(148, 163, 184, 0.5)';
        ctx.beginPath();
        ctx.arc(WALL_X + 7, y - 9, 1.5, 0, Math.PI * 2);
        ctx.fill();
    }

    const lightYs = [46, PLAYABLE_HEIGHT / 2, PLAYABLE_HEIGHT - 46];
    lightYs.forEach((y, i) => {
        const pulse = 0.55 + 0.45 * Math.sin(idleTime * 0.08 + i * 2.1);
        ctx.fillStyle = i === 1 ? `rgba(56, 189, 248, ${pulse})` : `rgba(239, 68, 68, ${pulse})`;
        ctx.beginPath();
        ctx.arc(WALL_X + wallW / 2, y, 2.4, 0, Math.PI * 2);
        ctx.fill();
    });

    if (wallFlash > 0) {
        ctx.fillStyle = `rgba(56, 189, 248, ${wallFlash * 0.2})`;
        ctx.fillRect(WALL_X - 2, 0, wallW + 2, PLAYABLE_HEIGHT);
    }
}

function drawGround() {
    const y = PLAYABLE_HEIGHT;

    ctx.fillStyle = '#dc2626';
    ctx.fillRect(0, y, GAME_WIDTH, 3);
    const redGlow = ctx.createLinearGradient(0, y - 10, 0, y + 12);
    redGlow.addColorStop(0, 'rgba(239, 68, 68, 0)');
    redGlow.addColorStop(0.5, 'rgba(239, 68, 68, 0.45)');
    redGlow.addColorStop(1, 'rgba(239, 68, 68, 0)');
    ctx.fillStyle = redGlow;
    ctx.fillRect(0, y - 10, GAME_WIDTH, 22);

    const roadGrad = ctx.createLinearGradient(0, y + 3, 0, GAME_HEIGHT);
    roadGrad.addColorStop(0, '#1e293b');
    roadGrad.addColorStop(1, '#090d16');
    ctx.fillStyle = roadGrad;
    ctx.fillRect(0, y + 3, GAME_WIDTH, GROUND_HEIGHT - 3);

    ctx.fillStyle = 'rgba(148, 163, 184, 0.35)';
    for (let x = 0; x < GAME_WIDTH; x += 32) {
        ctx.fillRect(x, y + 9, 14, 2);
    }

    ctx.fillStyle = '#facc15';
    for (let x = 0; x < GAME_WIDTH; x += 54) {
        roundedRectPath(x, y + 40, 28, 4, 2);
        ctx.fill();
    }

    if (gameState !== 'start') {
        const heightRatio = Math.max(0.25, 1 - (PLAYABLE_HEIGHT - ball.y) / PLAYABLE_HEIGHT);
        ctx.save();
        ctx.fillStyle = `rgba(56, 189, 248, ${0.45 * heightRatio})`;
        ctx.beginPath();
        ctx.ellipse(ball.x, y + 4, ball.radius * 0.9 * heightRatio, 3, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

// --- Cold-Gas Nitrogen Vapor & Sparks ---

function spawnThrusterVapor(intensity) {
    if (intensity < 0.12) return;
    const cx = roadster.x + roadster.width / 2;
    const cy = roadster.y + roadster.height / 2;
    const cos = Math.cos(roadster.rotation);
    const sin = Math.sin(roadster.rotation);

    const nozzleLocalXs = [-16, -11, 14, 19];
    const localY = roadster.height / 2 + 2;

    const count = intensity > 0.6 ? 3 : 1;
    for (let i = 0; i < count; i++) {
        const lx = nozzleLocalXs[Math.floor(Math.random() * nozzleLocalXs.length)];
        const wx = cx + lx * cos - localY * sin;
        const wy = cy + lx * sin + localY * cos;

        vaporParticles.push({
            x: wx + (Math.random() - 0.5) * 3,
            y: wy + Math.random() * 6,
            vx: -1.1 - Math.random() * 1.2,
            vy: 3.0 + Math.random() * 2.5 * intensity,
            radius: 2.5 + Math.random() * 3.3 * intensity,
            life: 1,
            decay: 0.045 + Math.random() * 0.025
        });
    }
}

function updateVaporParticles(dt) {
    for (let i = vaporParticles.length - 1; i >= 0; i--) {
        const p = vaporParticles[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.radius += 0.16 * dt;
        p.life -= p.decay * dt;

        if (p.y >= PLAYABLE_HEIGHT - 2) {
            p.y = PLAYABLE_HEIGHT - 2;
            p.vy = -0.3 * Math.random();
        }

        if (p.life <= 0) {
            vaporParticles.splice(i, 1);
        }
    }
}

function drawVaporParticles() {
    vaporParticles.forEach(p => {
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life * 0.45);
        ctx.fillStyle = '#e0f2fe';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    });
}

function spawnTouchSparks(x, y, color = '#7dd3fc') {
    for (let i = 0; i < 8; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 1.1 + Math.random() * 2.3;
        touchSparks.push({
            x,
            y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            radius: 1.4 + Math.random() * 1.8,
            life: 1,
            color
        });
    }
}

function updateTouchSparks(dt) {
    for (let i = touchSparks.length - 1; i >= 0; i--) {
        const s = touchSparks[i];
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.life -= 0.075 * dt;
        if (s.life <= 0) touchSparks.splice(i, 1);
    }
}

function drawTouchSparks() {
    touchSparks.forEach(s => {
        ctx.save();
        ctx.globalAlpha = Math.max(0, s.life);
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    });
}

function drawColdGasPlumes(left, top, w, h, intensity) {
    if (intensity <= 0.04) return;

    const nozzles = [
        { x: left + 16, scale: 0.92 },
        { x: left + 22, scale: 1.0 },
        { x: left + w - 21, scale: 0.95 },
        { x: left + w - 15, scale: 0.88 }
    ];
    const nozzleY = top + h - 3;

    nozzles.forEach((n, idx) => {
        const jitter = Math.sin(thrusterFlicker * 1.7 + idx * 2.1) * 4;
        const plumeLen = (26 + jitter) * intensity * n.scale;
        const plumeW = (4.8 + intensity * 1.5) * n.scale;

        const outerGrad = ctx.createLinearGradient(n.x, nozzleY, n.x, nozzleY + plumeLen);
        outerGrad.addColorStop(0, `rgba(224, 242, 254, ${0.9 * intensity})`);
        outerGrad.addColorStop(0.45, `rgba(125, 211, 252, ${0.55 * intensity})`);
        outerGrad.addColorStop(1, 'rgba(56, 189, 248, 0)');

        ctx.fillStyle = outerGrad;
        ctx.beginPath();
        ctx.moveTo(n.x - 1.6, nozzleY);
        ctx.lineTo(n.x + 1.6, nozzleY);
        ctx.lineTo(n.x + plumeW, nozzleY + plumeLen);
        ctx.lineTo(n.x - plumeW, nozzleY + plumeLen);
        ctx.closePath();
        ctx.fill();

        const coreGrad = ctx.createLinearGradient(n.x, nozzleY, n.x, nozzleY + plumeLen * 0.65);
        coreGrad.addColorStop(0, `rgba(255, 255, 255, ${0.98 * intensity})`);
        coreGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');

        ctx.fillStyle = coreGrad;
        ctx.beginPath();
        ctx.moveTo(n.x - 1.1, nozzleY);
        ctx.lineTo(n.x + 1.1, nozzleY);
        ctx.lineTo(n.x + plumeW * 0.45, nozzleY + plumeLen * 0.65);
        ctx.lineTo(n.x - plumeW * 0.45, nozzleY + plumeLen * 0.65);
        ctx.closePath();
        ctx.fill();
    });
}

// --- Small Soccer Ball Drawing ---

function drawSoccerBall() {
    const x = ball.x;
    const y = ball.y;
    const r = ball.radius;
    const angle = ball.angle;

    ctx.save();
    ctx.translate(x, y);

    const ballGrad = ctx.createRadialGradient(-r * 0.32, -r * 0.35, r * 0.15, 0, 0, r);
    ballGrad.addColorStop(0, '#ffffff');
    ballGrad.addColorStop(0.58, '#e2e8f0');
    ballGrad.addColorStop(0.88, '#94a3b8');
    ballGrad.addColorStop(1, '#475569');

    ctx.fillStyle = ballGrad;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r - 0.5, 0, Math.PI * 2);
    ctx.clip();

    ctx.rotate(angle);
    drawPentagon(0, 0, r * 0.38, -Math.PI / 2);

    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 0.9;
    for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / 5;
        const innerX = Math.cos(a) * (r * 0.36);
        const innerY = Math.sin(a) * (r * 0.36);
        const outerX = Math.cos(a) * (r * 0.92);
        const outerY = Math.sin(a) * (r * 0.92);

        ctx.beginPath();
        ctx.moveTo(innerX, innerY);
        ctx.lineTo(outerX, outerY);
        ctx.stroke();

        drawPentagon(outerX, outerY, r * 0.31, a + Math.PI);
    }

    ctx.restore();

    const shineGrad = ctx.createRadialGradient(-r * 0.35, -r * 0.35, 1, -r * 0.3, -r * 0.3, r * 0.65);
    shineGrad.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
    shineGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = shineGrad;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
}

function drawPentagon(cx, cy, rad, startAngle) {
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
        const a = startAngle + (i * Math.PI * 2) / 5;
        const px = cx + Math.cos(a) * rad;
        const py = cy + Math.sin(a) * rad;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
}

// --- 2026 Tesla Roadster Drawing (Same asset as Air Dribble) ---

function drawRoadster() {
    const cx = roadster.x + roadster.width / 2;
    const cy = roadster.y + roadster.height / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(roadster.rotation);

    const w = roadster.width;
    const h = roadster.height;
    const left = -w / 2;
    const top = -h / 2;

    drawColdGasPlumes(left, top, w, h, thrustLevel);

    if (gameState !== 'gameover') {
        const beamGrad = ctx.createLinearGradient(left + w - 2, top + 13, left + w + 58, top + 13);
        beamGrad.addColorStop(0, 'rgba(224, 242, 254, 0.42)');
        beamGrad.addColorStop(1, 'rgba(224, 242, 254, 0)');
        ctx.fillStyle = beamGrad;
        ctx.beginPath();
        ctx.moveTo(left + w - 2, top + 13);
        ctx.lineTo(left + w + 58, top + 4);
        ctx.lineTo(left + w + 58, top + 24);
        ctx.closePath();
        ctx.fill();
    }

    const bodyGrad = ctx.createLinearGradient(0, top, 0, top + h - 4);
    bodyGrad.addColorStop(0, '#ffffff');
    bodyGrad.addColorStop(0.28, '#e2e8f0');
    bodyGrad.addColorStop(0.68, '#cbd5e1');
    bodyGrad.addColorStop(1, '#94a3b8');

    ctx.fillStyle = bodyGrad;
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.2;

    ctx.beginPath();
    ctx.moveTo(left + 3, top + h - 5);
    ctx.lineTo(left + 1, top + 9.5);
    ctx.lineTo(left + 6, top + 6.5);
    ctx.lineTo(left + 28, top + 0.5);
    ctx.lineTo(left + 40, top + 0.5);
    ctx.lineTo(left + 57, top + 8.5);
    ctx.lineTo(left + w - 1, top + 13.5);
    ctx.lineTo(left + w - 1, top + h - 4.5);
    ctx.lineTo(left + 3, top + h - 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.moveTo(left + 2, top + h - 5);
    ctx.lineTo(left + 14, top + h - 8.5);
    ctx.lineTo(left + w - 14, top + h - 7.5);
    ctx.lineTo(left + w - 1, top + h - 4.5);
    ctx.lineTo(left + 2, top + h - 4.5);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.moveTo(left + 1, top + 13);
    ctx.lineTo(left + 9, top + 13.5);
    ctx.lineTo(left + 7, top + h - 5);
    ctx.lineTo(left + 1.5, top + h - 5);
    ctx.closePath();
    ctx.fill();

    const glassGrad = ctx.createLinearGradient(0, top + 1.5, 0, top + 10);
    glassGrad.addColorStop(0, '#020617');
    glassGrad.addColorStop(0.65, '#0f172a');
    glassGrad.addColorStop(1, '#334155');
    ctx.fillStyle = glassGrad;

    ctx.beginPath();
    ctx.moveTo(left + 16, top + 8.5);
    ctx.lineTo(left + 30, top + 2);
    ctx.lineTo(left + 40, top + 2);
    ctx.lineTo(left + 53, top + 8.5);
    ctx.lineTo(left + 16, top + 8.8);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(left + 25, top + 4.5);
    ctx.lineTo(left + 42, top + 4.5);
    ctx.stroke();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(left + 6, top + 9.5);
    ctx.lineTo(left + 57, top + 11.2);
    ctx.stroke();

    ctx.fillStyle = '#ef4444';
    ctx.fillRect(left + 1, top + 8.2, 6, 2.3);
    ctx.fillStyle = '#fca5a5';
    ctx.fillRect(left + 1, top + 8.7, 4, 1);

    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(left + w - 4.5, top + 13.2, 4, 1.8);

    const rearWheelX = left + 16;
    const frontWheelX = left + w - 16;
    const wheelY = top + h - 5.2;

    ctx.fillStyle = '#090d16';
    ctx.beginPath();
    ctx.arc(rearWheelX, wheelY, 7.6, Math.PI, 0);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(frontWheelX, wheelY, 7.4, Math.PI, 0);
    ctx.fill();

    drawAeroDiscWheel(rearWheelX, wheelY, 6.7);
    drawAeroDiscWheel(frontWheelX, wheelY, 6.5);

    ctx.restore();
}

function drawAeroDiscWheel(x, y, radius) {
    ctx.save();
    ctx.translate(x, y);

    ctx.fillStyle = '#090d16';
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();

    const discGrad = ctx.createLinearGradient(-radius, -radius, radius, radius);
    discGrad.addColorStop(0, '#94a3b8');
    discGrad.addColorStop(0.5, '#475569');
    discGrad.addColorStop(1, '#1e293b');
    ctx.fillStyle = discGrad;
    ctx.beginPath();
    ctx.arc(0, 0, radius - 1.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(0, 0, radius - 1.6, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(0, 0, 1.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
}

// --- HUD & Overlay Screens ---

function drawScoreHUD() {
    ctx.save();
    ctx.font = 'bold 42px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(2, 6, 23, 0.85)';
    const scoreStr = String(hits);
    ctx.strokeText(scoreStr, GAME_WIDTH / 2, 46);
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(scoreStr, GAME_WIDTH / 2, 46);

    ctx.font = '700 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillStyle = '#7dd3fc';
    ctx.fillText(`WALL HITS  ·  SPEED x${(ball.speed / START_SPEED).toFixed(1)}`, GAME_WIDTH / 2, 94);

    if (bestHits > 0) {
        ctx.fillStyle = '#64748b';
        ctx.font = '700 10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillText(`BEST: ${bestHits}`, GAME_WIDTH / 2, 111);
    }
    ctx.restore();
}

function drawTopBadges() {
    const pillY = 12;
    const pillH = 24;
    const centerY = pillY + pillH / 2;

    // Left badge: Cold-Gas Thruster Status
    ctx.save();
    const active = thrustLevel > 0.25;
    const thrustLabel = 'Thrust';
    ctx.font = '700 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const thrustTextW = ctx.measureText(thrustLabel).width;
    const dotR = 3.2;
    const dotGap = 6;
    const padX = 11;
    const leftPillW = Math.ceil(padX * 2 + dotR * 2 + dotGap + thrustTextW);

    ctx.fillStyle = active ? 'rgba(14, 165, 233, 0.28)' : 'rgba(15, 23, 42, 0.72)';
    ctx.strokeStyle = active ? '#38bdf8' : '#334155';
    ctx.lineWidth = 1.2;
    roundedRectPath(12, pillY, leftPillW, pillH, pillH / 2);
    ctx.fill();
    ctx.stroke();

    const dotX = 12 + padX + dotR;
    ctx.fillStyle = active ? '#38bdf8' : '#94a3b8';
    ctx.beginPath();
    ctx.arc(dotX, centerY, dotR, 0, Math.PI * 2);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(thrustLabel, dotX + dotR + dotGap, centerY + 0.5);
    ctx.restore();

    // Right badge: Sound Mute Toggle
    ctx.save();
    ctx.font = '600 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const soundLabel = muted ? 'Muted' : 'Sound On';
    const maxSoundW = Math.max(
        ctx.measureText('Sound On').width,
        ctx.measureText('Muted').width
    );
    const rightPillW = Math.ceil(maxSoundW) + 24;
    const rightPillX = GAME_WIDTH - 12 - rightPillW;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.2;
    roundedRectPath(rightPillX, pillY, rightPillW, pillH, pillH / 2);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(soundLabel, rightPillX + rightPillW / 2, centerY + 0.5);
    ctx.restore();
}

function drawStartOverlay() {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = 'rgba(15, 23, 42, 0.84)';
    roundedRectPath(GAME_WIDTH / 2 - 160, 62, 320, 86, 16);
    ctx.fill();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#f8fafc';
    ctx.font = '800 24px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('ROADSTER WALLBALL', GAME_WIDTH / 2, 92);

    ctx.fillStyle = '#38bdf8';
    ctx.font = '700 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('ONE CAR  ·  ONE WALL  ·  NO MERCY', GAME_WIDTH / 2, 122);

    const pulse = 0.78 + 0.22 * Math.sin(idleTime * 0.08);
    ctx.fillStyle = `rgba(14, 165, 233, ${0.88 * pulse})`;
    roundedRectPath(GAME_WIDTH / 2 - 150, PLAYABLE_HEIGHT - 122, 300, 44, 22);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('Hold to Hover  ·  Tap to Start', GAME_WIDTH / 2, PLAYABLE_HEIGHT - 100);

    if (bestHits > 0) {
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '700 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillText(`Best Hits: ${bestHits}`, GAME_WIDTH / 2, PLAYABLE_HEIGHT - 56);
    }

    ctx.restore();
}

function drawGameOverOverlay() {
    ctx.save();
    ctx.fillStyle = 'rgba(2, 6, 23, 0.62)';
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    const cardW = 294;
    const cardH = 250;
    const cardX = (GAME_WIDTH - cardW) / 2;
    const cardY = (PLAYABLE_HEIGHT - cardH) / 2 - 8;

    ctx.fillStyle = '#0f172a';
    roundedRectPath(cardX, cardY, cardW, cardH, 18);
    ctx.fill();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = '#ef4444';
    ctx.font = '800 26px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('WALL MISSED', GAME_WIDTH / 2, cardY + 34);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(gameOverReason, GAME_WIDTH / 2, cardY + 58);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('HITS', cardX + cardW * 0.3, cardY + 94);
    ctx.fillText('BEST', cardX + cardW * 0.7, cardY + 94);

    ctx.fillStyle = '#f8fafc';
    ctx.font = '800 30px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(String(hits), cardX + cardW * 0.3, cardY + 124);
    ctx.fillText(String(bestHits), cardX + cardW * 0.7, cardY + 124);

    ctx.fillStyle = '#7dd3fc';
    ctx.font = '700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(`TOP SPEED: x${(ball.speed / START_SPEED).toFixed(1)}`, GAME_WIDTH / 2, cardY + 156);

    if (isNewBest) {
        ctx.fillStyle = '#f59e0b';
        roundedRectPath(GAME_WIDTH / 2 - 48, cardY + 170, 96, 20, 10);
        ctx.fill();
        ctx.fillStyle = '#0f172a';
        ctx.font = '800 10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillText('NEW BEST!', GAME_WIDTH / 2, cardY + 180.5);
    }

    ctx.fillStyle = '#0284c7';
    roundedRectPath(GAME_WIDTH / 2 - 108, cardY + 198, 216, 36, 18);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('Click or Space to Restart', GAME_WIDTH / 2, cardY + 216);

    ctx.restore();
}

// --- Physics ---

function updateRoadster(dt) {
    const thrusting = isThrusting();

    if (thrusting) {
        roadster.rotation = Math.max(MAX_PITCH, roadster.rotation - 0.035 * dt);
        thrustLevel = Math.min(1, thrustLevel + 0.28 * dt);
        roadster.vy -= THRUST_LIFT * dt;
        spawnThrusterVapor(thrustLevel);
    } else {
        roadster.rotation = Math.min(MIN_PITCH, roadster.rotation + 0.025 * dt);
        thrustLevel = Math.max(0, thrustLevel - 0.2 * dt);
    }

    updateThrusterAudio(thrusting);

    roadster.vy += GRAVITY * dt;
    roadster.vy = Math.max(MAX_CAR_RISE, Math.min(MAX_CAR_FALL, roadster.vy));
    roadster.y += roadster.vy * dt;

    if (roadster.y < 12) {
        roadster.y = 12;
        if (roadster.vy < 0) roadster.vy = 0;
    }

    const floorY = PLAYABLE_HEIGHT - roadster.height - 4;
    if (roadster.y > floorY) {
        roadster.y = floorY;
        if (roadster.vy > 0) roadster.vy = 0;
    }

    thrusterFlicker += 0.45 * dt;
}

function normalizeBallVelocity() {
    const mag = Math.hypot(ball.vx, ball.vy) || 1;
    ball.vx = (ball.vx / mag) * ball.speed;
    ball.vy = (ball.vy / mag) * ball.speed;
}

function updateBall(dt) {
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    ball.angle += ball.spin * dt;

    // Ceiling and ground act as rebound surfaces.
    if (ball.y - ball.radius < 3) {
        ball.y = 3 + ball.radius;
        ball.vy = Math.max(1.2, Math.abs(ball.vy));
        spawnTouchSparks(ball.x, 4, '#38bdf8');
    }
    if (ball.y + ball.radius > PLAYABLE_HEIGHT - 2) {
        ball.y = PLAYABLE_HEIGHT - 2 - ball.radius;
        ball.vy = -Math.max(1.2, Math.abs(ball.vy));
        spawnTouchSparks(ball.x, PLAYABLE_HEIGHT - 4, '#facc15');
    }

    // Right-hand wall rebound.
    if (ball.x + ball.radius > WALL_X) {
        ball.x = WALL_X - ball.radius;
        if (ball.vx > 0) {
            ball.vx = -Math.abs(ball.vx);
            const deflection = (Math.random() - 0.5) * 0.22;
            const angle = Math.atan2(ball.vy, Math.abs(ball.vx)) + deflection;
            ball.vx = -Math.cos(angle) * ball.speed;
            ball.vy = Math.sin(angle) * ball.speed;
            wallFlash = 1;
            spawnTouchSparks(WALL_X - 3, ball.y, '#7dd3fc');
            playEventSound('wall');
        }
    }

    resolveCarHit();

    if (ball.x + ball.radius < 0) {
        triggerGameOver('The ball got past you');
    }
}

function resolveCarHit() {
    // Only a ball travelling back toward the car can be returned.
    if (ball.vx > -0.05) return;

    const w = roadster.width;
    const h = roadster.height;
    const cx = roadster.x + w / 2;
    const cy = roadster.y + h / 2;

    const cos = Math.cos(-roadster.rotation);
    const sin = Math.sin(-roadster.rotation);
    const dx = ball.x - cx;
    const dy = ball.y - cy;
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;

    const halfW = w * 0.55;
    const halfH = h * 0.5 + 2;
    const clampedX = Math.max(-halfW, Math.min(halfW, localX));
    const clampedY = Math.max(-halfH, Math.min(halfH, localY));
    const distX = localX - clampedX;
    const distY = localY - clampedY;
    const hitRadius = ball.radius + 3;

    if (distX * distX + distY * distY >= hitRadius * hitRadius) return;
    if (ball.x < cx) return;

    const now = performance.now();
    if (now - lastCarHit < 130) return;

    // Hit further from the car's centre sends the ball off at an angle.
    const offset = Math.max(-1, Math.min(1, localY / (h * 0.5)));
    const angle = offset * 0.62 + (Math.random() - 0.5) * 0.1;

    ball.speed = Math.min(MAX_SPEED, ball.speed * SPEED_GAIN);
    ball.vx = Math.cos(angle) * ball.speed;
    ball.vy = Math.sin(angle) * ball.speed + roadster.vy * 0.35;
    normalizeBallVelocity();

    ball.x = Math.max(ball.x, roadster.x + w + ball.radius + 1);
    ball.spin = 0.22 + ball.speed * 0.02;

    hits++;
    lastCarHit = now;
    wallFlash = Math.max(wallFlash, 0.35);
    spawnTouchSparks(roadster.x + w + 2, ball.y, '#4ade80');
    playEventSound('hit', ball.speed);
}

function triggerGameOver(reason) {
    gameState = 'gameover';
    gameOverReason = reason;
    gameOverTime = performance.now();
    flashAlpha = 0.65;
    thrustLevel = 0;
    updateThrusterAudio(false);
    playEventSound('crash');

    if (hits > bestHits) {
        bestHits = hits;
        isNewBest = true;
        try {
            localStorage.setItem(BEST_KEY, String(bestHits));
        } catch {
            // Ignore
        }
    }
}

function resetToStart() {
    roadster = createInitialRoadster();
    ball = createInitialBall();
    vaporParticles = [];
    touchSparks = [];
    hits = 0;
    isNewBest = false;
    gameOverReason = '';
    wallFlash = 0;
    thrustLevel = 0.5;
    ball.speed = START_SPEED;
    gameState = 'start';
}

// --- Main Game Loop ---

function gameLoop(now) {
    const rawDt = (now - lastTime) / 16.6667;
    const dt = Math.min(Math.max(rawDt, 0.1), 2.5);
    lastTime = now;

    ctx.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    if (gameState === 'start') {
        idleTime += dt;
        thrusterFlicker += 0.45 * dt;

        const bob = Math.sin(idleTime * 0.07) * 5;
        roadster.y = PLAYABLE_HEIGHT * 0.48 + bob;
        roadster.rotation = Math.sin(idleTime * 0.07) * 0.02;

        ball.x = roadster.x + roadster.width - 2;
        ball.y = roadster.y - ball.radius - 4 + Math.sin(idleTime * 0.07 - 0.3) * 1.5;
        ball.angle += 0.02 * dt;

        thrustLevel = 0.52 + 0.14 * Math.sin(idleTime * 0.14);
        if (Math.random() < 0.45) spawnThrusterVapor(0.45);
        updateVaporParticles(dt);

        drawBackground();
        drawWall();
        drawGround();
        drawVaporParticles();
        drawRoadster();
        drawSoccerBall();
        drawStartOverlay();
        drawTopBadges();
    } else if (gameState === 'playing') {
        idleTime += dt;
        if (wallFlash > 0) wallFlash = Math.max(0, wallFlash - 0.07 * dt);

        updateRoadster(dt);
        updateBall(dt);
        updateVaporParticles(dt);
        updateTouchSparks(dt);

        drawBackground();
        drawWall();
        drawGround();
        drawVaporParticles();
        drawRoadster();
        drawSoccerBall();
        drawTouchSparks();
        drawScoreHUD();
        drawTopBadges();
    } else if (gameState === 'gameover') {
        idleTime += dt;
        if (wallFlash > 0) wallFlash = Math.max(0, wallFlash - 0.05 * dt);
        updateVaporParticles(dt);
        updateTouchSparks(dt);
        if (flashAlpha > 0) {
            flashAlpha = Math.max(0, flashAlpha - 0.06 * dt);
        }

        drawBackground();
        drawWall();
        drawGround();
        drawVaporParticles();
        drawRoadster();
        drawSoccerBall();
        drawTouchSparks();
        drawGameOverOverlay();
        drawTopBadges();

        if (flashAlpha > 0) {
            ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha})`;
            ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
        }
    }

    requestAnimationFrame(gameLoop);
}

// --- Input Handling (Hold to Hover) ---

function handleStartOrRestart() {
    ensureAudio();
    if (gameState === 'start') {
        gameState = 'playing';
        hits = 0;
        lastCarHit = 0;
        ball.speed = START_SPEED;

        roadster.rotation = 0;
        roadster.vy = -1.2;

        ball.x = roadster.x + roadster.width + ball.radius + 8;
        ball.y = roadster.y + roadster.height / 2;
        const angle = (Math.random() < 0.5 ? -1 : 1) * (0.1 + Math.random() * 0.14);
        ball.vx = Math.cos(angle) * ball.speed;
        ball.vy = Math.sin(angle) * ball.speed;
        ball.spin = 0.18;
    } else if (gameState === 'gameover') {
        if (performance.now() - gameOverTime > 320) {
            resetToStart();
        }
    }
}

canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const scaleX = GAME_WIDTH / rect.width;
    const scaleY = GAME_HEIGHT / rect.height;
    const clickX = (e.clientX - rect.left) * scaleX;
    const clickY = (e.clientY - rect.top) * scaleY;

    // Mute badge click
    if (clickX >= GAME_WIDTH - 96 && clickY <= 44) {
        muted = !muted;
        if (muted) updateThrusterAudio(false);
        return;
    }

    pointerHeld = true;
    handleStartOrRestart();
});

// Prevent mobile double-tap zoom and pinch-zoom
canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
canvas.addEventListener('touchend', (e) => e.preventDefault(), { passive: false });
canvas.addEventListener('dblclick', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());

window.addEventListener('pointerup', () => {
    pointerHeld = false;
});

window.addEventListener('pointercancel', () => {
    pointerHeld = false;
});

window.addEventListener('blur', () => {
    pointerHeld = false;
    keyHeld = false;
    updateThrusterAudio(false);
});

window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
        e.preventDefault();
        if (!e.repeat) {
            keyHeld = true;
            handleStartOrRestart();
        }
    } else if (e.code === 'KeyM') {
        muted = !muted;
        if (muted) updateThrusterAudio(false);
    }
});

window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
        keyHeld = false;
    }
});

// Start loop
requestAnimationFrame((now) => {
    lastTime = now;
    gameLoop(now);
});
