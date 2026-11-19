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

// Physics Constants (60 FPS normalized)
const GRAVITY = 0.28;
const THRUST_LIFT = 0.64;
const BASE_SPEED = 3.2;
const BALL_HORIZ_DRAG = 0.018;
const MAX_CAR_RISE = -6.0;
const MAX_CAR_FALL = 6.8;
const MIN_PITCH = 0.14;        // ~ +8 deg (slight nose-down dip when coasting to catch up)
const MAX_PITCH = -1.05;       // ~ -60 deg (nose-up air-dribble posture when boosting)
const CAR_SCREEN_X = 128;
const BEST_TIME_KEY = 'teslaRoadsterAirDribbleBest_v3';

// Game state
let gameState = 'start'; // 'start' | 'playing' | 'gameover'
let elapsedTime = 0;     // Seconds (the score!)
let bestTime = Number(localStorage.getItem(BEST_TIME_KEY)) || 0;
let isNewBest = false;
let touches = 0;
let lastTouchTime = 0;
let lastTouchQuality = ''; // 'SOFT TOUCH' | 'HARD HIT!' | 'CORNER HIT!'
let touchBannerTimer = 0;
let gameOverReason = '';
let gameOverTime = 0;
let flashAlpha = 0;
let muted = false;

// Single-control input state (tap/hold to boost, just like v2!)
let pointerHeld = false;
let keyHeld = false;
function isThrusting() {
    return gameState === 'playing' && (pointerHeld || keyHeld);
}

// Timing & Camera
let lastTime = performance.now();
let idleTime = 0;
let cameraX = 0;
let thrusterFlicker = 0;
let thrustLevel = 0.5;

// Player & Ball
let roadster = createInitialRoadster();
let ball = createInitialBall();

function createInitialRoadster() {
    return {
        x: CAR_SCREEN_X,
        y: PLAYABLE_HEIGHT * 0.52,
        width: 74,
        height: 25,
        vx: BASE_SPEED,
        vy: 0,
        rotation: 0 // Starts horizontal just like v2
    };
}

function getWindshieldBallPos(car) {
    // Positioned right on top of the Roadster's sloped windshield
    const r = 44;
    return {
        x: car.x + car.width * 1.08,
        y: car.y - r - 30
    };
}

function getNoseWorldPos(car) {
    const cx = car.x + car.width / 2;
    const cy = car.y + car.height / 2;
    const cos = Math.cos(car.rotation);
    const sin = Math.sin(car.rotation);
    return {
        x: cx + (car.width * 0.5) * cos - 1 * sin,
        y: cy + (car.width * 0.5) * sin + 1 * cos,
        dirX: cos,
        dirY: sin
    };
}

