const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// Logical dimensions (crisp High-DPI scaling)
const GAME_WIDTH = 420;
const GAME_HEIGHT = 600;
const GROUND_Y = 472;
const BEST_SCORE_KEY = 'sunnyBusBestScore_v1';

function setupHighDPICanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = GAME_WIDTH * dpr;
    canvas.height = GAME_HEIGHT * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
setupHighDPICanvas();

// physics constants (60 FPS normalized)
const GRAVITY = 0.40;
const JUMP_VELOCITY = -9.6;
const DOUBLE_JUMP_VELOCITY = -8.6;
const BASE_SPEED = 4.00;
const MAX_SPEED = 4.00;

// Game State
let gameState = 'start'; // 'start' | 'playing' | 'gameover'
let score = 0;
let bestScore = Number(localStorage.getItem(BEST_SCORE_KEY)) || 0;
let isNewBest = false;
let difficultyLevel = 1;
let hearts = 3;
let maxHearts = 3;
let kidsOnBus = 0;       // 0..4 visible smiling passengers in windows
let kidsPickedUp = 0;    // Total kids picked up in this run
let starsCollected = 0;
let schoolPending = false;
let invulnTimer = 0;     // Frames of forgiving blink after bumping a cone/puddle
let gameOverTime = 0;
let muted = false;

// Timing & world scroll
let lastTime = performance.now();
let animTime = 0;
let worldSpeed = BASE_SPEED;
let roadOffset = 0;
let spawnTimer = 0;
let spawnCount = 0;

// Player Bus
let bus = createInitialBus();

function createInitialBus() {
    return {
        x: 56,
        y: GROUND_Y - 48,
        width: 96,
        height: 48,
        vy: 0,
        jumpsUsed: 0,
        maxJumps: 2,
        wheelAngle: 0,
        squash: 0, // squash & stretch
        stopSignPulse: 0
    };
}

// World entities
let obstacles = [];  // Cones & puddles
let pickups = [];    // Floating stars, bus-stop kids, school drop-off gate
let particles = [];  // Rainbow hop puffs, sparkles, confetti, water splashes
let floatingTexts = [];
let clouds = [
    { x: 55, y: 78, scale: 0.95, speed: 0.35 },
    { x: 215, y: 122, scale: 0.78, speed: 0.25 },
    { x: 350, y: 70, scale: 1.05, speed: 0.42 }
];
let neighborhood = generateNeighborhood();

function generateNeighborhood() {
    const items = [];
    const colors = ['#fca5a5', '#fdba74', '#93c5fd', '#c4b5fd', '#f9a8d4'];
    const roofs = ['#ef4444', '#f97316', '#3b82f6', '#8b5cf6', '#ec4899'];
    let x = 20;
    for (let i = 0; i < 8; i++) {
        const isHouse = i % 2 === 0;
        items.push({
            x,
            type: isHouse ? 'house' : 'tree',
            w: isHouse ? 46 + (i % 3) * 8 : 32,
            h: isHouse ? 38 + (i % 2) * 8 : 44,
            wallColor: colors[i % colors.length],
            roofColor: roofs[i % roofs.length]
        });
        x += 78;
    }
    return items;
}

// --- Cheerful Web Audio Synth ---
let audioCtx = null;
function ensureAudio() {
    if (muted) return null;
    try {
        if (!audioCtx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) audioCtx = new Ctx();
        }
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        return audioCtx;
    } catch {
        return null;
    }
}

function playSound(type) {
    const ac = ensureAudio();
    if (!ac || muted) return;
    try {
        const now = ac.currentTime;
        if (type === 'hop' || type === 'doublehop') {
            const osc = ac.createOscillator();
            const gain = ac.createGain();
            osc.connect(gain);
            gain.connect(ac.destination);
            osc.type = 'sine';
            const f1 = type === 'hop' ? 280 : 380;
            const f2 = type === 'hop' ? 540 : 720;
            osc.frequency.setValueAtTime(f1, now);
            osc.frequency.exponentialRampToValueAtTime(f2, now + 0.12);
            gain.gain.setValueAtTime(0.09, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
            osc.start(now);
            osc.stop(now + 0.15);
        } else if (type === 'star') {
            [523.25, 659.25].forEach((freq, idx) => {
                const osc = ac.createOscillator();
                const gain = ac.createGain();
                osc.connect(gain);
                gain.connect(ac.destination);
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(freq, now + idx * 0.055);
                gain.gain.setValueAtTime(0.08, now + idx * 0.055);
                gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.055 + 0.16);
                osc.start(now + idx * 0.055);
                osc.stop(now + idx * 0.055 + 0.17);
            });
        } else if (type === 'kid') {
            [440, 554.37, 659.25].forEach((freq, idx) => {
                const osc = ac.createOscillator();
                const gain = ac.createGain();
                osc.connect(gain);
                gain.connect(ac.destination);
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(freq, now + idx * 0.06);
                gain.gain.setValueAtTime(0.085, now + idx * 0.06);
                gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.06 + 0.18);
                osc.start(now + idx * 0.06);
                osc.stop(now + idx * 0.06 + 0.19);
            });
        } else if (type === 'school') {
            [523.25, 659.25, 783.99, 1046.5].forEach((freq, idx) => {
                const osc = ac.createOscillator();
                const gain = ac.createGain();
                osc.connect(gain);
                gain.connect(ac.destination);
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(freq, now + idx * 0.07);
                gain.gain.setValueAtTime(0.09, now + idx * 0.07);
                gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.07 + 0.25);
                osc.start(now + idx * 0.07);
                osc.stop(now + idx * 0.07 + 0.26);
            });
        } else if (type === 'bonk') {
            const osc = ac.createOscillator();
            const gain = ac.createGain();
            osc.connect(gain);
            gain.connect(ac.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(220, now);
            osc.frequency.exponentialRampToValueAtTime(110, now + 0.16);
            gain.gain.setValueAtTime(0.11, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
            osc.start(now);
            osc.stop(now + 0.19);
        }
    } catch {
        // Ignore audio errors
    }
}

// --- Drawing Helpers ---

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

function drawStarShape(cx, cy, outerR, innerR, points = 5) {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
        const r = i % 2 === 0 ? outerR : innerR;
        const a = -Math.PI / 2 + (i * Math.PI) / points;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();
}

