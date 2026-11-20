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

// Physics & Gameplay constants (tuned for 60 FPS normalized delta time)
const GRAVITY = 0.44;
const JUMP_VELOCITY = -7.6;
const MAX_FALL_SPEED = 10.5;
const PIPE_WIDTH = 62;
const PIPE_GAP = 148;
const PIPE_SPEED = 2.6;
const PIPE_SPAWN_INTERVAL = 96; // ~1.6s at 60fps
const BEST_SCORE_KEY = 'teslaFlappyBestScore';

// Game state
let gameState = 'start'; // 'start' | 'playing' | 'gameover'
let score = 0;
let bestScore = Number(localStorage.getItem(BEST_SCORE_KEY)) || 0;
let isNewBest = false;
let gameOverTime = 0;
let flashAlpha = 0;
let muted = false;

// Timing
let lastTime = performance.now();
let spawnTimer = 0;
let idleTime = 0;
let groundOffset = 0;
let wheelAngle = 0;

// Player: Silver Tesla
let tesla = createInitialTesla();

function createInitialTesla() {
    return {
        x: 74,
        y: PLAYABLE_HEIGHT * 0.46,
        width: 68,
        height: 28,
        velocity: 0,
        rotation: 0
    };
}

// World entities
let pipes = [];
let particles = [];
let clouds = [
    { x: 40, y: 78, scale: 0.9, speed: 0.35 },
    { x: 185, y: 128, scale: 0.7, speed: 0.25 },
    { x: 310, y: 64, scale: 1.05, speed: 0.42 }
];
let skylineBuildings = generateSkyline();

function generateSkyline() {
    const buildings = [];
    let x = 0;
    while (x < GAME_WIDTH + 120) {
        const w = 24 + Math.floor(Math.random() * 26);
        const h = 42 + Math.floor(Math.random() * 72);
        buildings.push({ x, w, h, hasSpire: Math.random() > 0.72 });
        x += w + 3;
    }
    return buildings;
}

