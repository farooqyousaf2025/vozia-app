# Third-party artwork: rank badges, room loops and avatar frames

Retrieved 2026-10-28 from the **Trace** social network / live-streaming template
(`trace_app/assets/`), a Flutter application published under the MIT licence —
see [LICENSE-MIT-trace.txt](LICENSE-MIT-trace.txt), Copyright (c) 2023 Matula José
Alberto. Only the image and Lottie files listed below were taken. **None of that
package's source code was read into, translated or linked**, and no Dart file,
string or icon from it is part of this repository.

## What was taken

### Avatar frames — 10 files, 144 KB total

Added with migration 0019 and the cosmetic store, shipped unchanged as
[`backend/public/frames/trace/frame-<n>.png`](../../backend/public/frames/trace).
Verified on the downloaded files: byte-identical to upstream (sha256), 8-bit
**truecolour RGBA** PNG (colour type 6) with a real alpha channel — not the
palette-plus-`tRNS` form the badge seals use — and roughly 185x200 px. The middle
is transparent, which is the only property that makes a picture usable as a ring:
the client draws the avatar first and this over it.

| Repository file | Upstream file | Shop key | Seeded price |
| --- | --- | --- | --- |
| `frame-1.png` | `images/ic_vip_frame_1.png` | `ring-bronze` | 300 |
| `frame-2.png` | `images/ic_vip_frame_2.png` | `ring-silver` | 600 |
| `frame-3.png` | `images/ic_vip_frame_3.png` | `ring-jade` | 1,200 |
| `frame-4.png` | `images/ic_vip_frame_4.png` | `ring-ocean` | 2,000 |
| `frame-5.png` | `images/ic_vip_frame_5.png` | `ring-amber` | 3,000 |
| `frame-6.png` | `images/ic_vip_frame_6.png` | `ring-rose` | 4,500 |
| `frame-7.png` | `images/ic_vip_frame_7.png` | `ring-sky` | 6,000 |
| `frame-8.png` | `images/ic_vip_frame_8.png` | `ring-violet` | 8,000 |
| `frame-9.png` | `images/ic_vip_frame_9.png` | `ring-crown` | 12,000 |
| `frame-10.png` | `images/ic_vip_frame_10.png` | `ring-immortal` | 20,000 |

Upstream calls these `ic_vip_frame_*` because in Trace they mark a VIP tier. Here
they carry no tier at all: the rungs on the ladder stay what migration 0017 made
them, and a ring is bought. The names in the seed describe the metal and gem in
the picture rather than a status, so nothing implies that a member reached a level
they did not earn. Prices and the 30-day period are the opening position an
operator edits from the panel.

`images/bg_contribution_frame_1..3.png` were looked at and refused for a reason
worth writing down, because the art is good: they are proper circular rings, but
each carries a **baked-in numeral** — a gold medallion reading 1, 2 or 3 at the
bottom. That makes them leaderboard markers, and a member who bought one would
wear a placing they did not finish in. The same three appear as
`bg_contribution_seat_frame_*` for the seat grid.

`images/ic_frame_top1..3.png` are clean crown rings with no numeral and would fit,
but they are thinner and plainer than the ten above and would sit in the shop as
three more rungs nobody asked for. `assets/icons/ic_big_frame_ward_level_1..3.webp`
were not converted or imported: the ten already cover the ladder, and adding a
format this app's image loading has not been exercised against is a risk with no
artistic payoff.

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
  (144 files) — VIP covers, privilege icons, tab art and flags. They belong to
  screens this app either does not have or draws with Material icons and
  Compose-drawn chrome; importing them would add weight with nothing to render
  them. The avatar rings were the exception, and they are the section above.

## Attribution as MIT requires

The upstream copyright notice and permission notice are reproduced in full in
[LICENSE-MIT-trace.txt](LICENSE-MIT-trace.txt) and summarised in
[`NOTICE.md`](../../NOTICE.md). "Trace" is the upstream project's name; nothing
in this repository is affiliated with or endorsed by its author.
