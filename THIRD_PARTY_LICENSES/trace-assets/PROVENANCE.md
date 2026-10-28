# Third-party artwork: rank badges and room loops

Retrieved 2026-10-28 from the **Trace** social network / live-streaming template
(`trace_app/assets/`), a Flutter application published under the MIT licence —
see [LICENSE-MIT-trace.txt](LICENSE-MIT-trace.txt), Copyright (c) 2023 Matula José
Alberto. Only the image and Lottie files listed below were taken. **None of that
package's source code was read into, translated or linked**, and no Dart file,
string or icon from it is part of this repository.

## What was taken

### Rank badge art — 21 files, 175 KB total

Shipped unchanged as
[`backend/public/badges/trace/level-<n>.png`](../../backend/public/badges/trace).
Verified on the downloaded files: every one is byte-identical to its upstream
counterpart (sha256), 326x295, 8-bit palette PNG (colour type 3) with a `tRNS`
chunk, so the corners are transparent and a phone can draw the seal over any
theme.

| Repository file | Upstream file | Ladder rung |
| --- | --- | --- |
| `level-0.png` | `images/grade_big_1.png` | 0 Newcomer (sprout) |
| `level-1.png` | `images/grade_big_2.png` | 1 Bronze I |
| `level-2.png` | `images/grade_big_3.png` | 2 Bronze II |
| `level-3.png` | `images/grade_big_4.png` | 3 Bronze III |
| `level-4.png` | `images/grade_big_5.png` | 4 Silver I |
| `level-5.png` | `images/grade_big_6.png` | 5 Silver II |
| `level-6.png` | `images/grade_big_7.png` | 6 Silver III |
| `level-7.png` | `images/grade_big_8.png` | 7 Gold I |
| `level-8.png` | `images/grade_big_9.png` | 8 Gold II |
| `level-9.png` | `images/grade_big_10.png` | 9 Gold III |
| `level-10.png` | `images/grade_big_11.png` | 10 Platinum I |
| `level-11.png` | `images/grade_big_12.png` | 11 Platinum II |
| `level-12.png` | `images/grade_big_13.png` | 12 Platinum III |
| `level-13.png` | `images/grade_big_14.png` | 13 Diamond I |
| `level-14.png` | `images/grade_big_15.png` | 14 Diamond II |
| `level-15.png` | `images/grade_big_16.png` | 15 Diamond III |
| `level-16.png` | `images/grade_big_17.png` | 16 Crown I |
| `level-17.png` | `images/grade_big_18.png` | 17 Crown II |
| `level-18.png` | `images/grade_big_19.png` | 18 Crown III |
| `level-19.png` | `images/grade_big_22.png` | 19 Legend (gold trophy) |
| `level-20.png` | `images/grade_big_25.png` | 20 Immortal (violet trophy) |

Upstream `grade_big_20`, `_21`, `_23` and `_24` were **not** taken: 20 and 21 are
the same banner-and-star seal in two shades, and 23 and 24 are the same trophy as
22 and 25 in orange and red. Four near-duplicates would have made the top of the
ladder hard to read at 24 dp, which is the one job a badge has.

The ladder's names (`Bronze`, `Gold`, `Crown`, …) came with migration 0017 and
describe the tier, not the picture. An operator can re-point any rung at any
image from the panel's rank editor; migration 0018 only replaces a badge that
still holds the generated placeholder, so an uploaded custom seal is never
overwritten.

### Room loops — 2 files, 124 KB total

Shipped unchanged as
[`backend/public/effects/`](../../backend/public/effects):

| Repository file | Upstream file | What it is |
| --- | --- | --- |
| `room-spectrum.json` | `lotties/61928-circular-audio-spectrum.json` | 1024x1024, 24 fps, 5 s, 33 layers |
| `room-voice.json` | `lotties/ic_message_mic.json` | 512x512, 60 fps, 3 s, 6 layers |

Both are vector-only Lottie: every asset is shape data, `imgAssets` is 0 and
nothing is embedded as base64, so `lottie-compose` on the phone and `lottie-web`
in the admin panel render them from the JSON alone with no second fetch. Both
were rendered live before shipping and both are registered as `AMBIENT` rows in
`visual_effects`, which means the panel's category picker offers them and a host
or operator decides where they play — nothing here forces a loop onto a room.

## What was inspected and rejected

* `lotties/sound_animation.json` — 3.9 MB with **539 embedded base64 bitmaps**.
  That is a download and a decode budget a phone should not spend on decoration.
* `lotties/ic_live_start.json` — renders as a rounded rectangle with a triangle
  inside it: a video-play glyph. This product's rooms are audio parties, and the
  shape promises camera media the app does not carry.
* `lotties/battle_winner.json`, `battle_lost.json`, `no_winner.json` — a "WINNER"
  title card, a teary face and a handshake. Good art, but our game screens have
  no result-animation slot, and adding one is a UI change rather than an asset
  import. Recorded here so the choice is revisited deliberately.
* `images/` (643 files, 32 MB), `icons/`, `countries/` (255 flags), `svg/`
  (144 files) — VIP covers, seat frames, privilege icons, tab art and flags. They
  belong to screens this app either does not have or draws with Material icons
  and Compose-drawn chrome; importing them would add weight with nothing to
  render them. The seat and profile frames are the interesting ones if the
  profile-frames work in task #37 is taken up.

## Attribution as MIT requires

The upstream copyright notice and permission notice are reproduced in full in
[LICENSE-MIT-trace.txt](LICENSE-MIT-trace.txt) and summarised in
[`NOTICE.md`](../../NOTICE.md). "Trace" is the upstream project's name; nothing
in this repository is affiliated with or endorsed by its author.
