// Regenerates index.html from landing.template.html + the four game folders.
// Each game's HTML and JS are inlined (base64) so the landing page is fully
// self-contained and works from file:// with no server.
//
// Run: node build-index.js

const fs = require("fs");
const path = require("path");

const games = [
  {
    id: "airdribble",
    title: "Air Dribble",
    bestKey: "teslaRoadsterAirDribbleBest_v3",
    bestUnit: "s"
  },
  {
    id: "roadsterwallball",
    title: "Roadster Wallball",
    bestKey: "teslaRoadsterWallballBest_v1",
    bestUnit: "pts"
  },
  {
    id: "roadsterhover",
    title: "Roadster Hover",
    bestKey: "teslaRoadsterHoverBestScore_v2",
    bestUnit: "pts"
  },
  {
    id: "sunnybus",
    title: "Sunny Bus",
    bestKey: "sunnyBusBestScore_v1",
    bestUnit: "pts"
  },
  {
    id: "teslaflappy",
    title: "Tesla Flappy",
    bestKey: "teslaFlappyBestScore",
    bestUnit: "pts"
  }
];

const root = __dirname;

const data = games.map((game) => {
  const dir = path.join(root, game.id);
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const js = fs.readFileSync(path.join(dir, "game.js"), "utf8");

  const marker = '<script src="game.js"></script>';
  if (!html.includes(marker)) {
    throw new Error(`Could not find the game.js script tag in ${game.id}/index.html`);
  }

  const standalone = html
    .replace(marker, "<script>\n" + js + "\n</script>")
    .replace(/\r\n/g, "\n");
  return {
    ...game,
    html: Buffer.from(standalone, "utf8").toString("base64")
  };
});

const template = fs.readFileSync(path.join(root, "landing.template.html"), "utf8");
const json = JSON.stringify(data).replace(/</g, "\\u003c");
const output = template.split("__GAME_DATA__").join(json);

fs.writeFileSync(path.join(root, "index.html"), output, "utf8");

const kb = (Buffer.byteLength(output) / 1024).toFixed(1);
console.log(`Built index.html (${kb} KB) with ${data.length} inlined games.`);
