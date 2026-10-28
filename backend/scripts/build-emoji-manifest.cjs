#!/usr/bin/env node
/*
 * Writes backend/public/emoji/manifest.json, the list the Android client turns into an emoji
 * picker and into short-code -> image replacement for room chat.
 *
 * The artwork is a third-party set; see THIRD_PARTY_LICENSES/tuilivekit-emoji/PROVENANCE.md.
 * Filenames here are our own keys, so the upstream naming never reaches a user-visible string.
 * Run: node scripts/build-emoji-manifest.cjs [--check]
 */
const fs = require("fs");
const path = require("path");

const EMOJI_DIR = path.join(__dirname, "..", "public", "emoji");

// Index order is the upstream set's order; the key is ours.
const EMOJI = [
  ["smile", "Smile"], ["expect", "Expect"], ["blink", "Blink"], ["guffaw", "Guffaw"],
  ["kind-smile", "Kind smile"], ["haha", "Haha"], ["cheerful", "Cheerful"],
  ["speechless", "Speechless"], ["amazed", "Amazed"], ["sorrow", "Sorrow"],
  ["complacent", "Complacent"], ["silly", "Silly"], ["lustful", "Lustful"],
  ["giggle", "Giggle"], ["kiss", "Kiss"], ["wail", "Wail"], ["tears-laugh", "Tears of joy"],
  ["trapped", "Trapped"], ["mask", "Mask"], ["fear", "Fear"], ["bare-teeth", "Bare teeth"],
  ["flare-up", "Flare up"], ["yawn", "Yawn"], ["tact", "Tact"], ["star-eyes", "Star eyes"],
  ["shut-up", "Shut up"], ["sigh", "Sigh"], ["hehe", "Hehe"], ["silent", "Silent"],
  ["surprised", "Surprised"], ["askance", "Askance"], ["ok", "OK"], ["poop", "Poop"],
  ["monster", "Monster"], ["demon", "Demon"], ["rage", "Rage"], ["fool", "Fool"],
  ["pig", "Pig"], ["cow", "Cow"], ["love-you", "Love you"], ["skull", "Skull"],
  ["bomb", "Bomb"], ["coffee", "Coffee"], ["cake", "Cake"], ["beer", "Beer"],
  ["flower", "Flower"], ["watermelon", "Watermelon"], ["rich", "Rich"], ["heart", "Heart"],
  ["moon", "Moon"], ["sun", "Sun"], ["star", "Star"], ["red-packet", "Red packet"],
  ["celebrate", "Celebrate"], ["bless", "Bless"], ["fortune", "Fortune"],
  ["convinced", "Convinced"], ["prohibit", "Prohibit"], ["666", "666"], ["857", "857"],
  ["knife", "Knife"], ["like", "Like"],
];

const MANIFEST_NAME = "manifest.json";

function build() {
  return {
    generatedBy: "scripts/build-emoji-manifest.cjs",
    // A message body is plain text on the wire; this is the exact shape the client renders.
    codePattern: "\\[[a-z0-9][a-z0-9-]{0,31}\\]",
    emojis: EMOJI.map(([key, label]) => ({
      key,
      label,
      code: `[${key}]`,
      url: `/emoji/${key}.webp`,
    })),
  };
}

function main() {
  const check = process.argv.includes("--check");
  const manifest = build();

  const missing = manifest.emojis.filter(
    (e) => !fs.existsSync(path.join(EMOJI_DIR, `${e.key}.webp`)),
  );
  if (missing.length > 0) {
    console.error(`missing emoji art for: ${missing.map((e) => e.key).join(", ")}`);
    process.exit(1);
  }
  const orphans = fs
    .readdirSync(EMOJI_DIR)
    .filter((f) => f.endsWith(".webp") && !EMOJI.some(([key]) => `${key}.webp` === f));
  if (orphans.length > 0) {
    console.error(`emoji art with no manifest entry: ${orphans.join(", ")}`);
    process.exit(1);
  }

  const out = `${JSON.stringify(manifest, null, 2)}\n`;
  const target = path.join(EMOJI_DIR, MANIFEST_NAME);
  if (check) {
    if (fs.readFileSync(target, "utf8") !== out) {
      console.error(`${MANIFEST_NAME} is stale; run node scripts/build-emoji-manifest.cjs`);
      process.exit(1);
    }
    console.log(`${manifest.emojis.length} emoji, manifest up to date`);
    return;
  }
  fs.writeFileSync(target, out);
  console.log(`wrote ${manifest.emojis.length} emoji to ${path.relative(process.cwd(), target)}`);
}

main();