function drawHeartShape(cx, cy, size, filled) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.moveTo(0, size * 0.35);
    ctx.bezierCurveTo(-size * 0.55, -size * 0.15, -size * 0.95, size * 0.35, 0, size * 0.95);
    ctx.bezierCurveTo(size * 0.95, size * 0.35, size * 0.55, -size * 0.15, 0, size * 0.35);
    ctx.closePath();
    ctx.fillStyle = filled ? '#ef4444' : 'rgba(255, 255, 255, 0.55)';
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = filled ? '#991b1b' : '#94a3b8';
    ctx.stroke();
    ctx.restore();
}

// --- Background & Neighborhood ---

function drawBackground() {
    // Cheerful sky gradient
    const skyGrad = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    skyGrad.addColorStop(0, '#38bdf8');
    skyGrad.addColorStop(0.6, '#bae6fd');
    skyGrad.addColorStop(1, '#e0f2fe');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, GAME_WIDTH, GROUND_Y);

    // Smiling Sun in top right
    const sunX = 352;
    const sunY = 86;
    ctx.save();
    const sunGlow = ctx.createRadialGradient(sunX, sunY, 16, sunX, sunY, 54);
    sunGlow.addColorStop(0, 'rgba(253, 224, 71, 0.95)');
    sunGlow.addColorStop(0.5, 'rgba(253, 224, 71, 0.35)');
    sunGlow.addColorStop(1, 'rgba(253, 224, 71, 0)');
    ctx.fillStyle = sunGlow;
    ctx.beginPath();
    ctx.arc(sunX, sunY, 54, 0, Math.PI * 2);
    ctx.fill();

    // Sun rays
    ctx.translate(sunX, sunY);
    ctx.rotate(animTime * 0.008);
    ctx.strokeStyle = '#fde047';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (let i = 0; i < 10; i++) {
        const a = (i * Math.PI * 2) / 10;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 26, Math.sin(a) * 26);
        ctx.lineTo(Math.cos(a) * 34, Math.sin(a) * 34);
        ctx.stroke();
    }
    ctx.rotate(-animTime * 0.008);

    ctx.fillStyle = '#fde047';
    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#eab308';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Cute sun smile
    ctx.fillStyle = '#854d0e';
    ctx.beginPath();
    ctx.arc(-6, -3, 2, 0, Math.PI * 2);
    ctx.arc(6, -3, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#854d0e';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(0, 1, 7, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
    ctx.restore();

    // Fluffy clouds
    clouds.forEach(c => drawCloud(c.x, c.y, c.scale));

    // Rolling soft green hills
    ctx.fillStyle = '#86efac';
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    ctx.quadraticCurveTo(95, GROUND_Y - 58, 210, GROUND_Y - 18);
    ctx.quadraticCurveTo(320, GROUND_Y - 62, GAME_WIDTH, GROUND_Y - 22);
    ctx.lineTo(GAME_WIDTH, GROUND_Y);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#4ade80';
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    ctx.quadraticCurveTo(60, GROUND_Y - 28, 150, GROUND_Y - 8);
    ctx.quadraticCurveTo(260, GROUND_Y - 34, GAME_WIDTH, GROUND_Y - 6);
    ctx.lineTo(GAME_WIDTH, GROUND_Y);
    ctx.closePath();
    ctx.fill();

    // Cute scrolling pastel houses & trees
    const span = 624;
    neighborhood.forEach(item => {
        const ix = ((item.x - roadOffset * 0.4) % span + span) % span - 70;
        if (item.type === 'house') {
            const hy = GROUND_Y - item.h - 14;
            // Wall
            ctx.fillStyle = item.wallColor;
            ctx.strokeStyle = '#334155';
            ctx.lineWidth = 1.4;
            roundedRectPath(ix, hy, item.w, item.h, 4);
            ctx.fill();
            ctx.stroke();
            // Pitched roof
            ctx.fillStyle = item.roofColor;
            ctx.beginPath();
            ctx.moveTo(ix - 5, hy + 2);
            ctx.lineTo(ix + item.w / 2, hy - 18);
            ctx.lineTo(ix + item.w + 5, hy + 2);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            // Door & Window
            ctx.fillStyle = '#fef3c7';
            roundedRectPath(ix + 7, hy + 10, 11, 11, 2);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#78350f';
            roundedRectPath(ix + item.w - 18, hy + item.h - 19, 11, 19, 2);
            ctx.fill();
        } else {
            const ty = GROUND_Y - 14;
            ctx.fillStyle = '#92400e';
            ctx.fillRect(ix + 11, ty - 20, 8, 20);
            ctx.fillStyle = '#22c55e';
            ctx.beginPath();
            ctx.arc(ix + 15, ty - 28, 16, 0, Math.PI * 2);
            ctx.arc(ix + 6, ty - 21, 11, 0, Math.PI * 2);
            ctx.arc(ix + 24, ty - 21, 11, 0, Math.PI * 2);
            ctx.fill();
        }
    });
}