// --- Lightweight Web Audio Synth ---
let audioCtx = null;
function getAudioContext() {
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
    const ac = getAudioContext();
    if (!ac) return;
    try {
        const now = ac.currentTime;
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.connect(gain);
        gain.connect(ac.destination);

        if (type === 'jump') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(280, now);
            osc.frequency.exponentialRampToValueAtTime(520, now + 0.09);
            gain.gain.setValueAtTime(0.08, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
            osc.start(now);
            osc.stop(now + 0.12);
        } else if (type === 'score') {
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(660, now);
            osc.frequency.setValueAtTime(880, now + 0.06);
            gain.gain.setValueAtTime(0.09, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
            osc.start(now);
            osc.stop(now + 0.21);
        } else if (type === 'crash') {
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(170, now);
            osc.frequency.exponentialRampToValueAtTime(48, now + 0.24);
            gain.gain.setValueAtTime(0.14, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
            osc.start(now);
            osc.stop(now + 0.26);
        }
    } catch {
        // Ignore audio errors
    }
}

// --- Helper Drawing Utilities ---

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

// --- Environment Drawing ---

function drawBackground() {
    // Crisp sky gradient
    const skyGrad = ctx.createLinearGradient(0, 0, 0, PLAYABLE_HEIGHT);
    skyGrad.addColorStop(0, '#38bdf8');
    skyGrad.addColorStop(0.55, '#7dd3fc');
    skyGrad.addColorStop(1, '#bae6fd');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, GAME_WIDTH, PLAYABLE_HEIGHT);

    // Subtle warm sun glow
    const sunGrad = ctx.createRadialGradient(325, 76, 8, 325, 76, 78);
    sunGrad.addColorStop(0, 'rgba(255, 251, 214, 0.95)');
    sunGrad.addColorStop(0.35, 'rgba(254, 240, 138, 0.45)');
    sunGrad.addColorStop(1, 'rgba(254, 240, 138, 0)');
    ctx.fillStyle = sunGrad;
    ctx.beginPath();
    ctx.arc(325, 76, 78, 0, Math.PI * 2);
    ctx.fill();

    // Fluffy parallax clouds
    clouds.forEach(cloud => drawCloud(cloud.x, cloud.y, cloud.scale));

    // Distant skyline silhouette
    ctx.fillStyle = 'rgba(100, 149, 189, 0.35)';
    skylineBuildings.forEach(b => {
        const bx = b.x;
        const by = PLAYABLE_HEIGHT - b.h;
        ctx.fillRect(bx, by, b.w, b.h);
        if (b.hasSpire) {
            ctx.fillRect(bx + b.w * 0.45, by - 12, 3, 12);
        }
    });

    // Soft green distant hills
    ctx.fillStyle = '#74b876';
    ctx.beginPath();
    ctx.moveTo(0, PLAYABLE_HEIGHT);
    ctx.quadraticCurveTo(75, PLAYABLE_HEIGHT - 36, 165, PLAYABLE_HEIGHT - 12);
    ctx.quadraticCurveTo(270, PLAYABLE_HEIGHT - 44, 400, PLAYABLE_HEIGHT - 10);
    ctx.lineTo(400, PLAYABLE_HEIGHT);
    ctx.closePath();
    ctx.fill();
}

function drawCloud(x, y, scale) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
    ctx.beginPath();
    ctx.arc(0, 0, 16, 0, Math.PI * 2);
    ctx.arc(17, -5, 20, 0, Math.PI * 2);
    ctx.arc(37, -1, 16, 0, Math.PI * 2);
    ctx.arc(50, 4, 12, 0, Math.PI * 2);
    ctx.arc(-13, 4, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function drawGround() {
    const y = PLAYABLE_HEIGHT;

    // Grass top strip
    const grassGrad = ctx.createLinearGradient(0, y, 0, y + 14);
    grassGrad.addColorStop(0, '#4ade80');
    grassGrad.addColorStop(1, '#16a34a');
    ctx.fillStyle = grassGrad;
    ctx.fillRect(0, y, GAME_WIDTH, 14);

    // Scrolling diagonal grass notches
    ctx.fillStyle = '#22c55e';
    for (let x = -24 + (groundOffset % 24); x < GAME_WIDTH + 24; x += 24) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 12, y);
        ctx.lineTo(x + 6, y + 12);
        ctx.lineTo(x - 6, y + 12);
        ctx.closePath();
        ctx.fill();
    }

    // Curb border
    ctx.fillStyle = '#cbd5e1';
    ctx.fillRect(0, y + 12, GAME_WIDTH, 5);
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, y, GAME_WIDTH, 2);

    // Asphalt highway
    const roadGrad = ctx.createLinearGradient(0, y + 17, 0, GAME_HEIGHT);
    roadGrad.addColorStop(0, '#334155');
    roadGrad.addColorStop(1, '#1e293b');
    ctx.fillStyle = roadGrad;
    ctx.fillRect(0, y + 17, GAME_WIDTH, GROUND_HEIGHT - 17);

    // Dashed yellow/amber road center line
    ctx.fillStyle = '#facc15';
    const dashPeriod = 48;
    const startX = -(groundOffset % dashPeriod);
    for (let x = startX - dashPeriod; x < GAME_WIDTH + dashPeriod; x += dashPeriod) {
        roundedRectPath(x, y + 44, 26, 5, 2);
        ctx.fill();
    }
}

// --- Pipes Drawing (Classic 3D Flappy Bird Style) ---

function drawPipes() {
    pipes.forEach(pipe => {
        drawSinglePipe(pipe.x, 0, PIPE_WIDTH, pipe.topHeight, 'top');
        drawSinglePipe(pipe.x, pipe.bottomY, PIPE_WIDTH, PLAYABLE_HEIGHT - pipe.bottomY, 'bottom');
    });
}

function drawSinglePipe(x, y, w, h, side) {
    if (h <= 0) return;

    const capH = 24;
    const overhang = 5;

    // 3D cylindrical green gradient
    const pipeGrad = ctx.createLinearGradient(x, 0, x + w, 0);
    pipeGrad.addColorStop(0, '#166534');
    pipeGrad.addColorStop(0.18, '#4ade80');
    pipeGrad.addColorStop(0.35, '#86efac');
    pipeGrad.addColorStop(0.65, '#22c55e');
    pipeGrad.addColorStop(1, '#14532d');

    ctx.fillStyle = pipeGrad;
    ctx.strokeStyle = '#0f291e';
    ctx.lineWidth = 2.2;

    // Main shaft
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);

    // Specular vertical highlight stripe
    ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.fillRect(x + 9, y + 1, 6, h - 2);

    // Flanged pipe cap
    const capY = side === 'top' ? y + h - capH : y;
    const capX = x - overhang;
    const capW = w + overhang * 2;

    const capGrad = ctx.createLinearGradient(capX, 0, capX + capW, 0);
    capGrad.addColorStop(0, '#14532d');
    capGrad.addColorStop(0.18, '#4ade80');
    capGrad.addColorStop(0.34, '#bbf7d0');
    capGrad.addColorStop(0.68, '#22c55e');
    capGrad.addColorStop(1, '#052e16');

    ctx.fillStyle = capGrad;
    roundedRectPath(capX, capY, capW, capH, 4);
    ctx.fill();
    ctx.stroke();

    // Cap top rim highlight
    ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.fillRect(capX + 10, capY + 2, 7, capH - 4);
}