function createInitialBall() {
    const r = 66;
    const tempCar = createInitialRoadster();
    const pos = getWindshieldBallPos(tempCar);
    return {
        x: pos.x,
        y: pos.y,
        radius: r,
        vx: BASE_SPEED,
        vy: 0,
        angle: 0,
        spin: 0.0
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

        if (type === 'touch') {
            osc.type = 'sine';
            const baseFreq = 120 + Math.min(90, intensity * 20);
            osc.frequency.setValueAtTime(baseFreq, now);
            osc.frequency.exponentialRampToValueAtTime(52, now + 0.075);
            gain.gain.setValueAtTime(Math.min(0.11, 0.04 + intensity * 0.018), now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
            osc.start(now);
            osc.stop(now + 0.09);
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

    // Ceiling limit indicator glow
    const ceilGlow = ctx.createLinearGradient(0, 0, 0, 14);
    ceilGlow.addColorStop(0, 'rgba(56, 189, 248, 0.28)');
    ceilGlow.addColorStop(1, 'rgba(56, 189, 248, 0)');
    ctx.fillStyle = ceilGlow;
    ctx.fillRect(0, 0, GAME_WIDTH, 14);

    // Parallax twinkling stars
    stars.forEach(s => {
        const sx = ((s.x - cameraX * 0.06) % GAME_WIDTH + GAME_WIDTH) % GAME_WIDTH;
        const twinkle = 0.4 + 0.55 * Math.sin(idleTime * 0.04 + s.phase);
        ctx.fillStyle = `rgba(226, 232, 240, ${twinkle.toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(sx, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
    });

    // Horizon floodlight glow
    const padGlow = ctx.createRadialGradient(GAME_WIDTH * 0.5, PLAYABLE_HEIGHT, 10, GAME_WIDTH * 0.5, PLAYABLE_HEIGHT, 240);
    padGlow.addColorStop(0, 'rgba(56, 189, 248, 0.16)');
    padGlow.addColorStop(0.5, 'rgba(239, 68, 68, 0.06)');
    padGlow.addColorStop(1, 'rgba(15, 23, 42, 0)');
    ctx.fillStyle = padGlow;
    ctx.fillRect(0, PLAYABLE_HEIGHT - 220, GAME_WIDTH, 220);

    // Distant parallax SpaceX test-stand & hangar silhouettes
    const span = 500;
    facilityTowers.forEach(f => {
        const drawX = ((f.x - cameraX * 0.28) % span + span) % span - 60;
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

function drawGround() {
    const y = PLAYABLE_HEIGHT;

    // Red LED laser/runway light bar
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(0, y, GAME_WIDTH, 3);
    const redGlow = ctx.createLinearGradient(0, y - 10, 0, y + 12);
    redGlow.addColorStop(0, 'rgba(239, 68, 68, 0)');
    redGlow.addColorStop(0.5, 'rgba(239, 68, 68, 0.45)');
    redGlow.addColorStop(1, 'rgba(239, 68, 68, 0)');
    ctx.fillStyle = redGlow;
    ctx.fillRect(0, y - 10, GAME_WIDTH, 22);

    // Dark SpaceX test pad
    const roadGrad = ctx.createLinearGradient(0, y + 3, 0, GAME_HEIGHT);
    roadGrad.addColorStop(0, '#1e293b');
    roadGrad.addColorStop(1, '#090d16');
    ctx.fillStyle = roadGrad;
    ctx.fillRect(0, y + 3, GAME_WIDTH, GROUND_HEIGHT - 3);

    // Scrolling runway markers locked to world cameraX
    ctx.fillStyle = 'rgba(148, 163, 184, 0.35)';
    const tickPeriod = 32;
    const tickStart = -(((cameraX % tickPeriod) + tickPeriod) % tickPeriod);
    for (let x = tickStart - tickPeriod; x < GAME_WIDTH + tickPeriod; x += tickPeriod) {
        ctx.fillRect(x, y + 9, 14, 2);
    }

    ctx.fillStyle = '#facc15';
    const dashPeriod = 54;
    const dashStart = -(((cameraX % dashPeriod) + dashPeriod) % dashPeriod);
    for (let x = dashStart - dashPeriod; x < GAME_WIDTH + dashPeriod; x += dashPeriod) {
        roundedRectPath(x, y + 40, 28, 4, 2);
        ctx.fill();
    }

    // Ground shadow indicator directly beneath the ball
    if (gameState !== 'start') {
        const ballScreenX = ball.x - cameraX;
        if (ballScreenX > -30 && ballScreenX < GAME_WIDTH + 30) {
            const heightRatio = Math.max(0.25, 1 - (PLAYABLE_HEIGHT - ball.y) / PLAYABLE_HEIGHT);
            ctx.save();
            ctx.fillStyle = `rgba(56, 189, 248, ${0.45 * heightRatio})`;
            ctx.beginPath();
            ctx.ellipse(ballScreenX, y + 4, ball.radius * 0.9 * heightRatio, 3, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }
}

// --- Cold-Gas Nitrogen Vapor & Touch Sparks (World Space) ---

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
            vx: roadster.vx * 0.4 - 1.1 - Math.random() * 1.2,
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
        ctx.arc(p.x - cameraX, p.y, p.radius, 0, Math.PI * 2);
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
            vx: roadster.vx * 0.5 + Math.cos(angle) * speed,
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
        ctx.arc(s.x - cameraX, s.y, s.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    });
}

// --- Cold-Gas Underbody Plumes (Same as v2) ---

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

// --- Large Soccer Ball Drawing ---

function drawSoccerBall() {
    const x = ball.x - cameraX;
    const y = ball.y;
    const r = ball.radius;
    const angle = ball.angle;

    ctx.save();
    ctx.translate(x, y);

    const nose = getNoseWorldPos(roadster);
    const distToNose = Math.hypot(ball.x - nose.x, ball.y - nose.y);
    if (distToNose < 65 && gameState !== 'gameover') {
        const auraAlpha = Math.max(0, 0.28 * (1 - distToNose / 65));
        ctx.fillStyle = `rgba(56, 189, 248, ${auraAlpha})`;
        ctx.beginPath();
        ctx.arc(0, 0, r + 5, 0, Math.PI * 2);
        ctx.fill();
    }

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
    ctx.arc(0, 0, r - 0.6, 0, Math.PI * 2);
    ctx.clip();

    ctx.rotate(angle);
    drawPentagon(0, 0, r * 0.38, -Math.PI / 2);

    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.3;
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
    ctx.lineWidth = 1.6;
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

// --- 2026 Tesla Roadster Drawing (Identical Assets to v2) ---

function drawRoadster() {
    const cx = roadster.x - cameraX + roadster.width / 2;
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

    // Red LED Taillight bar
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(left + 1, top + 8.2, 6, 2.3);
    ctx.fillStyle = '#fca5a5';
    ctx.fillRect(left + 1, top + 8.7, 4, 1);

    // White LED Front Headlight slit
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(left + w - 4.5, top + 13.2, 4, 1.8);

    // Wheel wells
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

function drawTimerHUD() {
    ctx.save();
    ctx.font = 'bold 40px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(2, 6, 23, 0.85)';
    const timeStr = `${elapsedTime.toFixed(1)}s`;
    ctx.strokeText(timeStr, GAME_WIDTH / 2, 46);
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(timeStr, GAME_WIDTH / 2, 46);

    ctx.font = '700 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillStyle = '#7dd3fc';
    ctx.fillText(`NOSE TOUCHES: ${touches}`, GAME_WIDTH / 2, 92);

    if (touchBannerTimer > 0 && lastTouchQuality) {
        ctx.globalAlpha = Math.min(1, touchBannerTimer);
        ctx.font = '800 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillStyle = lastTouchQuality === 'SOFT TOUCH' ? '#4ade80' : '#fbbf24';
        ctx.fillText(lastTouchQuality, GAME_WIDTH / 2, 110);
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

    // Title Banner
    ctx.fillStyle = 'rgba(15, 23, 42, 0.84)';
    roundedRectPath(GAME_WIDTH / 2 - 154, 62, 308, 86, 16);
    ctx.fill();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#f8fafc';
    ctx.font = '800 26px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('AIR DRIBBLE', GAME_WIDTH / 2, 92);

    ctx.fillStyle = '#38bdf8';
    ctx.font = '700 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('SOFT NOSE TOUCHES', GAME_WIDTH / 2, 122);

    // Pulsing instruction pill
    const pulse = 0.78 + 0.22 * Math.sin(idleTime * 0.08);
    ctx.fillStyle = `rgba(14, 165, 233, ${0.88 * pulse})`;
    roundedRectPath(GAME_WIDTH / 2 - 144, PLAYABLE_HEIGHT - 122, 288, 44, 22);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('Tap to Start', GAME_WIDTH / 2, PLAYABLE_HEIGHT - 100);

    if (bestTime > 0) {
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '700 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillText(`Best Time: ${bestTime.toFixed(1)}s`, GAME_WIDTH / 2, PLAYABLE_HEIGHT - 56);
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
    ctx.fillText('GAME OVER', GAME_WIDTH / 2, cardY + 34);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(gameOverReason, GAME_WIDTH / 2, cardY + 58);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('TIME', cardX + cardW * 0.3, cardY + 94);
    ctx.fillText('BEST', cardX + cardW * 0.7, cardY + 94);

    ctx.fillStyle = '#f8fafc';
    ctx.font = '800 30px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(`${elapsedTime.toFixed(1)}s`, cardX + cardW * 0.3, cardY + 124);
    ctx.fillText(`${bestTime.toFixed(1)}s`, cardX + cardW * 0.7, cardY + 124);

    ctx.fillStyle = '#7dd3fc';
    ctx.font = '700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(`NOSE TOUCHES: ${touches}`, GAME_WIDTH / 2, cardY + 156);

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

// --- Physics & Rocket League Front-Nose Dribble Collision ---

function updateRoadster(dt) {
    const thrusting = isThrusting();

    // Pitch dynamics: boosting pitches nose up into dribble angle; releasing dips gently flatter
    if (thrusting) {
        roadster.rotation = Math.max(MAX_PITCH, roadster.rotation - 0.042 * dt);
        thrustLevel = Math.min(1, thrustLevel + 0.28 * dt);

        // Cold-gas lift (strong vertical underbody lift + pitch boost)
        const lift = THRUST_LIFT * (0.85 + 0.15 * Math.abs(Math.sin(roadster.rotation)));
        roadster.vy -= lift * dt;
        spawnThrusterVapor(thrustLevel);
    } else {
        roadster.rotation = Math.min(MIN_PITCH, roadster.rotation + 0.032 * dt);
        thrustLevel = Math.max(0, thrustLevel - 0.2 * dt);
    }

    updateThrusterAudio(thrusting);

    // Pitch governs forward airspeed relative to BASE_SPEED:
    // Nose steep (-60 deg) slows slightly (~2.75) to let ball stay on nose;
    // Nose flat/dipped (0 to +8 deg) speeds slightly (~3.55) to catch back up!
    const targetVx = roadster.rotation < -0.15
        ? BASE_SPEED + (roadster.rotation + 0.15) * 0.52
        : BASE_SPEED + (roadster.rotation + 0.15) * 1.25;
    roadster.vx += (targetVx - roadster.vx) * Math.min(1, 0.09 * dt);

    roadster.vy += GRAVITY * dt;
    roadster.vy = Math.max(MAX_CAR_RISE, Math.min(MAX_CAR_FALL, roadster.vy));

    roadster.x += roadster.vx * dt;
    roadster.y += roadster.vy * dt;

    // Ceiling clamp (same as v2)
    if (roadster.y < 14) {
        roadster.y = 14;
        if (roadster.vy < 0) roadster.vy = 0;
    }

    cameraX = roadster.x - CAR_SCREEN_X;
    thrusterFlicker += 0.45 * dt;
}

function updateBall(dt) {
    ball.vy += GRAVITY * dt;
    ball.vx *= Math.pow(1 - BALL_HORIZ_DRAG, dt);

    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    ball.angle += ball.spin * dt;

    // Ceiling collision (rebounds downward)
    if (ball.y - ball.radius < 2) {
        ball.y = 2 + ball.radius;
        ball.vy = Math.max(1.5, Math.abs(ball.vy) * 0.65);
        spawnTouchSparks(ball.x, 4, '#38bdf8');
    }

    resolveBallNoseCollision();
}

function resolveBallNoseCollision() {
    const cx = roadster.x + roadster.width / 2;
    const cy = roadster.y + roadster.height / 2;
    const cos = Math.cos(-roadster.rotation);
    const sin = Math.sin(-roadster.rotation);

    // Ball center in Roadster's local rotated frame (+X = front nose, -Y = roof)
    const dx = ball.x - cx;
    const dy = ball.y - cy;
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;

    const halfW = roadster.width * 0.5;
    const halfH = roadster.height * 0.45;

    const clampedX = Math.max(-halfW, Math.min(halfW, localX));
    const clampedY = Math.max(-halfH, Math.min(halfH, localY));

    const distX = localX - clampedX;
    const distY = localY - clampedY;
    const distSq = distX * distX + distY * distY;

    if (distSq >= ball.radius * ball.radius) return;

    const dist = Math.sqrt(distSq) || 0.001;
    let lnx = distX / dist;
    let lny = distY / dist;

    if (distSq < 0.0001) {
        lnx = 0.7;
        lny = -0.7;
    }

    // Front nose / front hood tip vs unstable roof/corners/wheels
    const hitFrontNose = (localX > halfW * 0.52 && lnx > 0.32) || (localX > halfW * 0.78 && lny < 0.25);
    const hitRoofOrCorner = !hitFrontNose && lny < 0.25;

    if (hitFrontNose) {
        // Stable nose normal biased along the nose/upper-front face
        lnx = Math.max(0.55, lnx);
        const nLen = Math.hypot(lnx, lny) || 1;
        lnx /= nLen;
        lny /= nLen;
    }

    // Rotate local normal back to world space
    const wCos = Math.cos(roadster.rotation);
    const wSin = Math.sin(roadster.rotation);
    const nx = lnx * wCos - lny * wSin;
    const ny = lnx * wSin + lny * wCos;

    // Resolve overlap
    const overlap = ball.radius - dist;
    ball.x += nx * overlap;
    ball.y += ny * overlap;

    const relVx = ball.vx - roadster.vx;
    const relVy = ball.vy - roadster.vy;
    const relVn = relVx * nx + relVy * ny;

    if (relVn < 0) {
        const impact = Math.abs(relVn);
        let restitution;

        if (hitFrontNose) {
            // Soft touches stay close ("stuck") to the front nose; hard slams knock it away!
            restitution = impact < 1.9 ? 0.16 : Math.min(0.66, 0.20 + (impact - 1.9) * 0.15);
        } else if (hitRoofOrCorner) {
            // Hitting with windshield/roof/rear corners bounces unpredictably
            restitution = Math.min(0.76, 0.54 + impact * 0.06);
        } else {
            // Wheels / undercarriage knock it away
            restitution = 0.65;
        }

        ball.vx -= (1 + restitution) * relVn * nx;
        ball.vy -= (1 + restitution) * relVn * ny;

        // Tangential damping & realistic spin
        const tx = -ny;
        const ty = nx;
        const relVt = relVx * tx + relVy * ty;
        ball.vx -= relVt * 0.12 * tx;
        ball.vy -= relVt * 0.12 * ty;
        ball.spin = Math.max(-0.22, Math.min(0.22, 0.04 + relVt * 0.04));

        const now = performance.now();
        if (now - lastTouchTime > 120 && impact > 0.35) {
            if (hitFrontNose) {
                touches++;
                lastTouchQuality = impact < 1.9 ? 'SOFT TOUCH' : 'HARD HIT!';
                touchBannerTimer = 1.2;
                spawnTouchSparks(ball.x - nx * ball.radius, ball.y - ny * ball.radius, impact < 1.9 ? '#4ade80' : '#fbbf24');
            } else {
                lastTouchQuality = 'CORNER HIT!';
                touchBannerTimer = 1.0;
                spawnTouchSparks(ball.x - nx * ball.radius, ball.y - ny * ball.radius, '#f87171');
            }
            lastTouchTime = now;
            playEventSound('touch', impact);
        }
    }
}

function checkGroundGameOver() {
    if (roadster.y + roadster.height - 2 >= PLAYABLE_HEIGHT) {
        roadster.y = PLAYABLE_HEIGHT - roadster.height + 1;
        gameOverReason = 'Car hit the ground';
        return true;
    }

    if (ball.y + ball.radius >= PLAYABLE_HEIGHT) {
        ball.y = PLAYABLE_HEIGHT - ball.radius;
        gameOverReason = 'Ball hit the ground';
        return true;
    }

    return false;
}

function triggerGameOver() {
    gameState = 'gameover';
    gameOverTime = performance.now();
    flashAlpha = 0.65;
    thrustLevel = 0;
    updateThrusterAudio(false);
    playEventSound('crash');

    if (elapsedTime > bestTime) {
        bestTime = elapsedTime;
        isNewBest = true;
        try {
            localStorage.setItem(BEST_TIME_KEY, bestTime.toFixed(2));
        } catch {
            // Ignore
        }
    }
}

function resetToStart() {
    roadster = createInitialRoadster();
    ball = createInitialBall();
    cameraX = 0;
    vaporParticles = [];
    touchSparks = [];
    elapsedTime = 0;
    touches = 0;
    lastTouchQuality = '';
    touchBannerTimer = 0;
    isNewBest = false;
    gameOverReason = '';
    thrustLevel = 0.5;
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
        cameraX += 2.2 * dt;
        thrusterFlicker += 0.45 * dt;

        // Horizontal hover pose like v2, with ball resting on top of the windshield
        const bob = Math.sin(idleTime * 0.07) * 5;
        roadster.x = cameraX + CAR_SCREEN_X;
        roadster.y = PLAYABLE_HEIGHT * 0.52 + bob;
        roadster.rotation = Math.sin(idleTime * 0.07) * 0.02;

        const pos = getWindshieldBallPos(roadster);
        ball.x = pos.x;
        ball.y = pos.y + Math.sin(idleTime * 0.07 - 0.3) * 1.2;
        ball.angle += 0.03 * dt;

        thrustLevel = 0.52 + 0.14 * Math.sin(idleTime * 0.14);
        if (Math.random() < 0.45) spawnThrusterVapor(0.45);
        updateVaporParticles(dt);

        drawBackground();
        drawGround();
        drawVaporParticles();
        drawRoadster();
        drawSoccerBall();
        drawStartOverlay();
        drawTopBadges();
    } else if (gameState === 'playing') {
        idleTime += dt;
        elapsedTime += (dt * 16.6667) / 1000;
        if (touchBannerTimer > 0) touchBannerTimer = Math.max(0, touchBannerTimer - 0.03 * dt);

        updateRoadster(dt);
        updateBall(dt);
        updateVaporParticles(dt);
        updateTouchSparks(dt);

        if (checkGroundGameOver()) {
            triggerGameOver();
        }

        drawBackground();
        drawGround();
        drawVaporParticles();
        drawRoadster();
        drawSoccerBall();
        drawTouchSparks();
        drawTimerHUD();
        drawTopBadges();
    } else if (gameState === 'gameover') {
        idleTime += dt;
        updateVaporParticles(dt);
        updateTouchSparks(dt);
        if (flashAlpha > 0) {
            flashAlpha = Math.max(0, flashAlpha - 0.06 * dt);
        }

        drawBackground();
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

// --- Input Handling (Single Control: Tap / Feather Boost) ---

function handleStartOrRestart() {
    ensureAudio();
    if (gameState === 'start') {
        gameState = 'playing';
        elapsedTime = 0;
        touches = 0;
        lastTouchTime = 0;
        lastTouchQuality = '';
        touchBannerTimer = 0;

        // Start horizontal like v2, pop ball cleanly off the windshield so nose rises under it
        roadster.rotation = 0;
        roadster.vx = BASE_SPEED;
        roadster.vy = -2.4;

        const pos = getWindshieldBallPos(roadster);
        ball.x = pos.x + 4;
        ball.y = pos.y - 2;
        ball.vx = BASE_SPEED + 0.15;
        ball.vy = -4.3;
        ball.spin = 0.04;
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