function drawCloud(x, y, scale) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
    ctx.beginPath();
    ctx.arc(0, 0, 16, 0, Math.PI * 2);
    ctx.arc(17, -6, 20, 0, Math.PI * 2);
    ctx.arc(36, -1, 16, 0, Math.PI * 2);
    ctx.arc(48, 5, 11, 0, Math.PI * 2);
    ctx.arc(-13, 5, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function drawRoad() {
    // Grass sidewalk strip
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(0, GROUND_Y - 14, GAME_WIDTH, 14);

    // Sidewalk curb
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(0, GROUND_Y - 4, GAME_WIDTH, 6);
    ctx.fillStyle = '#64748b';
    ctx.fillRect(0, GROUND_Y + 2, GAME_WIDTH, 2);

    // Friendly asphalt street
    const roadGrad = ctx.createLinearGradient(0, GROUND_Y + 4, 0, GAME_HEIGHT);
    roadGrad.addColorStop(0, '#475569');
    roadGrad.addColorStop(1, '#334155');
    ctx.fillStyle = roadGrad;
    ctx.fillRect(0, GROUND_Y + 4, GAME_WIDTH, GAME_HEIGHT - GROUND_Y - 4);

    // Dashed yellow street center line
    ctx.fillStyle = '#fde047';
    const dashPeriod = 54;
    const startX = -(((roadOffset % dashPeriod) + dashPeriod) % dashPeriod);
    for (let x = startX - dashPeriod; x < GAME_WIDTH + dashPeriod; x += dashPeriod) {
        roundedRectPath(x, GROUND_Y + 54, 28, 6, 3);
        ctx.fill();
    }
}

// --- Obstacles & Pickups ---

function drawObstacles() {
    obstacles.forEach(obs => {
        if (obs.type === 'cone') {
            const count = obs.count || 1;
            const singleW = obs.singleWidth || obs.width;
            for (let i = 0; i < count; i++) {
                drawTrafficCone(obs.x + i * singleW, obs.y, singleW, obs.height);
            }
        } else if (obs.type === 'puddle') {
            drawSplashPuddle(obs.x, obs.y, obs.width, obs.height);
        } else if (obs.type === 'bird') {
            drawAerialBird(obs.x, obs.y, obs.width, obs.height, obs.wingPhase || 0);
        }
    });
}

function drawAerialBird(x, y, w, h, wingPhase) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const flap = Math.sin(animTime * 0.28 + wingPhase) * 8;

    ctx.save();
    ctx.translate(cx, cy);

    // Subtle warning trail lines behind bird
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(w * 0.45, -4);
    ctx.lineTo(w * 0.72, -4);
    ctx.moveTo(w * 0.52, 4);
    ctx.lineTo(w * 0.82, 4);
    ctx.stroke();

    // Tail feathers (facing right since bird flies left)
    ctx.fillStyle = '#7c3aed';
    ctx.beginPath();
    ctx.moveTo(w * 0.34, 0);
    ctx.lineTo(w * 0.56, -7);
    ctx.lineTo(w * 0.52, 6);
    ctx.closePath();
    ctx.fill();

    // Chubby body
    ctx.fillStyle = '#8b5cf6';
    ctx.strokeStyle = '#4c1d95';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.ellipse(0, 1, w * 0.36, h * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Soft belly
    ctx.fillStyle = '#ddd6fe';
    ctx.beginPath();
    ctx.ellipse(-2, 5, w * 0.22, h * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();

    // Flapping wing
    ctx.fillStyle = '#a78bfa';
    ctx.beginPath();
    ctx.moveTo(-4, 0);
    ctx.quadraticCurveTo(6, -12 + flap, 14, -2 + flap * 0.6);
    ctx.quadraticCurveTo(4, 6, -4, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Orange beak pointing left toward the bus
    ctx.fillStyle = '#f97316';
    ctx.beginPath();
    ctx.moveTo(-w * 0.32, -2);
    ctx.lineTo(-w * 0.54, 2);
    ctx.lineTo(-w * 0.32, 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Big expressive eye
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(-w * 0.16, -3, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(-w * 0.18, -3, 2.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(-w * 0.19, -4, 0.9, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
}

function drawTrafficCone(x, y, w, h) {
    ctx.save();
    // Base plate
    ctx.fillStyle = '#ea580c';
    ctx.strokeStyle = '#7c2d12';
    ctx.lineWidth = 1.6;
    roundedRectPath(x, y + h - 7, w, 7, 3);
    ctx.fill();
    ctx.stroke();

    // Cone body
    ctx.fillStyle = '#f97316';
    ctx.beginPath();
    ctx.moveTo(x + 4, y + h - 7);
    ctx.lineTo(x + w * 0.36, y);
    ctx.lineTo(x + w * 0.64, y);
    ctx.lineTo(x + w - 4, y + h - 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Bright white reflective stripe(s) — tall cones get 2 stripes!
    ctx.fillStyle = '#ffffff';
    if (h >= 46) {
        ctx.beginPath();
        ctx.moveTo(x + w * 0.22, y + h * 0.70);
        ctx.lineTo(x + w * 0.27, y + h * 0.52);
        ctx.lineTo(x + w * 0.73, y + h * 0.52);
        ctx.lineTo(x + w * 0.78, y + h * 0.70);
        ctx.closePath();
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(x + w * 0.30, y + h * 0.38);
        ctx.lineTo(x + w * 0.35, y + h * 0.20);
        ctx.lineTo(x + w * 0.65, y + h * 0.20);
        ctx.lineTo(x + w * 0.70, y + h * 0.38);
        ctx.closePath();
        ctx.fill();
    } else {
        ctx.beginPath();
        ctx.moveTo(x + w * 0.25, y + h * 0.56);
        ctx.lineTo(x + w * 0.32, y + h * 0.32);
        ctx.lineTo(x + w * 0.68, y + h * 0.32);
        ctx.lineTo(x + w * 0.75, y + h * 0.56);
        ctx.closePath();
        ctx.fill();
    }
    ctx.restore();
}

function drawSplashPuddle(x, y, w, h) {
    ctx.save();
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.fillStyle = '#38bdf8';
    ctx.strokeStyle = '#0284c7';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Cute water ripple highlight
    ctx.strokeStyle = '#e0f2fe';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(cx - 4, cy - 1, w * 0.26, h * 0.22, 0, 0, Math.PI * 1.4);
    ctx.stroke();
    ctx.restore();
}

function drawPickups() {
    pickups.forEach(p => {
        if (p.collected) return;
        if (p.type === 'star') {
            drawFloatingStar(p.x, p.y, p.radius);
        } else if (p.type === 'kid') {
            drawBusStopKid(p.x, p.y, p.shirtColor, p.hairColor, p.wavePhase);
        } else if (p.type === 'school') {
            drawSchoolArch(p.x, p.y);
        }
    });
}

function drawFloatingStar(x, y, r) {
    const bob = Math.sin(animTime * 0.1 + x * 0.05) * 4;
    ctx.save();
    ctx.translate(x, y + bob);
    ctx.rotate(Math.sin(animTime * 0.06 + x * 0.03) * 0.18);

    // Glow
    ctx.fillStyle = 'rgba(253, 224, 71, 0.35)';
    ctx.beginPath();
    ctx.arc(0, 0, r + 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#facc15';
    ctx.strokeStyle = '#ca8a04';
    ctx.lineWidth = 2;
    drawStarShape(0, 0, r, r * 0.48);
    ctx.fill();
    ctx.stroke();

    // Sparkle dot
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(-3, -3, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function drawBusStopKid(x, y, shirtColor, hairColor, phase) {
    ctx.save();
    // Bus stop sign pole
    ctx.fillStyle = '#64748b';
    ctx.fillRect(x + 18, y - 54, 4, 54);
    ctx.fillStyle = '#3b82f6';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    roundedRectPath(x + 9, y - 62, 22, 16, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 7px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('BUS', x + 20, y - 54);

    // Little happy kid waving!
    const hop = Math.abs(Math.sin(animTime * 0.12 + phase)) * 4;
    const ky = y - hop;

    // Legs
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - 3, ky - 10);
    ctx.lineTo(x - 4, ky);
    ctx.moveTo(x + 3, ky - 10);
    ctx.lineTo(x + 4, ky);
    ctx.stroke();

    // Backpack & Shirt
    ctx.fillStyle = '#f59e0b';
    roundedRectPath(x - 9, ky - 23, 6, 11, 2);
    ctx.fill();

    ctx.fillStyle = shirtColor;
    roundedRectPath(x - 6, ky - 24, 12, 14, 4);
    ctx.fill();

    // Waving arm
    const wave = Math.sin(animTime * 0.22 + phase) * 5;
    ctx.strokeStyle = '#fed7aa';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x + 5, ky - 21);
    ctx.lineTo(x + 12, ky - 29 + wave);
    ctx.stroke();

    // Head
    ctx.fillStyle = '#fed7aa';
    ctx.beginPath();
    ctx.arc(x, ky - 31, 8, 0, Math.PI * 2);
    ctx.fill();

    // Hair
    ctx.fillStyle = hairColor;
    ctx.beginPath();
    ctx.arc(x, ky - 33, 8, Math.PI, 0);
    ctx.fill();

    // Happy eyes & smile
    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.arc(x - 2.5, ky - 31, 1.1, 0, Math.PI * 2);
    ctx.arc(x + 2.5, ky - 31, 1.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(x, ky - 29.5, 3, 0.1 * Math.PI, 0.9 * Math.PI);
    ctx.stroke();

    ctx.restore();
}

function drawSchoolArch(x, y) {
    ctx.save();
    // Two brick-red pillars + bright banner overhead
    ctx.fillStyle = '#dc2626';
    ctx.strokeStyle = '#7f1d1d';
    ctx.lineWidth = 2;
    roundedRectPath(x - 42, y - 108, 16, 108, 4);
    ctx.fill();
    ctx.stroke();
    roundedRectPath(x + 26, y - 108, 16, 108, 4);
    ctx.fill();
    ctx.stroke();

    // School Banner Sign
    ctx.fillStyle = '#fef08a';
    ctx.strokeStyle = '#ca8a04';
    ctx.lineWidth = 2.5;
    roundedRectPath(x - 52, y - 126, 104, 30, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#b91c1c';
    ctx.font = '900 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('SUNNY SCHOOL!', x, y - 111);
    ctx.restore();
}

// --- Smiling Yellow School Bus ---

function drawKidInWindow(wx, wy, w, h, seatIndex) {
    const shirts = ['#ec4899', '#3b82f6', '#22c55e', '#a855f7'];
    const hairs = ['#78350f', '#1e293b', '#d97706', '#451a03'];
    const cx = wx + w / 2;
    const cy = wy + h - 5;

    ctx.save();
    // Shoulders
    ctx.fillStyle = shirts[seatIndex % shirts.length];
    ctx.beginPath();
    ctx.arc(cx, cy + 4, 5.5, Math.PI, 0);
    ctx.fill();
    // Face
    ctx.fillStyle = '#fed7aa';
    ctx.beginPath();
    ctx.arc(cx, cy - 3, 4.5, 0, Math.PI * 2);
    ctx.fill();
    // Hair
    ctx.fillStyle = hairs[seatIndex % hairs.length];
    ctx.beginPath();
    ctx.arc(cx, cy - 4.2, 4.5, Math.PI, 0);
    ctx.fill();
    // Eyes
    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.arc(cx - 1.5, cy - 3, 0.8, 0, Math.PI * 2);
    ctx.arc(cx + 1.5, cy - 3, 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function drawSchoolBus() {
    // Gentle blink during post-bump invulnerability
    if (invulnTimer > 0 && Math.floor(invulnTimer / 5) % 2 === 1) {
        ctx.save();
        ctx.globalAlpha = 0.45;
        drawSchoolBusInner();
        ctx.restore();
    } else {
        drawSchoolBusInner();
    }
}

function drawSchoolBusInner() {
    const cx = bus.x + bus.width / 2;
    const cy = bus.y + bus.height / 2;
    const rot = Math.max(-0.24, Math.min(0.22, bus.vy * 0.024));

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);

    // squash & stretch on hop/land
    const scaleY = 1 + bus.squash * 0.12;
    const scaleX = 1 - bus.squash * 0.08;
    ctx.scale(scaleX, scaleY);

    const w = bus.width;
    const h = bus.height;
    const left = -w / 2;
    const top = -h / 2;

    // Ground shadow beneath bus
    ctx.save();
    const heightAboveRoad = Math.max(0, GROUND_Y - (bus.y + bus.height));
    const shadowAlpha = Math.max(0.08, 0.28 - heightAboveRoad * 0.0018);
    ctx.fillStyle = `rgba(15, 23, 42, ${shadowAlpha})`;
    ctx.beginPath();
    ctx.ellipse(0, h / 2 + heightAboveRoad + 2, w * 0.44, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Cute roof beacon light
    ctx.fillStyle = '#fb923c';
    roundedRectPath(left + 32, top - 5, 12, 6, 3);
    ctx.fill();

    // Main bright yellow school bus body (classic snub-nose school bus silhouette)
    const bodyGrad = ctx.createLinearGradient(0, top, 0, top + h - 8);
    bodyGrad.addColorStop(0, '#fde047');
    bodyGrad.addColorStop(0.5, '#facc15');
    bodyGrad.addColorStop(1, '#eab308');
    ctx.fillStyle = bodyGrad;
    ctx.strokeStyle = '#854d0e';
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.moveTo(left + 6, top + h - 8);
    ctx.lineTo(left + 2, top + 8);
    ctx.quadraticCurveTo(left + 2, top, left + 12, top);
    ctx.lineTo(left + w - 22, top);
    ctx.quadraticCurveTo(left + w - 14, top, left + w - 12, top + 14);
    ctx.lineTo(left + w - 4, top + 16);
    ctx.quadraticCurveTo(left + w, top + 17, left + w, top + 24);
    ctx.lineTo(left + w, top + h - 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Classic black school bus rub-rails / stripes
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(left + 3, top + 25, w - 5, 3.5);
    ctx.fillRect(left + 4, top + 31, w - 7, 2);

    // 4 Passenger Windows (fill up with happy kids as you pick them up!)
    const winW = 13;
    const winH = 14;
    const winY = top + 6;
    for (let i = 0; i < 4; i++) {
        const wx = left + 8 + i * 16;
        ctx.fillStyle = '#bae6fd';
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 1.4;
        roundedRectPath(wx, winY, winW, winH, 3);
        ctx.fill();
        ctx.stroke();

        if (i < kidsOnBus) {
            drawKidInWindow(wx, winY, winW, winH, i);
        }
    }

    // Front Windshield with adorable friendly eyes!
    ctx.fillStyle = '#e0f2fe';
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(left + w - 22, top + 6);
    ctx.lineTo(left + w - 15, top + 6);
    ctx.lineTo(left + w - 11, top + 20);
    ctx.lineTo(left + w - 22, top + 20);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Friendly cartoon eyes on the windshield
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(left + w - 16, top + 13, 3.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(left + w - 15, top + 13, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(left + w - 14.3, top + 12.2, 0.8, 0, Math.PI * 2);
    ctx.fill();

    // Little red STOP sign on the side
    ctx.fillStyle = '#ef4444';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    roundedRectPath(left + w - 30, top + 22, 8, 8, 2);
    ctx.fill();
    ctx.stroke();

    // Happy smiling chrome bumper & headlight
    ctx.fillStyle = '#fef9c3';
    ctx.beginPath();
    ctx.arc(left + w - 3, top + 24, 3.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#cbd5e1';
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1.3;
    roundedRectPath(left + 2, top + h - 10, w - 1, 5, 2.5);
    ctx.fill();
    ctx.stroke();

    // Smiling grill curve on nose
    ctx.strokeStyle = '#713f12';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(left + w - 6, top + 28, 4, 0.1 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();

    // Spinning Wheels
    drawBusWheel(left + 20, top + h - 6);
    drawBusWheel(left + w - 20, top + h - 6);

    ctx.restore();
}

function drawBusWheel(x, y) {
    ctx.save();
    ctx.translate(x, y);

    // Tire
    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, Math.PI * 2);
    ctx.fill();

    // Yellow hubcap
    ctx.fillStyle = '#fde047';
    ctx.beginPath();
    ctx.arc(0, 0, 5.5, 0, Math.PI * 2);
    ctx.fill();

    // Spinning lug spokes
    ctx.rotate(bus.wheelAngle);
    ctx.fillStyle = '#854d0e';
    for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * 3, Math.sin(a) * 3, 1.1, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.restore();
}

// --- Particles & Floating Text ---

function spawnHopParticles(isDouble) {
    const colors = isDouble
        ? ['#f472b6', '#facc15', '#4ade80', '#38bdf8', '#c084fc']
        : ['#ffffff', '#e2e8f0', '#fef08a'];
    for (let i = 0; i < (isDouble ? 10 : 6); i++) {
        particles.push({
            x: bus.x + 8,
            y: bus.y + bus.height - 10,
            vx: -1.5 - Math.random() * 2.2,
            vy: (Math.random() - 0.3) * 2.2,
            r: 3 + Math.random() * 4,
            life: 1,
            decay: 0.04,
            color: colors[i % colors.length]
        });
    }
}

function spawnSparkles(x, y, color, count = 10) {
    for (let i = 0; i < count; i++) {
        const a = (i * Math.PI * 2) / count + Math.random() * 0.4;
        const sp = 1.5 + Math.random() * 2.8;
        particles.push({
            x,
            y,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp - 0.8,
            r: 3 + Math.random() * 3,
            life: 1,
            decay: 0.032,
            color
        });
    }
}

function addFloatingText(x, y, text, color) {
    floatingTexts.push({ x, y, text, color, life: 1 });
}

function updateParticlesAndText(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.life -= p.decay * dt;
        if (p.life <= 0) particles.splice(i, 1);
    }

    for (let i = floatingTexts.length - 1; i >= 0; i--) {
        const ft = floatingTexts[i];
        ft.y -= 0.9 * dt;
        ft.life -= 0.022 * dt;
        if (ft.life <= 0) floatingTexts.splice(i, 1);
    }
}

function drawParticlesAndText() {
    particles.forEach(p => {
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    });

    floatingTexts.forEach(ft => {
        ctx.save();
        ctx.globalAlpha = Math.max(0, ft.life);
        ctx.font = '800 16px "Nunito", "Comic Sans MS", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#ffffff';
        ctx.strokeText(ft.text, ft.x, ft.y);
        ctx.fillStyle = ft.color;
        ctx.fillText(ft.text, ft.x, ft.y);
        ctx.restore();
    });
}

// --- HUD & Overlays ---

function drawHUD() {
    // Top-left: 3 Friendly Hearts
    for (let i = 0; i < maxHearts; i++) {
        drawHeartShape(26 + i * 28, 16, 18, i < hearts);
    }

    // Top-center: Big friendly Score pill
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2.5;
    roundedRectPath(GAME_WIDTH / 2 - 52, 12, 104, 34, 17);
    ctx.fill();
    ctx.stroke();

    ctx.font = '900 20px "Nunito", "Comic Sans MS", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#b45309';
    ctx.fillText(String(score), GAME_WIDTH / 2, 29.5);
    ctx.restore();

    // Kids aboard & Level pill under score
    ctx.save();
    ctx.font = '800 11px "Nunito", "Comic Sans MS", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const busText = schoolPending ? 'FULL BUS! -> SCHOOL' : `LVL ${difficultyLevel} • SEATS ${kidsOnBus}/4`;
    const pillW = Math.ceil(ctx.measureText(busText).width) + 20;
    ctx.fillStyle = schoolPending ? '#22c55e' : 'rgba(255, 255, 255, 0.85)';
    roundedRectPath(GAME_WIDTH / 2 - pillW / 2, 52, pillW, 20, 10);
    ctx.fill();
    ctx.fillStyle = schoolPending ? '#ffffff' : '#0369a1';
    ctx.fillText(busText, GAME_WIDTH / 2, 62.5);
    ctx.restore();

    // Top-right: Sound Toggle Pill
    ctx.save();
    ctx.font = '700 12px "Nunito", "Comic Sans MS", sans-serif';
    const soundLabel = muted ? 'Muted' : 'Sound On';
    const maxSoundW = Math.max(ctx.measureText('Sound On').width, ctx.measureText('Muted').width);
    const soundPillW = Math.ceil(maxSoundW) + 22;
    const pillX = GAME_WIDTH - 12 - soundPillW;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1.6;
    roundedRectPath(pillX, 14, soundPillW, 26, 13);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#334155';
    ctx.fillText(soundLabel, pillX + soundPillW / 2, 27.5);
    ctx.restore();
}

function drawStartOverlay() {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Friendly Card
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    roundedRectPath(GAME_WIDTH / 2 - 156, 114, 312, 132, 24);
    ctx.fill();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 3.5;
    ctx.stroke();

    ctx.fillStyle = '#d97706';
    ctx.font = '900 28px "Nunito", "Comic Sans MS", sans-serif';
    ctx.fillText('SUNNY BUS!', GAME_WIDTH / 2, 148);

    ctx.fillStyle = '#0284c7';
    ctx.font = '800 13.5px "Nunito", "Comic Sans MS", sans-serif';
    ctx.fillText('Pick up friends & stars!', GAME_WIDTH / 2, 180);

    ctx.fillStyle = '#475569';
    ctx.font = '700 12px "Nunito", "Comic Sans MS", sans-serif';
    ctx.fillText('Hop cones & puddles • Watch out for high birds!', GAME_WIDTH / 2, 204);

    if (bestScore > 0) {
        ctx.fillStyle = '#16a34a';
        ctx.font = '800 13px "Nunito", "Comic Sans MS", sans-serif';
        ctx.fillText(`Best Score: ${bestScore}`, GAME_WIDTH / 2, 226);
    }

    // Bouncing Play Button
    const pulse = 1 + 0.04 * Math.sin(animTime * 0.1);
    ctx.translate(GAME_WIDTH / 2, 310);
    ctx.scale(pulse, pulse);
    ctx.fillStyle = '#22c55e';
    ctx.strokeStyle = '#15803d';
    ctx.lineWidth = 3;
    roundedRectPath(-118, -26, 236, 52, 26);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '900 21px "Nunito", "Comic Sans MS", sans-serif';
    ctx.fillText('TAP TO DRIVE!', 0, 1);
    ctx.restore();
}

function drawGameOverOverlay() {
    ctx.save();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.42)';
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    const cardW = 304;
    const cardH = 266;
    const cardX = (GAME_WIDTH - cardW) / 2;
    const cardY = (GAME_HEIGHT - cardH) / 2 - 20;

    ctx.fillStyle = '#ffffff';
    roundedRectPath(cardX, cardY, cardW, cardH, 24);
    ctx.fill();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = '#0284c7';
    ctx.font = '900 26px "Nunito", "Comic Sans MS", sans-serif';
    ctx.fillText('GREAT RIDE!', GAME_WIDTH / 2, cardY + 38);

    ctx.fillStyle = '#64748b';
    ctx.font = '800 12px "Nunito", "Comic Sans MS", sans-serif';
    ctx.fillText('SCORE', cardX + cardW * 0.3, cardY + 80);
    ctx.fillText('BEST', cardX + cardW * 0.7, cardY + 80);

    ctx.fillStyle = '#0f172a';
    ctx.font = '900 34px "Nunito", "Comic Sans MS", sans-serif';
    ctx.fillText(String(score), cardX + cardW * 0.3, cardY + 112);
    ctx.fillText(String(bestScore), cardX + cardW * 0.7, cardY + 112);

    ctx.fillStyle = '#16a34a';
    ctx.font = '800 13px "Nunito", "Comic Sans MS", sans-serif';
    ctx.fillText(`Friends Picked Up: ${kidsPickedUp}  •  Stars: ${starsCollected}`, GAME_WIDTH / 2, cardY + 150);

    if (isNewBest) {
        ctx.fillStyle = '#facc15';
        roundedRectPath(GAME_WIDTH / 2 - 58, cardY + 168, 116, 24, 12);
        ctx.fill();
        ctx.fillStyle = '#854d0e';
        ctx.font = '900 12px "Nunito", "Comic Sans MS", sans-serif';
        ctx.fillText('NEW RECORD!', GAME_WIDTH / 2, cardY + 180.5);
    }

    ctx.fillStyle = '#22c55e';
    ctx.strokeStyle = '#15803d';
    ctx.lineWidth = 2.5;
    roundedRectPath(GAME_WIDTH / 2 - 108, cardY + 204, 216, 44, 22);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '900 17px "Nunito", "Comic Sans MS", sans-serif';
    ctx.fillText('DRIVE AGAIN!', GAME_WIDTH / 2, cardY + 226.5);

    ctx.restore();
}

// --- Spawning & Gameplay Logic ---

function spawnCone(x, count = 1, height = 34, singleWidth = 28) {
    obstacles.push({
        type: 'cone',
        x,
        y: GROUND_Y - height,
        width: singleWidth * count,
        singleWidth,
        height,
        count,
        hit: false,
        cleared: false
    });
}

function spawnPuddle(x) {
    obstacles.push({
        type: 'puddle',
        x,
        y: GROUND_Y - 8,
        width: 28,
        height: 10,
        hit: false,
        cleared: false
    });
}

function spawnBird(x, heightOffset = 198) {
    obstacles.push({
        type: 'bird',
        x,
        baseY: GROUND_Y - heightOffset,
        y: GROUND_Y - heightOffset,
        width: 38,
        height: 26,
        extraSpeed: 0.65 + Math.min(0.65, (difficultyLevel - 1) * 0.10),
        wingPhase: Math.random() * Math.PI * 2,
        hit: false,
        cleared: false
    });
}

function getRightmostObstacleEdge() {
    let maxRight = -Infinity;
    for (const obs of obstacles) {
        const right = obs.x + obs.width;
        if (right > maxRight) maxRight = right;
    }
    return maxRight;
}

function spawnNextWave() {
    spawnCount++;
    const x = GAME_WIDTH + 60;

    // If the bus is full (4 kids), spawn the Sunny School drop-off arch!
    if (schoolPending) {
        const alreadyHasSchool = pickups.some(p => p.type === 'school' && !p.collected);
        if (!alreadyHasSchool) {
            pickups.push({
                type: 'school',
                x: x + 20,
                y: GROUND_Y,
                width: 84,
                height: 110,
                collected: false
            });
            return;
        }
    }

    // Bus stop every 3rd wave (or every 4th wave at higher levels so cones appear more often)
    const kidEvery = difficultyLevel >= 3 ? 4 : 3;
    if (spawnCount % kidEvery === 0) {
        const shirts = ['#ec4899', '#3b82f6', '#22c55e', '#a855f7'];
        const hairs = ['#78350f', '#1e293b', '#d97706', '#451a03'];
        pickups.push({
            type: 'kid',
            x,
            y: GROUND_Y,
            width: 34,
            height: 50,
            shirtColor: shirts[kidsPickedUp % shirts.length],
            hairColor: hairs[kidsPickedUp % hairs.length],
            wavePhase: Math.random() * Math.PI * 2,
            collected: false
        });
        pickups.push({
            type: 'star',
            x: x - 12,
            y: GROUND_Y - 105,
            radius: 14,
            collected: false
        });
        return;
    }

    const roll = Math.random();

    // High-flying aerial bird (only hit if you double jump! Safe on ground and single jump)
    if (difficultyLevel >= 2 && roll < 0.22) {
        spawnBird(x, 198);
        pickups.push({
            type: 'star',
            x: x + 10,
            y: GROUND_Y - 96,
            radius: 14,
            collected: false
        });
        return;
    }

    // Half-sized splash puddle (less frequent as cones ramp up)
    const puddleChance = Math.max(0.14, 0.36 - (difficultyLevel - 1) * 0.05);
    if (roll < 0.22 + puddleChance) {
        spawnPuddle(x);
        pickups.push({
            type: 'star',
            x: x + 14,
            y: GROUND_Y - 88,
            radius: 14,
            collected: false
        });
        return;
    }

    // Progressive Cone Patterns (guaranteed single-formation waves with safe landing paths!)
    if (difficultyLevel === 1) {
        spawnCone(x, 1, 34, 28);
        pickups.push({ type: 'star', x: x + 14, y: GROUND_Y - 100, radius: 14, collected: false });
    } else if (difficultyLevel === 2) {
        if (Math.random() < 0.5) {
            spawnCone(x, 2, 34, 25); // Double cones
            pickups.push({ type: 'star', x: x + 25, y: GROUND_Y - 106, radius: 14, collected: false });
        } else {
            spawnCone(x, 1, 48, 34); // Tall 2-stripe cone
            pickups.push({ type: 'star', x: x + 17, y: GROUND_Y - 116, radius: 14, collected: false });
        }
    } else if (difficultyLevel === 3) {
        const pattern = Math.random();
        if (pattern < 0.40) {
            spawnCone(x, 2, 38, 26); // Double medium cones
            pickups.push({ type: 'star', x: x + 26, y: GROUND_Y - 110, radius: 14, collected: false });
        } else if (pattern < 0.75) {
            spawnCone(x, 1, 54, 35); // Tall cone
            pickups.push({ type: 'star', x: x + 18, y: GROUND_Y - 124, radius: 14, collected: false });
        } else {
            // Single cone + high bird overhead (single jump clears cone safely under the bird!)
            spawnCone(x, 1, 34, 28);
            spawnBird(x + 28, 198);
            pickups.push({ type: 'star', x: x + 14, y: GROUND_Y - 102, radius: 14, collected: false });
        }
    } else {
        // Level 4+: Triple cones, Double tall cones, Mega cones, and Cone + High Bird combos
        const pattern = Math.random();
        if (pattern < 0.28) {
            spawnCone(x, 3, 36, 24); // Triple cones
            pickups.push({ type: 'star', x: x + 36, y: GROUND_Y - 116, radius: 14, collected: false });
        } else if (pattern < 0.55) {
            spawnCone(x, 2, 46, 28); // Double tall cones
            pickups.push({ type: 'star', x: x + 28, y: GROUND_Y - 126, radius: 14, collected: false });
        } else if (pattern < 0.78) {
            spawnCone(x, 1, 62, 38); // Mega cone
            pickups.push({ type: 'star', x: x + 19, y: GROUND_Y - 134, radius: 14, collected: false });
        } else {
            // Single cone + high bird overhead (avoid double-jumping!)
            spawnCone(x, 1, 36, 28);
            spawnBird(x + 32, 198);
            pickups.push({ type: 'star', x: x + 14, y: GROUND_Y - 104, radius: 14, collected: false });
        }
    }
}

function updateGame(dt) {
    // Progressive difficulty level & user-configured speed ramp
    const newLevel = 1 + Math.floor(score / 100);
    if (newLevel > difficultyLevel) {
        difficultyLevel = newLevel;
        playSound('school');
        addFloatingText(GAME_WIDTH / 2, 130, `LEVEL ${difficultyLevel}!`, '#f59e0b');
    }

    worldSpeed = Math.min(MAX_SPEED, BASE_SPEED + score * 0.0022);
    roadOffset += worldSpeed * dt;
    bus.wheelAngle += 0.22 * (worldSpeed / BASE_SPEED) * dt;

    if (invulnTimer > 0) invulnTimer = Math.max(0, invulnTimer - dt);
    if (bus.squash > 0) bus.squash = Math.max(0, bus.squash - 0.08 * dt);

    // Bus vertical jump physics
    bus.vy += GRAVITY * dt;
    bus.y += bus.vy * dt;

    if (bus.y >= GROUND_Y - bus.height) {
        if (bus.vy > 2) bus.squash = 0.7;
        bus.y = GROUND_Y - bus.height;
        bus.vy = 0;
        bus.jumpsUsed = 0;
    }

    // Spawn waves more frequently as difficulty increases, while ALWAYS guaranteeing
    // a safe landing & reaction gap after the previous obstacle at the current speed!
    const spawnInterval = Math.max(44, 88 - (difficultyLevel - 1) * 7);
    const minSafeGap = Math.max(150, worldSpeed * 42);
    const rightmostEdge = getRightmostObstacleEdge();
    const hasSafeLandingRoom = (GAME_WIDTH + 60) - rightmostEdge >= minSafeGap;

    spawnTimer += dt * (worldSpeed / BASE_SPEED);
    if (spawnTimer >= spawnInterval && hasSafeLandingRoom) {
        spawnTimer = 0;
        spawnNextWave();
    }

    // Forgiving bus hitbox extending down to the tires so puddles & cones register cleanly
    const hitX = bus.x + 12;
    const hitY = bus.y + 8;
    const hitW = bus.width - 22;
    const hitH = bus.height - 8;

    // Move & check pickups
    for (let i = pickups.length - 1; i >= 0; i--) {
        const p = pickups[i];
        p.x -= worldSpeed * dt;

        if (!p.collected) {
            if (p.type === 'star') {
                const dist = Math.hypot((hitX + hitW / 2) - p.x, (hitY + hitH / 2) - p.y);
                if (dist < p.radius + 32) {
                    p.collected = true;
                    score += 10;
                    starsCollected++;
                    playSound('star');
                    spawnSparkles(p.x, p.y, '#facc15', 10);
                    addFloatingText(p.x, p.y - 12, '+10 ★', '#ca8a04');
                }
            } else if (p.type === 'kid') {
                if (bus.x + bus.width > p.x - 12 && bus.x < p.x + 28) {
                    p.collected = true;
                    score += 25;
                    kidsPickedUp++;
                    if (kidsOnBus < 4) kidsOnBus++;
                    if (kidsOnBus >= 4) schoolPending = true;
                    playSound('kid');
                    spawnSparkles(p.x, GROUND_Y - 26, '#38bdf8', 12);
                    addFloatingText(bus.x + bus.width / 2, bus.y - 14, 'ALL ABOARD! +25', '#0284c7');
                }
            } else if (p.type === 'school') {
                if (bus.x + bus.width / 2 > p.x) {
                    p.collected = true;
                    score += 100;
                    kidsOnBus = 0;
                    schoolPending = false;
                    if (hearts < maxHearts) {
                        hearts++;
                        addFloatingText(bus.x + bus.width / 2, bus.y - 36, '+1 HEART ♥', '#ef4444');
                    }
                    playSound('school');
                    ['#ef4444', '#facc15', '#22c55e', '#38bdf8', '#c084fc'].forEach(col => {
                        spawnSparkles(p.x, GROUND_Y - 70, col, 6);
                    });
                    addFloatingText(p.x, GROUND_Y - 120, 'SCHOOL DROP-OFF! +100', '#16a34a');
                }
            }
        }

        if (p.x < -120) pickups.splice(i, 1);
    }

    // Move & check obstacles (cones, puddles, aerial birds)
    for (let i = obstacles.length - 1; i >= 0; i--) {
        const obs = obstacles[i];
        const moveSpeed = obs.type === 'bird' ? worldSpeed + (obs.extraSpeed || 0.8) : worldSpeed;
        obs.x -= moveSpeed * dt;

        if (obs.type === 'bird') {
            obs.y = obs.baseY + Math.sin(animTime * 0.14 + (obs.wingPhase || 0)) * 6;
        }

        // Award +5 points for cleanly clearing an obstacle
        if (!obs.cleared && !obs.hit && obs.x + obs.width < bus.x) {
            obs.cleared = true;
            score += 5;
        }

        if (!obs.hit && invulnTimer <= 0) {
            const padX = obs.type === 'puddle' ? 6 : 5;
            const padTop = obs.type === 'puddle' ? 2 : 4;
            const ox = obs.x + padX;
            const oy = obs.y + padTop;
            const ow = obs.width - padX * 2;
            const oh = obs.height - padTop;

            if (hitX < ox + ow && hitX + hitW > ox && hitY < oy + oh && hitY + hitH > oy) {
                obs.hit = true;
                hearts--;
                invulnTimer = 95; // ~1.6s grace shield
                if (obs.type !== 'bird') {
                    bus.vy = -4.5; // Gentle bounce over ground obstacles
                }
                playSound('bonk');
                const sparkColor = obs.type === 'puddle' ? '#38bdf8' : (obs.type === 'bird' ? '#a78bfa' : '#f97316');
                const label = obs.type === 'puddle' ? 'SPLASH!' : 'OOPS!';
                spawnSparkles(obs.x + obs.width / 2, obs.y, sparkColor, 14);
                addFloatingText(bus.x + bus.width / 2, bus.y - 12, label, obs.type === 'puddle' ? '#0284c7' : '#ef4444');

                if (hearts <= 0) {
                    triggerGameOver();
                }
            }
        }

        if (obs.x + obs.width < -60) obstacles.splice(i, 1);
    }
}

function triggerGameOver() {
    gameState = 'gameover';
    gameOverTime = performance.now();
    if (score > bestScore) {
        bestScore = score;
        isNewBest = true;
        try {
            localStorage.setItem(BEST_SCORE_KEY, String(bestScore));
        } catch {
            // Ignore
        }
    }
}

function resetGame() {
    bus = createInitialBus();
    obstacles = [];
    pickups = [];
    particles = [];
    floatingTexts = [];
    score = 0;
    difficultyLevel = 1;
    hearts = 3;
    kidsOnBus = 0;
    kidsPickedUp = 0;
    starsCollected = 0;
    schoolPending = false;
    invulnTimer = 0;
    spawnTimer = 35;
    spawnCount = 0;
    isNewBest = false;
    worldSpeed = BASE_SPEED;
    gameState = 'playing';
}

function hopBus() {
    if (bus.jumpsUsed < bus.maxJumps) {
        const isDouble = bus.jumpsUsed === 1;
        bus.vy = isDouble ? DOUBLE_JUMP_VELOCITY : JUMP_VELOCITY;
        bus.jumpsUsed++;
        bus.squash = -0.6;
        spawnHopParticles(isDouble);
        playSound(isDouble ? 'doublehop' : 'hop');
    }
}

// --- Main Loop ---

function gameLoop(now) {
    const rawDt = (now - lastTime) / 16.6667;
    const dt = Math.min(Math.max(rawDt, 0.1), 2.5);
    lastTime = now;

    animTime += dt;

    clouds.forEach(c => {
        c.x -= c.speed * dt;
        if (c.x < -80) {
            c.x = GAME_WIDTH + 60;
            c.y = 54 + Math.random() * 90;
        }
    });

    ctx.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    if (gameState === 'start') {
        roadOffset += BASE_SPEED * 0.65 * dt;
        bus.wheelAngle += 0.16 * dt;
        bus.y = GROUND_Y - bus.height + Math.sin(animTime * 0.16) * 1.2;

        drawBackground();
        drawRoad();
        drawSchoolBus();
        drawStartOverlay();
        drawHUD();
    } else if (gameState === 'playing') {
        updateGame(dt);
        updateParticlesAndText(dt);

        drawBackground();
        drawRoad();
        drawPickups();
        drawObstacles();
        drawSchoolBus();
        drawParticlesAndText();
        drawHUD();
    } else if (gameState === 'gameover') {
        updateParticlesAndText(dt);

        drawBackground();
        drawRoad();
        drawPickups();
        drawObstacles();
        drawSchoolBus();
        drawParticlesAndText();
        drawHUD();
        drawGameOverOverlay();
    }

    requestAnimationFrame(gameLoop);
}

// --- Input Handling ---

function handleAction(e) {
    ensureAudio();

    if (e && e.type === 'pointerdown') {
        const rect = canvas.getBoundingClientRect();
        const scaleX = GAME_WIDTH / rect.width;
        const scaleY = GAME_HEIGHT / rect.height;
        const clickX = (e.clientX - rect.left) * scaleX;
        const clickY = (e.clientY - rect.top) * scaleY;

        // Top-right sound button
        if (clickX >= GAME_WIDTH - 96 && clickY <= 48) {
            muted = !muted;
            return;
        }
    }

    if (gameState === 'start') {
        resetGame();
        hopBus();
    } else if (gameState === 'playing') {
        hopBus();
    } else if (gameState === 'gameover') {
        if (performance.now() - gameOverTime > 320) {
            resetGame();
        }
    }
}

canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handleAction(e);
});

// Prevent mobile double-tap zoom
canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
canvas.addEventListener('touchend', (e) => e.preventDefault(), { passive: false });
canvas.addEventListener('dblclick', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
        e.preventDefault();
        if (!e.repeat) {
            handleAction(e);
        }
    } else if (e.code === 'KeyM') {
        muted = !muted;
    }
});

requestAnimationFrame((now) => {
    lastTime = now;
    gameLoop(now);
});