// --- Electric Boost Particles ---

function spawnBoostParticles() {
    const cos = Math.cos(tesla.rotation);
    const sin = Math.sin(tesla.rotation);
    const tailX = tesla.x + tesla.width * 0.5 - cos * (tesla.width * 0.48);
    const tailY = tesla.y + tesla.height * 0.5 - sin * (tesla.width * 0.48) + 4;

    for (let i = 0; i < 6; i++) {
        particles.push({
            x: tailX + (Math.random() - 0.5) * 6,
            y: tailY + (Math.random() - 0.5) * 6,
            vx: -1.8 - Math.random() * 1.8,
            vy: 0.6 + Math.random() * 1.6,
            radius: 2.2 + Math.random() * 2.5,
            life: 1,
            color: Math.random() > 0.35 ? '#38bdf8' : '#e0f2fe'
        });
    }
}

function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.life -= 0.055 * dt;
        if (p.life <= 0) {
            particles.splice(i, 1);
        }
    }
}

function drawParticles() {
    particles.forEach(p => {
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius * p.life, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    });
}

// --- Silver Tesla Drawing ---

function drawTesla() {
    const cx = tesla.x + tesla.width / 2;
    const cy = tesla.y + tesla.height / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(tesla.rotation);

    const w = tesla.width;   // 68
    const h = tesla.height;  // 28
    const left = -w / 2;     // -34
    const top = -h / 2;      // -14

    // Subtle headlight beam during flight
    if (gameState !== 'gameover') {
        const beamGrad = ctx.createLinearGradient(left + w - 4, top + 13, left + w + 48, top + 13);
        beamGrad.addColorStop(0, 'rgba(254, 249, 195, 0.42)');
        beamGrad.addColorStop(1, 'rgba(254, 249, 195, 0)');
        ctx.fillStyle = beamGrad;
        ctx.beginPath();
        ctx.moveTo(left + w - 3, top + 13);
        ctx.lineTo(left + w + 46, top + 3);
        ctx.lineTo(left + w + 46, top + 25);
        ctx.closePath();
        ctx.fill();
    }

    // Sleek metallic silver Tesla body silhouette (Model S / Model 3 fastback profile)
    const bodyGrad = ctx.createLinearGradient(0, top, 0, top + h - 4);
    bodyGrad.addColorStop(0, '#f8fafc');
    bodyGrad.addColorStop(0.32, '#e2e8f0');
    bodyGrad.addColorStop(0.62, '#94a3b8');
    bodyGrad.addColorStop(1, '#475569');

    ctx.fillStyle = bodyGrad;
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1.5;

    ctx.beginPath();
    // Start at rear bottom bumper
    ctx.moveTo(left + 4, top + h - 5);
    // Rear bumper & trunk lip (subtle ducktail spoiler)
    ctx.quadraticCurveTo(left, top + h - 6, left + 1, top + 12);
    ctx.lineTo(left + 5, top + 9);
    // Fastback roofline curving smoothly up & over
    ctx.quadraticCurveTo(left + 18, top, left + 33, top + 1);
    ctx.quadraticCurveTo(left + 46, top + 2, left + 53, top + 10);
    // Low aerodynamic Tesla hood & front nose
    ctx.quadraticCurveTo(left + 64, top + 11, left + w - 1, top + 16);
    // Front bumper & chin splitter
    ctx.quadraticCurveTo(left + w, top + h - 5, left + w - 5, top + h - 5);
    // Underbody line
    ctx.lineTo(left + 4, top + h - 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Panoramic tinted glass cabin & side windows
    const glassGrad = ctx.createLinearGradient(0, top + 2, 0, top + 12);
    glassGrad.addColorStop(0, '#0f172a');
    glassGrad.addColorStop(0.6, '#1e293b');
    glassGrad.addColorStop(1, '#334155');
    ctx.fillStyle = glassGrad;

    ctx.beginPath();
    ctx.moveTo(left + 13, top + 10);
    ctx.quadraticCurveTo(left + 23, top + 2.5, left + 34, top + 2.8);
    ctx.quadraticCurveTo(left + 44, top + 3.2, left + 50, top + 10.5);
    ctx.lineTo(left + 13, top + 10.5);
    ctx.closePath();
    ctx.fill();

    // Window B-pillar divider & crisp glass reflection
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(left + 31, top + 3);
    ctx.lineTo(left + 30, top + 10.5);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left + 21, top + 5);
    ctx.lineTo(left + 38, top + 5);
    ctx.stroke();

    // Body character crease & silver sheen highlight
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left + 8, top + 13);
    ctx.quadraticCurveTo(left + 34, top + 12, left + 57, top + 13.5);
    ctx.stroke();

    // Flush chrome/dark door handles (signature Tesla detail)
    ctx.fillStyle = '#334155';
    roundedRectPath(left + 22, top + 13.5, 5, 1.8, 0.8);
    ctx.fill();
    roundedRectPath(left + 36, top + 13.5, 5, 1.8, 0.8);
    ctx.fill();

    // Subtle red Tesla "T" emblem accent on hood/fender
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(left + 58, top + 11.5, 3.5, 1.1);
    ctx.fillRect(left + 59.2, top + 12.2, 1.1, 2.2);

    // Glowing LED Headlight
    ctx.fillStyle = '#fef9c3';
    ctx.beginPath();
    ctx.moveTo(left + w - 7, top + 13.5);
    ctx.quadraticCurveTo(left + w - 2, top + 13, left + w - 1.5, top + 16);
    ctx.lineTo(left + w - 6, top + 16);
    ctx.closePath();
    ctx.fill();

    // Sleek Red LED Taillight
    ctx.fillStyle = '#ef4444';
    roundedRectPath(left + 0.8, top + 12, 4.5, 3, 1);
    ctx.fill();

    // Wheel wells (dark cutouts)
    const rearWheelX = left + 15;
    const frontWheelX = left + w - 15;
    const wheelY = top + h - 5;

    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(rearWheelX, wheelY, 7.2, Math.PI, 0);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(frontWheelX, wheelY, 7.2, Math.PI, 0);
    ctx.fill();

    // Draw spinning silver turbine wheels
    drawWheel(rearWheelX, wheelY);
    drawWheel(frontWheelX, wheelY);

    ctx.restore();
}

function drawWheel(x, y) {
    ctx.save();
    ctx.translate(x, y);

    // Tire
    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.arc(0, 0, 6.2, 0, Math.PI * 2);
    ctx.fill();

    // Alloy rim
    ctx.fillStyle = '#cbd5e1';
    ctx.beginPath();
    ctx.arc(0, 0, 4.1, 0, Math.PI * 2);
    ctx.fill();

    // Performance red brake caliper glimpse
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(1, -2.5, 2, 3);

    // Spinning turbine spokes
    ctx.rotate(wheelAngle);
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 5; i++) {
        const a = (i * Math.PI * 2) / 5;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * 3.8, Math.sin(a) * 3.8);
        ctx.stroke();
    }

    // Center hubcap
    ctx.fillStyle = '#64748b';
    ctx.beginPath();
    ctx.arc(0, 0, 1.4, 0, Math.PI * 2);
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
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.75)';
    ctx.strokeText(String(score), GAME_WIDTH / 2, 26);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(score), GAME_WIDTH / 2, 26);
    ctx.restore();
}

function drawMuteBadge() {
    const badgeY = 12;
    const badgeH = 24;
    const centerY = badgeY + badgeH / 2;

    ctx.save();
    ctx.font = '600 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const soundLabel = muted ? 'Muted' : 'Sound On';
    const maxSoundW = Math.max(
        ctx.measureText('Sound On').width,
        ctx.measureText('Muted').width
    );
    const badgeW = Math.ceil(maxSoundW) + 24;
    const badgeX = GAME_WIDTH - 12 - badgeW;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.2;
    roundedRectPath(badgeX, badgeY, badgeW, badgeH, badgeH / 2);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(soundLabel, badgeX + badgeW / 2, centerY + 0.5);
    ctx.restore();
}

function drawStartOverlay() {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Title Banner
    ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
    roundedRectPath(GAME_WIDTH / 2 - 140, 72, 280, 74, 16);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#f8fafc';
    ctx.font = '800 28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('TESLA FLAPPY', GAME_WIDTH / 2, 100);

    ctx.fillStyle = '#38bdf8';
    ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('AUTOPILOT EDITION', GAME_WIDTH / 2, 126);

    // Pulsing start prompt
    const pulse = 0.75 + 0.25 * Math.sin(idleTime * 0.08);
    ctx.fillStyle = `rgba(15, 23, 42, ${0.72 * pulse})`;
    roundedRectPath(GAME_WIDTH / 2 - 130, PLAYABLE_HEIGHT - 120, 260, 44, 22);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('Click or Press Space to Fly', GAME_WIDTH / 2, PLAYABLE_HEIGHT - 98);

    if (bestScore > 0) {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.65)';
        ctx.font = '700 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillText(`Best Score: ${bestScore}`, GAME_WIDTH / 2, PLAYABLE_HEIGHT - 56);
    }

    ctx.restore();
}

function drawGameOverOverlay() {
    ctx.save();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    const cardW = 286;
    const cardH = 228;
    const cardX = (GAME_WIDTH - cardW) / 2;
    const cardY = (PLAYABLE_HEIGHT - cardH) / 2 - 10;

    // Score card
    ctx.fillStyle = '#f8fafc';
    roundedRectPath(cardX, cardY, cardW, cardH, 18);
    ctx.fill();
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Header
    ctx.fillStyle = '#dc2626';
    ctx.font = '800 28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('GAME OVER', GAME_WIDTH / 2, cardY + 38);

    // Score & Best columns
    ctx.fillStyle = '#64748b';
    ctx.font = '700 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('SCORE', cardX + cardW * 0.3, cardY + 86);
    ctx.fillText('BEST', cardX + cardW * 0.7, cardY + 86);

    ctx.fillStyle = '#0f172a';
    ctx.font = '800 34px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(String(score), cardX + cardW * 0.3, cardY + 118);
    ctx.fillText(String(bestScore), cardX + cardW * 0.7, cardY + 118);

    if (isNewBest) {
        ctx.fillStyle = '#f59e0b';
        roundedRectPath(GAME_WIDTH / 2 - 48, cardY + 144, 96, 22, 11);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = '800 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillText('NEW BEST!', GAME_WIDTH / 2, cardY + 155);
    }

    // Restart button pill
    ctx.fillStyle = '#0284c7';
    roundedRectPath(GAME_WIDTH / 2 - 105, cardY + 174, 210, 38, 19);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('Click or Space to Restart', GAME_WIDTH / 2, cardY + 193);

    ctx.restore();
}

// --- Update & Collision Logic ---

function updateEnvironment(dt, speedMultiplier = 1) {
    groundOffset += PIPE_SPEED * speedMultiplier * dt;
    wheelAngle += 0.28 * speedMultiplier * dt;

    clouds.forEach(cloud => {
        cloud.x -= cloud.speed * speedMultiplier * dt;
        if (cloud.x < -80) {
            cloud.x = GAME_WIDTH + 60;
            cloud.y = 48 + Math.random() * 110;
        }
    });
}

function updateTesla(dt) {
    tesla.velocity = Math.min(tesla.velocity + GRAVITY * dt, MAX_FALL_SPEED);
    tesla.y += tesla.velocity * dt;

    // Clamp at top ceiling without instant death
    if (tesla.y < 0) {
        tesla.y = 0;
        tesla.velocity = 0;
    }

    // Smooth pitch angle based on vertical velocity (-24 deg up to +62 deg down)
    const targetRot = tesla.velocity < 0
        ? Math.max(-0.42, tesla.velocity * 0.055)
        : Math.min(1.08, tesla.velocity * 0.095);
    tesla.rotation += (targetRot - tesla.rotation) * Math.min(1, 0.22 * dt);
}

function updatePipes(dt) {
    spawnTimer += dt;
    if (spawnTimer >= PIPE_SPAWN_INTERVAL) {
        spawnTimer = 0;
        const minHeight = 56;
        const maxHeight = PLAYABLE_HEIGHT - PIPE_GAP - minHeight;
        const topHeight = Math.floor(Math.random() * (maxHeight - minHeight + 1)) + minHeight;

        pipes.push({
            x: GAME_WIDTH + 10,
            topHeight,
            bottomY: topHeight + PIPE_GAP,
            passed: false
        });
    }

    for (let i = pipes.length - 1; i >= 0; i--) {
        const pipe = pipes[i];
        pipe.x -= PIPE_SPEED * dt;

        if (!pipe.passed && pipe.x + PIPE_WIDTH < tesla.x + 8) {
            score++;
            pipe.passed = true;
            playSound('score');
        }

        if (pipe.x + PIPE_WIDTH + 12 < 0) {
            pipes.splice(i, 1);
        }
    }
}

function checkCollision() {
    // Forgiving hitbox slightly inset from the visual car silhouette
    const hitX = tesla.x + 7;
    const hitY = tesla.y + 4;
    const hitW = tesla.width - 14;
    const hitH = tesla.height - 7;

    // Ground collision
    if (hitY + hitH >= PLAYABLE_HEIGHT) {
        tesla.y = PLAYABLE_HEIGHT - tesla.height + 2;
        return true;
    }

    // Pipe collision
    for (const pipe of pipes) {
        if (hitX < pipe.x + PIPE_WIDTH && hitX + hitW > pipe.x) {
            if (hitY < pipe.topHeight || hitY + hitH > pipe.bottomY) {
                return true;
            }
        }
    }

    return false;
}

function triggerGameOver() {
    gameState = 'gameover';
    gameOverTime = performance.now();
    flashAlpha = 0.75;
    playSound('crash');

    if (score > bestScore) {
        bestScore = score;
        isNewBest = true;
        try {
            localStorage.setItem(BEST_SCORE_KEY, String(bestScore));
        } catch {
            // Ignore storage errors
        }
    }
}

function resetToStart() {
    tesla = createInitialTesla();
    pipes = [];
    particles = [];
    spawnTimer = PIPE_SPAWN_INTERVAL * 0.65;
    score = 0;
    isNewBest = false;
    gameState = 'start';
}

function flap() {
    tesla.velocity = JUMP_VELOCITY;
    spawnBoostParticles();
    playSound('jump');
}

// --- Main Game Loop ---

function gameLoop(now) {
    const rawDt = (now - lastTime) / 16.6667;
    const dt = Math.min(Math.max(rawDt, 0.1), 2.5);
    lastTime = now;

    ctx.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    if (gameState === 'start') {
        idleTime += dt;
        updateEnvironment(dt, 0.65);
        tesla.y = PLAYABLE_HEIGHT * 0.46 + Math.sin(idleTime * 0.08) * 7;
        tesla.rotation = Math.sin(idleTime * 0.08) * 0.04;

        drawBackground();
        drawGround();
        drawTesla();
        drawStartOverlay();
        drawMuteBadge();
    } else if (gameState === 'playing') {
        updateEnvironment(dt, 1);
        updateTesla(dt);
        updatePipes(dt);
        updateParticles(dt);

        if (checkCollision()) {
            triggerGameOver();
        }

        drawBackground();
        drawPipes();
        drawGround();
        drawParticles();
        drawTesla();
        drawScoreHUD();
        drawMuteBadge();
    } else if (gameState === 'gameover') {
        updateParticles(dt);
        if (flashAlpha > 0) {
            flashAlpha = Math.max(0, flashAlpha - 0.06 * dt);
        }

        drawBackground();
        drawPipes();
        drawGround();
        drawParticles();
        drawTesla();
        drawGameOverOverlay();
        drawMuteBadge();

        if (flashAlpha > 0) {
            ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha})`;
            ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
        }
    }

    requestAnimationFrame(gameLoop);
}

// --- Input Handling ---

function handleAction(e) {
    // Allow clicking mute badge directly
    if (e && e.type === 'pointerdown') {
        const rect = canvas.getBoundingClientRect();
        const scaleX = GAME_WIDTH / rect.width;
        const scaleY = GAME_HEIGHT / rect.height;
        const clickX = (e.clientX - rect.left) * scaleX;
        const clickY = (e.clientY - rect.top) * scaleY;
        if (clickX >= GAME_WIDTH - 96 && clickY <= 44) {
            muted = !muted;
            return;
        }
    }

    if (gameState === 'start') {
        gameState = 'playing';
        spawnTimer = PIPE_SPAWN_INTERVAL * 0.65;
        flap();
    } else if (gameState === 'playing') {
        flap();
    } else if (gameState === 'gameover') {
        if (performance.now() - gameOverTime > 320) {
            resetToStart();
        }
    }
}

canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handleAction(e);
});

// Prevent mobile double-tap zoom and pinch-zoom while tapping rapidly
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

// Start loop
requestAnimationFrame((now) => {
    lastTime = now;
    gameLoop(now);
});
